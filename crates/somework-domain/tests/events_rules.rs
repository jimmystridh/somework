mod common;

use common::*;
use serde_json::{Value, json};
use somework_core::{ErrorCode, contracts::ActorKind};
use somework_domain::{
    Ctx,
    policy::Permissions,
    publish::PublishEvent,
    rules::{RuleSpec, WhereClause},
};

struct Fixture {
    env: Env,
    producer: Principal,
    automation: Principal,
    reviewer: Principal,
}

fn producer_permissions(globs: &[&str], clearance: &str) -> Permissions {
    Permissions { actions: globs.iter().map(|g| format!("events.publish:{g}")).collect(), classification_max: Some(clearance.into()), ..Default::default() }
}

async fn fixture() -> Fixture {
    let env = Env::new().await;
    let reviewer = env.create_principal(ActorKind::Agent, "agent/reviewer", Some(agent_permissions())).await;
    let automation = env.create_principal(ActorKind::Agent, "automation/pr-review", Some(agent_permissions())).await;
    let producer = env.create_principal(ActorKind::Service, "producer/github", Some(producer_permissions(&["github.*"], "internal"))).await;
    Fixture { env, producer, automation, reviewer }
}

fn event(topic: &str, key: &str, data: Value) -> PublishEvent {
    PublishEvent { topic: Some(topic.into()), key: Some(key.into()), data: Some(data), verified: Some(true), ..Default::default() }
}

fn pr(number: i64, draft: bool) -> Value {
    json!({"number": number, "draft": draft, "repository": "billing/import-service", "sha": "61a8d52"})
}

fn review_rule() -> RuleSpec {
    RuleSpec {
        description: Some("Wake the reviewer for every opened pull request".into()),
        owner: Some("automation/pr-review".into()),
        selector: Some("github.pull_request.opened".into()),
        where_filters: vec![WhereClause { path: "/data/draft".into(), equals: json!(false) }],
        wake: true,
        ..Default::default()
    }
}

async fn github_events(f: &Fixture, who: &Principal) -> Vec<somework_domain::events::EventView> {
    f.env
        .domain
        .list_events(&f.env.ctx(who).await, 0, 500)
        .await
        .unwrap()
        .into_iter()
        .filter(|e| e.kind.starts_with("github.") || e.kind.starts_with("grafana."))
        .collect()
}

async fn put(f: &Fixture, name: &str, spec: RuleSpec) -> somework_domain::rules::RuleView {
    f.env.domain.put_rule(&f.env.admin_ctx().await, name, spec).await.unwrap().0
}

async fn publish(f: &Fixture, e: PublishEvent) -> somework_domain::publish::PublishResponse {
    f.env.domain.publish_event(&f.env.ctx(&f.producer).await, e).await.unwrap()
}

#[tokio::test]
async fn publishing_deduplicates_by_producer_key() {
    let f = fixture().await;
    let first = publish(&f, event("github.pull_request.opened", "delivery-1", pr(1, false))).await;
    assert!(!first.duplicate);
    let again = publish(&f, event("github.pull_request.opened", "delivery-1", pr(1, false))).await;
    assert!(again.duplicate);
    assert_eq!((again.seq, &again.event_id), (first.seq, &first.event_id));
    let other = publish(&f, event("github.pull_request.opened", "delivery-2", pr(2, false))).await;
    assert!(!other.duplicate && other.seq > first.seq);

    let all = f.env.domain.list_all_events(&f.env.admin_ctx().await, 0, 100).await.unwrap();
    let published: Vec<_> = all.iter().filter(|e| e.kind == "github.pull_request.opened").collect();
    assert_eq!(published.len(), 2);
    assert_eq!(published[0].payload["data"]["number"], 1);
    assert_eq!(published[0].payload["publishedBy"], "service:producer/github");
    assert_eq!(published[0].payload["verified"], true);
}

#[tokio::test]
async fn keys_expire_after_the_retention_window() {
    let f = fixture().await;
    let first = publish(&f, event("github.push.main", "k", json!({}))).await;
    f.env.advance(31 * 24 * 3600);
    let later = publish(&f, event("github.push.main", "k", json!({}))).await;
    assert!(!later.duplicate);
    assert!(later.seq > first.seq);
}

#[tokio::test]
async fn publishing_is_limited_to_granted_prefixes_and_clearance() {
    let f = fixture().await;
    let producer = f.env.ctx(&f.producer).await;
    let denied = f.env.domain.publish_event(&producer, event("jira.issue.created", "k", json!({}))).await.unwrap_err();
    assert_eq!(denied.code, ErrorCode::PolicyDenied);

    let mut restricted = event("github.push.main", "k2", json!({}));
    restricted.classification = Some("confidential".into());
    assert_eq!(f.env.domain.publish_event(&producer, restricted).await.unwrap_err().code, ErrorCode::PolicyDenied);

    let agent = f.env.ctx(&f.automation).await;
    assert_eq!(f.env.domain.publish_event(&agent, event("github.push.main", "k3", json!({}))).await.unwrap_err().code, ErrorCode::PolicyDenied);

    let wildcard = f.env.create_principal(ActorKind::Service, "producer/star", Some(Permissions { actions: vec!["*".into()], ..Default::default() })).await;
    assert_eq!(
        f.env.domain.publish_event(&f.env.ctx(&wildcard).await, event("github.push.main", "k4", json!({}))).await.unwrap_err().code,
        ErrorCode::PolicyDenied,
        "the wildcard action does not grant publishing"
    );
    assert!(f.env.domain.publish_event(&f.env.admin_ctx().await, event("jira.issue.created", "k5", json!({}))).await.is_ok(), "admins may publish anywhere");
}

#[tokio::test]
async fn publishing_validates_its_input() {
    let f = fixture().await;
    let ctx = f.env.ctx(&f.producer).await;
    let publish = |e: PublishEvent| {
        let domain = f.env.domain.clone();
        let ctx = ctx.clone();
        async move { domain.publish_event(&ctx, e).await }
    };
    assert_eq!(publish(event("github.opened", "k", json!({}))).await.unwrap_err().code, ErrorCode::ValidationFailed);
    assert_eq!(publish(event("GitHub.pull.opened", "k", json!({}))).await.unwrap_err().code, ErrorCode::ValidationFailed);
    assert_eq!(publish(PublishEvent { topic: Some("github.pull.opened".into()), ..Default::default() }).await.unwrap_err().code, ErrorCode::ValidationFailed);
    assert_eq!(publish(event("github.pull.opened", "k", json!([1]))).await.unwrap_err().code, ErrorCode::ValidationFailed);
    let mut unknown = event("github.pull.opened", "k", json!({}));
    unknown.classification = Some("top-secret".into());
    assert_eq!(publish(unknown).await.unwrap_err().code, ErrorCode::ValidationFailed);
    let big = json!({"blob": "x".repeat(70 * 1024)});
    assert_eq!(publish(event("github.pull.opened", "k", big)).await.unwrap_err().code, ErrorCode::PayloadTooLarge);
}

#[tokio::test]
async fn a_producer_never_receives_its_own_events() {
    let f = fixture().await;
    let sub = |who: &Principal| {
        let domain = f.env.domain.clone();
        let who = who.clone();
        let env = &f.env;
        async move {
            domain
                .create_subscription(
                    &env.ctx(&who).await,
                    somework_domain::subscriptions::CreateSubscription {
                        kind: Some("topic".into()),
                        selector: Some("github.*".into()),
                        wake_on_match: Some(true),
                    },
                )
                .await
                .unwrap()
        }
    };
    let producer_with_read = f
        .env
        .create_principal(
            ActorKind::Service,
            "producer/chatty",
            Some(Permissions { actions: vec!["events.publish:github.*".into(), "message.read".into()], ..Default::default() }),
        )
        .await;
    sub(&producer_with_read).await;
    sub(&f.reviewer).await;
    f.env.domain.publish_event(&f.env.ctx(&producer_with_read).await, event("github.push.main", "k", json!({"n": 1}))).await.unwrap();
    let own = github_events(&f, &producer_with_read).await;
    assert!(own.is_empty(), "the publisher's own subscription must not see its event");
    let other = github_events(&f, &f.reviewer).await;
    assert_eq!(other.len(), 1);
    assert!(other[0].wake);
    assert_eq!(other[0].kind, "github.push.main");
}

#[tokio::test]
async fn agent_subscriptions_wake_the_agent_and_respect_pause() {
    let f = fixture().await;
    let spec = RuleSpec { owner: Some("agent/reviewer".into()), selector: Some("grafana.alert.*".into()), wake: true, ..Default::default() };
    put(&f, "alerts-to-reviewer", spec).await;
    let grafana = f.env.create_principal(ActorKind::Service, "producer/grafana", Some(producer_permissions(&["grafana.*"], "internal"))).await;
    let publish_alert = |key: &'static str| {
        let domain = f.env.domain.clone();
        let env = &f.env;
        let grafana = grafana.clone();
        async move { domain.publish_event(&env.ctx(&grafana).await, event("grafana.alert.firing", key, json!({"rule": "disk"}))).await.unwrap() }
    };
    publish_alert("a1").await;
    let agent = f.env.ctx(&f.reviewer).await;
    let events = github_events(&f, &f.reviewer).await;
    assert_eq!(events.len(), 1);
    assert!(events[0].wake);
    assert_eq!(events[0].payload["data"]["rule"], "disk");

    f.env.domain.set_rule_status(&f.env.admin_ctx().await, "alerts-to-reviewer", "paused").await.unwrap();
    publish_alert("a2").await;
    assert_eq!(github_events(&f, &f.reviewer).await.len(), 1, "a paused rule delivers nothing");
    assert_eq!(f.env.domain.list_subscriptions(&agent).await.unwrap().len(), 1, "the rule shows up as the agent's subscription");
}

#[tokio::test]
async fn managing_rules_needs_the_rules_manage_permission() {
    let f = fixture().await;
    let denied = f.env.domain.put_rule(&f.env.ctx(&f.automation).await, "pr-review", review_rule()).await.unwrap_err();
    assert_eq!(denied.code, ErrorCode::PolicyDenied);
    assert_eq!(f.env.domain.list_rules(&f.env.ctx(&f.automation).await).await.unwrap_err().code, ErrorCode::PolicyDenied);

    let deployer =
        f.env.create_principal(ActorKind::Service, "deployer/rules", Some(Permissions { actions: vec!["rules.manage".into()], ..Default::default() })).await;
    let ctx: Ctx = f.env.ctx(&deployer).await;
    assert!(f.env.domain.put_rule(&ctx, "pr-review", review_rule()).await.unwrap().1);
    assert_eq!(f.env.domain.list_rules(&ctx).await.unwrap().len(), 1);
    f.env.domain.delete_rule(&ctx, "pr-review").await.unwrap();
    assert_eq!(f.env.domain.get_rule(&ctx, "pr-review").await.unwrap_err().code, ErrorCode::NotFound);
}

#[tokio::test]
async fn rules_control_allows_runtime_control_and_reads_but_never_creation_or_deletion() {
    let f = fixture().await;
    put(&f, "pr-review", review_rule()).await;
    let controller =
        f.env.create_principal(ActorKind::Service, "ops/controller", Some(Permissions { actions: vec!["rules.control".into()], ..Default::default() })).await;
    let ctx = f.env.ctx(&controller).await;

    assert_eq!(f.env.domain.list_rules(&ctx).await.unwrap().len(), 1);
    assert_eq!(f.env.domain.get_rule(&ctx, "pr-review").await.unwrap().status, "active");
    assert_eq!(f.env.domain.set_rule_status(&ctx, "pr-review", "paused").await.unwrap().status, "paused");
    assert_eq!(f.env.domain.set_rule_status(&ctx, "pr-review", "active").await.unwrap().status, "active");

    let mut changed = review_rule();
    changed.selector = Some("github.pull_request.closed".into());
    assert_eq!(f.env.domain.put_rule(&ctx, "pr-review", changed).await.unwrap_err().code, ErrorCode::PolicyDenied);
    assert_eq!(f.env.domain.put_rule(&ctx, "new-rule", review_rule()).await.unwrap_err().code, ErrorCode::PolicyDenied);
    assert_eq!(f.env.domain.delete_rule(&ctx, "pr-review").await.unwrap_err().code, ErrorCode::PolicyDenied);
    let admin = f.env.admin_ctx().await;
    assert_eq!(f.env.domain.get_rule(&admin, "pr-review").await.unwrap().selector, "github.pull_request.opened", "nothing was changed by the denied calls");
    assert_eq!(f.env.domain.list_rules(&admin).await.unwrap().len(), 1);
}

#[tokio::test]
async fn rules_control_is_not_implied_by_the_wildcard_or_by_read_only_access() {
    let f = fixture().await;
    put(&f, "pr-review", review_rule()).await;
    let wildcard = f.env.create_principal(ActorKind::Service, "ops/star", Some(Permissions { actions: vec!["*".into()], ..Default::default() })).await;
    let ctx = f.env.ctx(&wildcard).await;
    assert_eq!(f.env.domain.set_rule_status(&ctx, "pr-review", "paused").await.unwrap_err().code, ErrorCode::PolicyDenied);
    assert_eq!(f.env.domain.list_rules(&ctx).await.unwrap_err().code, ErrorCode::PolicyDenied);

    let reader = f.env.create_principal(ActorKind::Service, "ops/reader", Some(Permissions { actions: vec!["ops.read".into()], ..Default::default() })).await;
    let ctx = f.env.ctx(&reader).await;
    assert_eq!(f.env.domain.list_rules(&ctx).await.unwrap().len(), 1);
    assert_eq!(f.env.domain.set_rule_status(&ctx, "pr-review", "paused").await.unwrap_err().code, ErrorCode::PolicyDenied, "reading is not controlling");

    let manager =
        f.env.create_principal(ActorKind::Service, "ops/manager", Some(Permissions { actions: vec!["rules.manage".into()], ..Default::default() })).await;
    assert_eq!(
        f.env.domain.set_rule_status(&f.env.ctx(&manager).await, "pr-review", "paused").await.unwrap().status,
        "paused",
        "rules.manage keeps everything"
    );
}

#[tokio::test]
async fn a_rule_delivers_only_the_events_its_selector_and_filters_match() {
    let f = fixture().await;
    put(&f, "pr-review", review_rule()).await;
    publish(&f, event("github.pull_request.opened", "draft", pr(1, true))).await;
    assert!(github_events(&f, &f.automation).await.is_empty(), "a draft fails the where filter");
    publish(&f, event("github.pull_request.opened", "ready", pr(2, false))).await;
    let delivered = github_events(&f, &f.automation).await;
    assert_eq!(delivered.len(), 1);
    assert!(delivered[0].wake);
    assert_eq!(delivered[0].payload["data"]["number"], 2);
    publish(&f, event("github.pull_request.closed", "closed", pr(2, false))).await;
    assert_eq!(github_events(&f, &f.automation).await.len(), 1, "the selector must match as well");
}

#[tokio::test]
async fn a_rule_without_wake_delivers_the_event_without_waking_its_owner() {
    let f = fixture().await;
    put(&f, "pr-review", RuleSpec { wake: false, ..review_rule() }).await;
    publish(&f, event("github.pull_request.opened", "ready", pr(2, false))).await;
    let delivered = github_events(&f, &f.automation).await;
    assert_eq!(delivered.len(), 1);
    assert!(!delivered[0].wake);
}

#[tokio::test]
async fn paused_rules_deliver_nothing_and_resume_cleanly() {
    let f = fixture().await;
    put(&f, "pr-review", review_rule()).await;
    let admin = f.env.admin_ctx().await;
    assert_eq!(f.env.domain.set_rule_status(&admin, "pr-review", "paused").await.unwrap().status, "paused");
    publish(&f, event("github.pull_request.opened", "k1", pr(1, false))).await;
    assert!(github_events(&f, &f.automation).await.is_empty());
    assert_eq!(f.env.domain.set_rule_status(&admin, "pr-review", "active").await.unwrap().status, "active");
    publish(&f, event("github.pull_request.opened", "k2", pr(2, false))).await;
    assert_eq!(github_events(&f, &f.automation).await.len(), 1);
    assert_eq!(f.env.domain.set_rule_status(&admin, "nope", "paused").await.unwrap_err().code, ErrorCode::NotFound);
}

#[tokio::test]
async fn putting_a_rule_is_idempotent_and_validated() {
    let f = fixture().await;
    let admin = f.env.admin_ctx().await;
    let (first, created) = f.env.domain.put_rule(&admin, "pr-review", review_rule()).await.unwrap();
    assert!(created);
    f.env.advance(60);
    let (second, created) = f.env.domain.put_rule(&admin, "pr-review", review_rule()).await.unwrap();
    assert!(!created);
    assert_eq!((second.updated_at.as_str(), second.subscription_id.as_str()), (first.updated_at.as_str(), first.subscription_id.as_str()));
    assert_eq!(f.env.domain.list_rules(&admin).await.unwrap().len(), 1);

    let mut changed = review_rule();
    changed.selector = Some("github.pull_request.reopened".into());
    let (third, created) = f.env.domain.put_rule(&admin, "pr-review", changed).await.unwrap();
    assert!(!created);
    assert_eq!(third.selector, "github.pull_request.reopened");
    assert_eq!(third.subscription_id, first.subscription_id, "the subscription is updated in place");
    assert_eq!(f.env.domain.list_subscriptions(&f.env.ctx(&f.automation).await).await.unwrap().len(), 1);

    let invalid = |spec: RuleSpec| {
        let domain = f.env.domain.clone();
        let admin = admin.clone();
        async move { domain.put_rule(&admin, "other", spec).await.unwrap_err().code }
    };
    assert_eq!(invalid(RuleSpec { owner: Some("nobody/there".into()), ..review_rule() }).await, ErrorCode::ValidationFailed);
    assert_eq!(invalid(RuleSpec { selector: Some("GitHub".into()), ..review_rule() }).await, ErrorCode::ValidationFailed);
    assert_eq!(invalid(RuleSpec { status: Some("sleeping".into()), ..review_rule() }).await, ErrorCode::ValidationFailed);
    assert_eq!(f.env.domain.put_rule(&admin, "Bad Name", review_rule()).await.unwrap_err().code, ErrorCode::ValidationFailed);
}

#[tokio::test]
async fn a_rule_that_still_carries_a_reaction_is_refused() {
    let f = fixture().await;
    let spec = RuleSpec { reaction: Some(json!({"capability": {"id": "code.review", "version": "2"}, "input": {}})), ..review_rule() };
    let err = f.env.domain.put_rule(&f.env.admin_ctx().await, "pr-review", spec).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::ValidationFailed);
    assert!(err.message.contains("reactions are removed"), "{}", err.message);
    assert!(f.env.domain.list_rules(&f.env.admin_ctx().await).await.unwrap().is_empty());
}

#[tokio::test]
async fn deleting_a_rule_removes_its_subscription() {
    let f = fixture().await;
    let admin = f.env.admin_ctx().await;
    put(&f, "pr-review", review_rule()).await;
    assert_eq!(f.env.domain.list_subscriptions(&f.env.ctx(&f.automation).await).await.unwrap().len(), 1);
    f.env.domain.delete_rule(&admin, "pr-review").await.unwrap();
    assert!(f.env.domain.list_subscriptions(&f.env.ctx(&f.automation).await).await.unwrap().is_empty());
    assert_eq!(f.env.domain.delete_rule(&admin, "pr-review").await.unwrap_err().code, ErrorCode::NotFound);
    publish(&f, event("github.pull_request.opened", "k", pr(1, false))).await;
    assert!(github_events(&f, &f.automation).await.is_empty());
    assert!(f.env.domain.put_rule(&admin, "pr-review", review_rule()).await.unwrap().1, "the same name can be created again");
}

#[tokio::test]
async fn retention_purges_old_published_events_only() {
    let f = fixture().await;
    let old = publish(&f, event("github.pull_request.opened", "old", pr(1, false))).await;
    f.env
        .domain
        .send_message(
            &f.env.ctx(&f.reviewer).await,
            somework_domain::messages::SendMessage {
                recipients: vec![somework_domain::messages::MemberRef { kind: ActorKind::Agent, id: "automation/pr-review".into() }],
                content: Some(somework_core::contracts::MessageContent { media_type: "text/plain".into(), data: json!("hello") }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let admin = f.env.admin_ctx().await;
    let all_events = || async { f.env.domain.list_all_events(&admin, 0, 5000).await.unwrap() };
    let other_events = all_events().await.iter().filter(|e| !e.kind.starts_with("github.")).count();
    assert!(other_events > 0);

    f.env.advance(20 * 24 * 3600);
    let recent = publish(&f, event("github.pull_request.opened", "recent", pr(2, false))).await;
    f.env.advance(11 * 24 * 3600); // `old` is 31 days old, `recent` 11

    f.env.domain.purge_retention().await.unwrap();
    let remaining = all_events().await;
    assert!(!remaining.iter().any(|e| e.event_id == old.event_id), "the old published event is gone");
    assert!(remaining.iter().any(|e| e.event_id == recent.event_id), "the recent one stays");
    assert_eq!(remaining.iter().filter(|e| !e.kind.starts_with("github.")).count(), other_events, "other domain events are not part of this retention");
    assert_eq!(f.env.domain.verify_audit_chain().await.unwrap(), None);
    assert!(!publish(&f, event("github.pull_request.opened", "old", pr(1, false))).await.duplicate);
    assert!(publish(&f, event("github.pull_request.opened", "recent", pr(2, false))).await.duplicate, "keys of kept events still deduplicate");
}

#[tokio::test]
async fn retention_keeps_published_events_whose_delivery_is_still_pending() {
    let env = Env::with_config(|c| c.outbox_sinks = vec!["nats".into()]).await;
    let producer = env.create_principal(ActorKind::Service, "producer/github", Some(producer_permissions(&["github.*"], "internal"))).await;
    let stuck = env.domain.publish_event(&env.ctx(&producer).await, event("github.pull_request.opened", "stuck", pr(1, false))).await.unwrap();
    // the outbox runner never runs: the notification stays pending
    env.advance(40 * 24 * 3600);
    env.domain.purge_retention().await.unwrap();
    assert!(env.domain.list_all_events(&env.admin_ctx().await, 0, 100).await.unwrap().iter().any(|e| e.event_id == stuck.event_id));
}
