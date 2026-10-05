mod common;

use common::*;
use serde_json::{Value, json};
use somework_core::{
    ErrorCode,
    contracts::{ActorKind, SideEffects},
    fsm::TaskState,
};
use somework_domain::{
    Ctx,
    outbox::OutboxItem,
    policy::Permissions,
    publish::PublishEvent,
    rules::{ReactionBudget, ReactionCapability, ReactionOutcome, ReactionSpec, RuleSpec, WhereClause},
    tasks::{ClaimRequest, CompleteRequest, DecideApproval, ProgressRequest, TaskFilter},
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
    let reviewer =
        env.worker("agent/reviewer", vec![capability("code.review", "2.1", "read", "Review pull requests")], worker_permissions(SideEffects::Read)).await;
    let automation = env.create_principal(ActorKind::Agent, "automation/pr-review", Some(caller_permissions(&["code.review"], SideEffects::Read))).await;
    let producer = env.create_principal(ActorKind::Service, "producer/github", Some(producer_permissions(&["github.*"], "internal"))).await;
    Fixture { env, producer, automation, reviewer }
}

fn event(topic: &str, key: &str, data: Value) -> PublishEvent {
    PublishEvent { topic: Some(topic.into()), key: Some(key.into()), data: Some(data), verified: Some(true), ..Default::default() }
}

fn pr(number: i64, draft: bool) -> Value {
    json!({"number": number, "draft": draft, "repository": "billing/import-service", "sha": "61a8d52"})
}

fn review_reaction() -> ReactionSpec {
    ReactionSpec {
        capability: ReactionCapability { id: "code.review".into(), version: "2.1".into() },
        input: json!({"repository": "${/data/repository}", "commit": "${/data/sha}", "note": "PR #${/data/number}", "pullNumber": "${/data/number}"}),
        budget: Some(ReactionBudget { max_tokens: 200_000, max_minutes: 20 }),
        max_depth: None,
        max_firings_per_hour: None,
    }
}

fn review_rule() -> RuleSpec {
    RuleSpec {
        description: Some("Review every opened pull request".into()),
        owner: Some("automation/pr-review".into()),
        selector: Some("github.pull_request.opened".into()),
        where_filters: vec![WhereClause { path: "/data/draft".into(), equals: json!(false) }],
        reaction: Some(review_reaction()),
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

async fn run_reactions(f: &Fixture) -> usize {
    let mut settled = 0;
    loop {
        let report = f.env.domain.reaction_step("test-worker").await.unwrap();
        if report.claimed == 0 {
            return settled;
        }
        settled += report.published;
    }
}

async fn tasks_of(f: &Fixture, who: &Principal) -> Vec<somework_domain::tasks::TaskView> {
    f.env.domain.list_tasks(&f.env.ctx(who).await, TaskFilter::default()).await.unwrap().tasks
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

    let all = f.env.domain.list_all_events(&f.env.admin_ctx().await, None, 0, 100).await.unwrap();
    let published: Vec<_> = all.iter().filter(|e| e.kind == "github.pull_request.opened").collect();
    assert_eq!(published.len(), 2);
    assert_eq!(published[0].payload["data"]["number"], 1);
    assert_eq!(published[0].payload["publishedBy"], "service:producer/github");
    assert_eq!(published[0].payload["depth"], 0);
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
async fn a_reaction_creates_exactly_one_task_however_often_the_event_arrives_or_the_worker_runs() {
    let f = fixture().await;
    put(&f, "pr-review", review_rule()).await;
    let first = publish(&f, event("github.pull_request.opened", "delivery-1", pr(7, false))).await;
    assert!(publish(&f, event("github.pull_request.opened", "delivery-1", pr(7, false))).await.duplicate);
    assert_eq!(run_reactions(&f).await, 1);
    assert_eq!(run_reactions(&f).await, 0, "a second worker pass finds nothing to do");

    let tasks = tasks_of(&f, &f.automation).await;
    assert_eq!(tasks.len(), 1);
    let task = &tasks[0];
    assert_eq!(task.task.state, TaskState::Queued, "read-class work starts without approval");
    assert_eq!(task.task.input["repository"], "billing/import-service");
    assert_eq!(task.task.input["commit"], "61a8d52");
    assert_eq!(task.task.input["note"], "PR #7");
    assert_eq!(task.task.input["pullNumber"], 7, "a whole-value reference keeps its type");
    assert_eq!(task.task.input["budget"], json!({"maxTokens": 200_000, "maxMinutes": 20}));
    assert_eq!(task.origin.as_ref().unwrap()["kind"], "reaction");
    assert_eq!(task.origin.as_ref().unwrap()["rule"], "pr-review");
    assert_eq!(task.origin.as_ref().unwrap()["eventId"], json!(first.event_id));
    assert_eq!(task.task.requester.id, "automation/pr-review");

    // a redelivered outbox row (worker crash after the transaction) settles as a duplicate
    let row = OutboxItem {
        id: 0,
        event_seq: first.seq,
        sink: "reaction".into(),
        subject: "reaction.pr-review".into(),
        dedupe_key: "pr-review:x".into(),
        coalesce_key: None,
        payload: json!({"rule": "pr-review", "eventId": first.event_id, "eventSeq": first.seq, "depth": 0}),
        attempts: 1,
        created_at: String::new(),
    };
    assert!(matches!(f.env.domain.process_reaction(&row).await.unwrap(), ReactionOutcome::Skipped { reason, .. } if reason == "duplicate"));
    assert_eq!(tasks_of(&f, &f.automation).await.len(), 1);

    let rule = f.env.domain.get_rule(&f.env.admin_ctx().await, "pr-review").await.unwrap();
    assert_eq!(rule.counters.fired, 1);
    assert_eq!(rule.counters.skipped.duplicate, 1);
    assert!(rule.last_fired_at.is_some());
    let firings = f.env.domain.list_firings(&f.env.admin_ctx().await, "pr-review", 10).await.unwrap();
    assert_eq!(firings.len(), 1);
    assert_eq!(firings[0].status, "fired");
    assert_eq!(firings[0].task_id.as_deref(), Some(task.task.task_id.as_str()));
    let events = f.env.domain.list_all_events(&f.env.admin_ctx().await, None, 0, 200).await.unwrap();
    assert_eq!(events.iter().filter(|e| e.kind == "reaction.fired").count(), 1);
    assert_eq!(f.env.domain.verify_audit_chain().await.unwrap(), None);
}

#[tokio::test]
async fn where_filters_decide_whether_a_rule_matches() {
    let f = fixture().await;
    put(&f, "pr-review", review_rule()).await;
    publish(&f, event("github.pull_request.opened", "draft", pr(1, true))).await;
    assert_eq!(run_reactions(&f).await, 0);
    assert!(tasks_of(&f, &f.automation).await.is_empty());
    publish(&f, event("github.pull_request.opened", "ready", pr(2, false))).await;
    assert_eq!(run_reactions(&f).await, 1);
    publish(&f, event("github.pull_request.closed", "closed", pr(2, false))).await;
    assert_eq!(run_reactions(&f).await, 0, "the selector must match as well");
    assert_eq!(tasks_of(&f, &f.automation).await.len(), 1);
}

#[tokio::test]
async fn a_missing_template_pointer_skips_the_firing_with_an_error() {
    let f = fixture().await;
    put(&f, "pr-review", review_rule()).await;
    publish(&f, event("github.pull_request.opened", "k", json!({"draft": false, "repository": "r"}))).await;
    run_reactions(&f).await;
    assert!(tasks_of(&f, &f.automation).await.is_empty());
    let rule = f.env.domain.get_rule(&f.env.admin_ctx().await, "pr-review").await.unwrap();
    assert_eq!(rule.counters.skipped.error, 1);
    let firings = f.env.domain.list_firings(&f.env.admin_ctx().await, "pr-review", 10).await.unwrap();
    assert_eq!((firings[0].status.as_str(), firings[0].reason.as_deref()), ("skipped", Some("error")));
    assert!(firings[0].detail.as_deref().unwrap().contains("/data/sha"));
}

#[tokio::test]
async fn a_loop_through_published_events_stops_at_the_depth_limit() {
    let f = fixture().await;
    let mut spec = review_rule();
    spec.reaction.as_mut().unwrap().max_depth = Some(2);
    spec.where_filters.clear();
    put(&f, "pr-review", spec).await;

    publish(&f, event("github.pull_request.opened", "e0", pr(1, false))).await;
    run_reactions(&f).await;
    let t1 = tasks_of(&f, &f.automation).await.pop().unwrap();
    assert_eq!(t1.origin.as_ref().unwrap()["depth"], 0);

    // the review comment produced a webhook that names the task that caused it
    let mut e1 = event("github.pull_request.opened", "e1", pr(1, false));
    e1.caused_by_task = Some(t1.task.task_id.clone());
    publish(&f, e1).await;
    run_reactions(&f).await;
    let tasks = tasks_of(&f, &f.automation).await;
    assert_eq!(tasks.len(), 2);
    let t2 = tasks.iter().find(|t| t.task.task_id != t1.task.task_id).unwrap();
    assert_eq!(t2.origin.as_ref().unwrap()["depth"], 1);

    let mut e2 = event("github.pull_request.opened", "e2", pr(1, false));
    e2.caused_by_task = Some(t2.task.task_id.clone());
    let published = publish(&f, e2).await;
    run_reactions(&f).await;
    assert_eq!(tasks_of(&f, &f.automation).await.len(), 2, "the third hop is cut");
    let stored = f.env.domain.list_all_events(&f.env.admin_ctx().await, None, 0, 500).await.unwrap();
    assert_eq!(stored.iter().find(|e| e.event_id == published.event_id).unwrap().payload["depth"], 2);
    let rule = f.env.domain.get_rule(&f.env.admin_ctx().await, "pr-review").await.unwrap();
    assert_eq!(rule.counters.skipped.depth, 1);
    assert!(stored.iter().any(|e| e.kind == "reaction.skipped" && e.payload["reason"] == "depth"));
}

#[tokio::test]
async fn task_events_carry_the_reaction_depth_so_internal_chains_are_cut_too() {
    let f = fixture().await;
    put(&f, "pr-review", {
        let mut s = review_rule();
        s.where_filters.clear();
        s
    })
    .await;
    // a second rule reacts to finished reviews and starts another review; it allows one hop only
    let follow_up = RuleSpec {
        owner: Some("automation/pr-review".into()),
        selector: Some("task.succeeded".into()),
        reaction: Some(ReactionSpec {
            capability: ReactionCapability { id: "code.review".into(), version: "2.1".into() },
            input: json!({"repository": "${/taskId}"}),
            budget: None,
            max_depth: Some(2),
            max_firings_per_hour: None,
        }),
        ..Default::default()
    };
    put(&f, "follow-up", follow_up).await;

    publish(&f, event("github.pull_request.opened", "e0", pr(1, false))).await;
    run_reactions(&f).await;
    let complete = |task_id: String| {
        let domain = f.env.domain.clone();
        let reviewer = f.reviewer.clone();
        let env = &f.env;
        async move {
            let w = env.ctx(&reviewer).await;
            let claim = domain.claim_task(&w, &task_id, ClaimRequest::default()).await.unwrap();
            domain
                .progress_task(
                    &w,
                    &task_id,
                    ProgressRequest { fencing_token: Some(claim.fencing_token), message: Some("working".into()), ..Default::default() },
                )
                .await
                .unwrap();
            domain
                .complete_task(
                    &w,
                    &task_id,
                    CompleteRequest { fencing_token: Some(claim.fencing_token), result: Some(json!({"verdict": "approve"})), ..Default::default() },
                )
                .await
                .unwrap();
        }
    };
    let first = tasks_of(&f, &f.automation).await.pop().unwrap();
    complete(first.task.task_id.clone()).await;
    run_reactions(&f).await;
    let tasks = tasks_of(&f, &f.automation).await;
    assert_eq!(tasks.len(), 2, "task.succeeded of the first review started a second one");
    let second = tasks.iter().find(|t| t.task.task_id != first.task.task_id).unwrap();
    assert_eq!(second.origin.as_ref().unwrap()["depth"], 1);

    complete(second.task.task_id.clone()).await;
    run_reactions(&f).await;
    assert_eq!(tasks_of(&f, &f.automation).await.len(), 2, "the chain stops at the rule's maxDepth");
    let rule = f.env.domain.get_rule(&f.env.admin_ctx().await, "follow-up").await.unwrap();
    assert_eq!((rule.counters.fired, rule.counters.skipped.depth), (1, 1));
}

#[tokio::test]
async fn the_hourly_rate_limit_caps_firings_and_recovers() {
    let f = fixture().await;
    let mut spec = review_rule();
    spec.reaction.as_mut().unwrap().max_firings_per_hour = Some(2);
    put(&f, "pr-review", spec).await;
    for n in 1..=3 {
        publish(&f, event("github.pull_request.opened", &format!("k{n}"), pr(n, false))).await;
    }
    run_reactions(&f).await;
    assert_eq!(tasks_of(&f, &f.automation).await.len(), 2);
    let rule = f.env.domain.get_rule(&f.env.admin_ctx().await, "pr-review").await.unwrap();
    assert_eq!((rule.counters.fired, rule.counters.skipped.rate), (2, 1));
    f.env.advance(3601);
    publish(&f, event("github.pull_request.opened", "k4", pr(4, false))).await;
    run_reactions(&f).await;
    assert_eq!(tasks_of(&f, &f.automation).await.len(), 3);
}

#[tokio::test]
async fn paused_rules_do_not_fire_and_resume_cleanly() {
    let f = fixture().await;
    put(&f, "pr-review", review_rule()).await;
    let admin = f.env.admin_ctx().await;
    assert_eq!(f.env.domain.set_rule_status(&admin, "pr-review", "paused").await.unwrap().status, "paused");
    publish(&f, event("github.pull_request.opened", "k1", pr(1, false))).await;
    run_reactions(&f).await;
    assert!(tasks_of(&f, &f.automation).await.is_empty());
    assert_eq!(f.env.domain.set_rule_status(&admin, "pr-review", "active").await.unwrap().status, "active");
    publish(&f, event("github.pull_request.opened", "k2", pr(2, false))).await;
    run_reactions(&f).await;
    assert_eq!(tasks_of(&f, &f.automation).await.len(), 1);
    assert_eq!(f.env.domain.set_rule_status(&admin, "nope", "paused").await.unwrap_err().code, ErrorCode::NotFound);
}

#[tokio::test]
async fn write_class_reactions_wait_for_approval_and_a_denial_is_counted() {
    let f = fixture().await;
    f.env.worker("agent/qa", vec![capability("qa.verify", "1", "write", "Verify a ticket")], worker_permissions(SideEffects::Write)).await;
    let qa_automation = f.env.create_principal(ActorKind::Agent, "automation/qa", Some(caller_permissions(&["qa.*"], SideEffects::Write))).await;
    let mut approver_perms = Permissions::default_human();
    approver_perms.approves = vec!["qa.*".into()];
    let approver = f.env.create_principal(ActorKind::Human, "human/alice", Some(approver_perms)).await;
    let spec = RuleSpec {
        owner: Some("automation/qa".into()),
        selector: Some("jira.issue.transitioned".into()),
        reaction: Some(ReactionSpec {
            capability: ReactionCapability { id: "qa.verify".into(), version: "1".into() },
            input: json!({"repository": "${/data/key}"}),
            budget: None,
            max_depth: None,
            max_firings_per_hour: None,
        }),
        ..Default::default()
    };
    put(&f, "qa-on-ticket", spec).await;
    let jira = f.env.create_principal(ActorKind::Service, "producer/jira", Some(producer_permissions(&["jira.*"], "internal"))).await;
    f.env.domain.publish_event(&f.env.ctx(&jira).await, event("jira.issue.transitioned", "j1", json!({"key": "ADM-1"}))).await.unwrap();
    run_reactions(&f).await;

    let tasks = tasks_of(&f, &qa_automation).await;
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].task.state, TaskState::Submitted, "write-class work waits for a person");
    let firing = &f.env.domain.list_firings(&f.env.admin_ctx().await, "qa-on-ticket", 10).await.unwrap()[0];
    let approval_id = firing.approval_id.clone().expect("the firing records the approval");
    let approval = f.env.domain.get_approval(&f.env.ctx(&approver).await, &approval_id).await.unwrap();
    f.env
        .domain
        .decide_approval(
            &f.env.ctx(&approver).await,
            &approval_id,
            DecideApproval { decision: "denied".into(), action_digest: approval.action_digest, task_revision: 1, comment: Some("not now".into()) },
        )
        .await
        .unwrap();
    let rule = f.env.domain.get_rule(&f.env.admin_ctx().await, "qa-on-ticket").await.unwrap();
    assert_eq!((rule.counters.fired, rule.counters.skipped.approval), (1, 1));
    let events = f.env.domain.list_all_events(&f.env.admin_ctx().await, None, 0, 500).await.unwrap();
    assert!(events.iter().any(|e| e.kind == "reaction.skipped" && e.payload["reason"] == "approval"));
}

#[tokio::test]
async fn a_denied_submission_is_skipped_and_recorded() {
    let f = fixture().await;
    put(&f, "pr-review", review_rule()).await;
    // the owner loses its right to invoke the capability after the rule was stored
    let admin = f.env.admin_ctx().await;
    f.env
        .domain
        .update_principal(
            &admin,
            ActorKind::Agent,
            "automation/pr-review",
            Some(Permissions { discover: vec!["code.review".into()], ..caller_permissions(&["something.else"], SideEffects::Read) }),
            None,
            None,
        )
        .await
        .unwrap();
    publish(&f, event("github.pull_request.opened", "k", pr(1, false))).await;
    run_reactions(&f).await;
    assert!(tasks_of(&f, &f.automation).await.is_empty());
    let rule = f.env.domain.get_rule(&admin, "pr-review").await.unwrap();
    assert_eq!(rule.counters.skipped.denied, 1);
    let events = f.env.domain.list_all_events(&admin, None, 0, 500).await.unwrap();
    assert!(events.iter().any(|e| e.kind == "policy.denied"), "the denial is recorded like any other");

    f.env.domain.update_principal(&admin, ActorKind::Agent, "automation/pr-review", None, Some("disabled".into()), None).await.unwrap();
    publish(&f, event("github.pull_request.opened", "k2", pr(2, false))).await;
    run_reactions(&f).await;
    let rule = f.env.domain.get_rule(&admin, "pr-review").await.unwrap();
    assert_eq!(rule.counters.skipped.denied, 2, "a disabled owner cannot start tasks");
}

#[tokio::test]
async fn reaction_events_never_trigger_reactions() {
    let f = fixture().await;
    put(&f, "pr-review", review_rule()).await;
    let watcher = RuleSpec {
        owner: Some("automation/pr-review".into()),
        selector: Some("reaction.*".into()),
        reaction: Some(ReactionSpec {
            capability: ReactionCapability { id: "code.review".into(), version: "2.1".into() },
            input: json!({"repository": "${/rule}"}),
            budget: None,
            max_depth: None,
            max_firings_per_hour: None,
        }),
        ..Default::default()
    };
    put(&f, "watcher", watcher).await;
    publish(&f, event("github.pull_request.opened", "k", pr(1, false))).await;
    run_reactions(&f).await;
    assert_eq!(tasks_of(&f, &f.automation).await.len(), 1);
    let rule = f.env.domain.get_rule(&f.env.admin_ctx().await, "watcher").await.unwrap();
    assert_eq!(rule.counters.fired, 0);
    assert!(f.env.domain.list_firings(&f.env.admin_ctx().await, "watcher", 10).await.unwrap().is_empty());
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
    assert_eq!(
        invalid(RuleSpec { owner: Some("agent/reviewer".into()), ..review_rule() }).await,
        ErrorCode::ValidationFailed,
        "the owner must be allowed to invoke the capability"
    );
    assert_eq!(invalid(RuleSpec { selector: Some("GitHub".into()), ..review_rule() }).await, ErrorCode::ValidationFailed);
    assert_eq!(invalid(RuleSpec { status: Some("sleeping".into()), ..review_rule() }).await, ErrorCode::ValidationFailed);
    assert_eq!(f.env.domain.put_rule(&admin, "Bad Name", review_rule()).await.unwrap_err().code, ErrorCode::ValidationFailed);
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
async fn deleting_a_rule_removes_its_subscription() {
    let f = fixture().await;
    let admin = f.env.admin_ctx().await;
    put(&f, "pr-review", review_rule()).await;
    assert_eq!(f.env.domain.list_subscriptions(&f.env.ctx(&f.automation).await).await.unwrap().len(), 1);
    f.env.domain.delete_rule(&admin, "pr-review").await.unwrap();
    assert!(f.env.domain.list_subscriptions(&f.env.ctx(&f.automation).await).await.unwrap().is_empty());
    assert_eq!(f.env.domain.delete_rule(&admin, "pr-review").await.unwrap_err().code, ErrorCode::NotFound);
    publish(&f, event("github.pull_request.opened", "k", pr(1, false))).await;
    assert_eq!(run_reactions(&f).await, 0);
    assert!(tasks_of(&f, &f.automation).await.is_empty());
    // the same name can be created again
    assert!(f.env.domain.put_rule(&admin, "pr-review", review_rule()).await.unwrap().1);
}

#[tokio::test]
async fn a_rule_deleted_between_matching_and_settling_is_skipped_not_lost() {
    let f = fixture().await;
    let admin = f.env.admin_ctx().await;
    put(&f, "pr-review", review_rule()).await;
    publish(&f, event("github.pull_request.opened", "k", pr(1, false))).await;
    f.env.domain.delete_rule(&admin, "pr-review").await.unwrap();
    run_reactions(&f).await;
    assert!(tasks_of(&f, &f.automation).await.is_empty());
    let firings = f.env.domain.list_firings(&admin, "pr-review", 10).await.unwrap();
    assert_eq!((firings[0].status.as_str(), firings[0].reason.as_deref()), ("skipped", Some("error")));
}

async fn triager(f: &Fixture) -> Principal {
    let agent = f.env.create_principal(ActorKind::Agent, "agent/triager", Some(caller_permissions(&["code.review"], SideEffects::Read))).await;
    let wake = RuleSpec { owner: Some("agent/triager".into()), selector: Some("grafana.alert.*".into()), wake: true, ..Default::default() };
    put(f, "alerts-to-triager", wake).await;
    agent
}

async fn grafana(f: &Fixture) -> Principal {
    f.env.create_principal(ActorKind::Service, "producer/grafana", Some(producer_permissions(&["grafana.*"], "internal"))).await
}

fn alert(key: &str, caused_by: Option<&str>) -> PublishEvent {
    PublishEvent {
        caused_by_task: caused_by.map(String::from),
        ..event("grafana.alert.firing", key, json!({"rule": "disk", "repository": "billing/import-service", "draft": false, "sha": "61a8d52", "number": 1}))
    }
}

fn review_for(event_id: &str) -> somework_domain::tasks::SubmitTask {
    somework_domain::tasks::SubmitTask { caused_by_event: Some(event_id.into()), ..submit("code.review", "2.1") }
}

#[tokio::test]
async fn caused_by_event_is_verified_never_trusted() {
    let f = fixture().await;
    let agent = triager(&f).await;
    let producer = grafana(&f).await;
    let published = f.env.domain.publish_event(&f.env.ctx(&producer).await, alert("a1", None)).await.unwrap();
    let ctx = f.env.ctx(&agent).await;

    let forged = f.env.domain.submit_task(&ctx, review_for("evt_forged")).await.unwrap_err();
    assert_eq!(forged.code, ErrorCode::ValidationFailed);

    // an event that exists but was addressed to somebody else looks exactly like a forged one
    let foreign = f.env.domain.submit_task(&f.env.ctx(&f.automation).await, review_for(&published.event_id)).await.unwrap_err();
    assert_eq!((foreign.code, foreign.message.clone()), (forged.code, forged.message.clone()));
    // an event whose submitter never received it (even the producer that published it) is rejected the same way
    let extra = f.env.create_principal(ActorKind::Agent, "agent/bystander", Some(caller_permissions(&["code.review"], SideEffects::Read))).await;
    let bystander = f.env.domain.submit_task(&f.env.ctx(&extra).await, review_for(&published.event_id)).await.unwrap_err();
    assert_eq!((bystander.code, bystander.message), (forged.code, forged.message.clone()));
    assert!(tasks_of(&f, &f.automation).await.is_empty());

    let task = f.env.domain.submit_task(&ctx, review_for(&published.event_id)).await.unwrap();
    let origin = task.task.origin.expect("origin is recorded");
    assert_eq!(origin, json!({"kind": "event", "eventId": published.event_id, "depth": 1}));
    assert_eq!(f.env.domain.get_task(&ctx, &task.task.task.task_id).await.unwrap().origin.unwrap()["kind"], "event");
}

#[tokio::test]
async fn agent_submitted_tasks_without_an_event_have_no_origin_and_need_no_approval_override() {
    let f = fixture().await;
    let agent = triager(&f).await;
    let task = f.env.domain.submit_task(&f.env.ctx(&agent).await, submit("code.review", "2.1")).await.unwrap();
    assert!(task.task.origin.is_none());
    assert_eq!(task.task.task.state, TaskState::Queued);
}

#[tokio::test]
async fn depth_grows_across_event_agent_task_published_event_and_reaction_and_the_loop_is_cut() {
    let f = fixture().await;
    let agent = triager(&f).await;
    let producer = grafana(&f).await;
    let mut spec = review_rule();
    spec.selector = Some("grafana.alert.firing".into());
    spec.where_filters.clear();
    spec.reaction.as_mut().unwrap().max_depth = Some(4);
    put(&f, "alert-review", spec).await;
    let publisher = f.env.ctx(&producer).await;
    let agent_ctx = f.env.ctx(&agent).await;

    // depth 0: the alert; it wakes the agent and also fires the reaction (depth 0 -> task origin depth 0)
    let e0 = f.env.domain.publish_event(&publisher, alert("e0", None)).await.unwrap();
    run_reactions(&f).await;
    assert_eq!(tasks_of(&f, &f.automation).await[0].origin.as_ref().unwrap()["depth"], 0);

    // the agent decides to act: event depth 0 -> its task has depth 1
    let delivered =
        f.env.domain.list_events(&agent_ctx, 0, 100).await.unwrap().into_iter().find(|e| e.event_id == e0.event_id).expect("the agent received the alert");
    let t1 = f.env.domain.submit_task(&agent_ctx, review_for(&delivered.event_id)).await.unwrap().task;
    assert_eq!(t1.origin.as_ref().unwrap()["depth"], 1);

    // that task's side effect shows up as a published event: depth 2; the reaction fires with origin depth 2
    let e1 = f.env.domain.publish_event(&publisher, alert("e1", Some(&t1.task.task_id))).await.unwrap();
    let stored = |id: &str| {
        let domain = f.env.domain.clone();
        let admin = f.env.admin_ctx();
        let id = id.to_string();
        async move { domain.list_all_events(&admin.await, None, 0, 1000).await.unwrap().into_iter().find(|e| e.event_id == id).unwrap() }
    };
    assert_eq!(stored(&e1.event_id).await.payload["depth"], 2);
    run_reactions(&f).await;
    let reacted = tasks_of(&f, &f.automation).await;
    assert_eq!(reacted.len(), 2);
    let t2 = reacted.iter().find(|t| t.origin.as_ref().unwrap()["eventId"] == json!(e1.event_id)).unwrap();
    assert_eq!(t2.origin.as_ref().unwrap()["depth"], 2);

    // the reaction's task causes another event: depth 3, still below maxDepth 4
    let e2 = f.env.domain.publish_event(&publisher, alert("e2", Some(&t2.task.task_id))).await.unwrap();
    assert_eq!(stored(&e2.event_id).await.payload["depth"], 3);
    run_reactions(&f).await;
    assert_eq!(tasks_of(&f, &f.automation).await.len(), 3);
    let t3 = tasks_of(&f, &f.automation).await.into_iter().find(|t| t.origin.as_ref().unwrap()["eventId"] == json!(e2.event_id)).unwrap();
    assert_eq!(t3.origin.as_ref().unwrap()["depth"], 3);

    // one more hop reaches maxDepth: the loop is cut
    let e3 = f.env.domain.publish_event(&publisher, alert("e3", Some(&t3.task.task_id))).await.unwrap();
    assert_eq!(stored(&e3.event_id).await.payload["depth"], 4);
    run_reactions(&f).await;
    assert_eq!(tasks_of(&f, &f.automation).await.len(), 3, "no task for the fifth hop");
    let rule = f.env.domain.get_rule(&f.env.admin_ctx().await, "alert-review").await.unwrap();
    assert_eq!((rule.counters.fired, rule.counters.skipped.depth), (3, 1));

    // an event-derived agent task carries its depth into the events of its own lifecycle
    let events = f.env.domain.list_all_events(&f.env.admin_ctx().await, Some(&t1.task.task_id), 0, 100).await.unwrap();
    let lifecycle: Vec<_> = events.iter().filter(|e| e.kind.starts_with("task.")).collect();
    assert!(!lifecycle.is_empty());
    assert!(lifecycle.iter().all(|e| e.payload["originDepth"] == 1), "task events carry the origin depth: {lifecycle:?}");
}

#[tokio::test]
async fn retention_purges_old_published_events_and_settled_firings_only() {
    let f = fixture().await;
    put(&f, "pr-review", review_rule()).await;
    let old = publish(&f, event("github.pull_request.opened", "old", pr(1, false))).await;
    run_reactions(&f).await;
    let task = tasks_of(&f, &f.automation).await.pop().unwrap();
    let admin = f.env.admin_ctx().await;
    let all_events = || async { f.env.domain.list_all_events(&admin, None, 0, 5000).await.unwrap() };
    let task_event_count = all_events().await.iter().filter(|e| e.kind.starts_with("task.")).count();
    assert!(task_event_count > 0);

    f.env.advance(20 * 24 * 3600);
    let recent = publish(&f, event("github.pull_request.opened", "recent", pr(2, false))).await;
    run_reactions(&f).await;
    f.env.advance(11 * 24 * 3600); // `old` is 31 days old, `recent` 11

    f.env.domain.purge_retention().await.unwrap();
    let remaining = all_events().await;
    assert!(!remaining.iter().any(|e| e.event_id == old.event_id), "the old published event is gone");
    assert!(remaining.iter().any(|e| e.event_id == recent.event_id), "the recent one stays");
    assert_eq!(
        remaining.iter().filter(|e| e.kind.starts_with("task.")).count(),
        task_event_count + 1,
        "task events are untouched (one more for the second task)"
    );
    assert!(remaining.iter().any(|e| e.kind == "reaction.fired"), "other domain events are not part of this retention");
    let firings = f.env.domain.list_firings(&admin, "pr-review", 10).await.unwrap();
    assert_eq!(firings.len(), 1);
    assert_eq!(firings[0].event_id, recent.event_id);

    // the task, its history and the audit chain survive; a re-published old key is accepted again
    assert!(f.env.domain.get_task(&f.env.ctx(&f.automation).await, &task.task.task_id).await.is_ok());
    assert!(!f.env.domain.list_task_events(&f.env.ctx(&f.automation).await, &task.task.task_id, 0, 100).await.unwrap().is_empty());
    assert_eq!(f.env.domain.verify_audit_chain().await.unwrap(), None);
    assert!(!publish(&f, event("github.pull_request.opened", "old", pr(1, false))).await.duplicate);
    assert!(publish(&f, event("github.pull_request.opened", "recent", pr(2, false))).await.duplicate, "keys of kept events still deduplicate");
}

#[tokio::test]
async fn retention_keeps_published_events_whose_delivery_is_still_pending_and_unsettled_firings() {
    let f = fixture().await;
    put(&f, "pr-review", review_rule()).await;
    let stuck = publish(&f, event("github.pull_request.opened", "stuck", pr(1, false))).await;
    // never run the reaction worker: the reaction outbox row stays pending
    f.env.advance(40 * 24 * 3600);
    f.env.domain.purge_retention().await.unwrap();
    let admin = f.env.admin_ctx().await;
    assert!(f.env.domain.list_all_events(&admin, None, 0, 100).await.unwrap().iter().any(|e| e.event_id == stuck.event_id));
    assert_eq!(f.env.domain.list_firings(&admin, "pr-review", 10).await.unwrap().len(), 1);
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
    assert!(f.env.domain.list_firings(&ctx, "pr-review", 10).await.unwrap().is_empty());
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
