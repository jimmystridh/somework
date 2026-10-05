mod common;

use common::*;
use serde_json::json;
use somework_core::{ErrorCode, contracts::*};
use somework_domain::catalog::{ApproveEntry, RegisterAgent, SearchConstraints, SearchRequest};

async fn env_with_agents() -> (Env, Principal, Principal) {
    let env = Env::new().await;
    let reviewer = env
        .worker(
            "agent/reviewer",
            vec![capability("code.review", "2.1", "read", "Reviews pull requests for correctness and security vulnerabilities")],
            worker_permissions(SideEffects::Read),
        )
        .await;
    let deployer = env
        .worker(
            "agent/deployer",
            vec![
                capability("deployment.inspect", "1", "read", "Inspect production deployments"),
                capability("deployment.execute", "1", "irreversible", "Execute a production deployment"),
            ],
            worker_permissions(SideEffects::Irreversible),
        )
        .await;
    (env, reviewer, deployer)
}

#[tokio::test]
async fn self_registered_cards_start_as_draft_and_are_invisible_until_approved() {
    let env = Env::new().await;
    let p = env.create_principal(ActorKind::Agent, "agent/newbie", Some(worker_permissions(SideEffects::Read))).await;
    let ctx = env.ctx(&p).await;
    let entry = env
        .domain
        .register_agent(&ctx, RegisterAgent { card: card("agent/newbie", vec![capability("code.review", "1", "read", "Reviews code")]), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(entry.approval.status, ApprovalStatus::Draft);

    let seeker = env.create_principal(ActorKind::Agent, "agent/seeker", Some(caller_permissions(&["code.review"], SideEffects::Read))).await;
    let s = env.ctx(&seeker).await;
    let res = env.domain.search_catalog(&s, SearchRequest { query: Some("review code".into()), ..Default::default() }).await.unwrap();
    assert!(res.matches.is_empty(), "drafts never show up in search");
    assert_eq!(env.domain.get_agent(&s, "agent/newbie").await.unwrap_err().code, ErrorCode::NotFound);
    // the owner can still inspect its own draft
    assert_eq!(env.domain.get_agent(&ctx, "agent/newbie").await.unwrap().approval.status, ApprovalStatus::Draft);

    env.domain
        .approve_entry(&env.admin_ctx().await, &entry.entry_id, ApproveEntry { status: Some(ApprovalStatus::Approved), ..Default::default() })
        .await
        .unwrap();
    let res = env.domain.search_catalog(&s, SearchRequest { query: Some("review code".into()), ..Default::default() }).await.unwrap();
    assert_eq!(res.matches[0].agent_id, "agent/newbie");
}

#[tokio::test]
async fn natural_language_and_capability_search_find_the_agent_without_its_id() {
    let (env, _r, _d) = env_with_agents().await;
    let seeker = env.create_principal(ActorKind::Agent, "agent/seeker", Some(caller_permissions(&["code.*", "deployment.*"], SideEffects::Read))).await;
    let s = env.ctx(&seeker).await;
    let nl = env
        .domain
        .search_catalog(&s, SearchRequest { query: Some("Review a pull request for correctness and security".into()), limit: Some(5), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(nl.matches[0].agent_id, "agent/reviewer");
    assert!(nl.matches[0].why.iter().any(|w| w.contains("natural-language")));
    let by_cap = env.domain.search_catalog(&s, SearchRequest { required_capabilities: vec!["code.review".into()], ..Default::default() }).await.unwrap();
    assert_eq!(by_cap.matches.len(), 1);
    assert_eq!(by_cap.matches[0].matched_capabilities[0].version, "2.1");
    let versioned = env.domain.search_catalog(&s, SearchRequest { required_capabilities: vec!["code.review@9.9".into()], ..Default::default() }).await.unwrap();
    assert!(versioned.matches.is_empty());
}

#[tokio::test]
async fn hard_constraints_beat_relevance() {
    let (env, _r, _d) = env_with_agents().await;
    let seeker = env
        .create_principal(
            ActorKind::Agent,
            "agent/seeker",
            Some({
                let mut p = caller_permissions(&["*"], SideEffects::Irreversible);
                p.discover = vec!["*".into()];
                p
            }),
        )
        .await;
    let s = env.ctx(&seeker).await;
    let all = env.domain.search_catalog(&s, SearchRequest { query: Some("deployment".into()), ..Default::default() }).await.unwrap();
    assert_eq!(all.matches[0].matched_capabilities.len(), 2);
    let read_only = env
        .domain
        .search_catalog(
            &s,
            SearchRequest {
                query: Some("deployment".into()),
                constraints: Some(SearchConstraints { side_effects_at_most: Some(SideEffects::Read), ..Default::default() }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(read_only.matches[0].matched_capabilities.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["deployment.inspect"]);
    let none = env
        .domain
        .search_catalog(
            &s,
            SearchRequest {
                required_capabilities: vec!["deployment.execute".into()],
                constraints: Some(SearchConstraints { side_effects_at_most: Some(SideEffects::Write), ..Default::default() }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(none.matches.is_empty());
    let wrong_domain = env
        .domain
        .search_catalog(
            &s,
            SearchRequest {
                query: Some("deployment".into()),
                constraints: Some(SearchConstraints { allowed_domains: Some(vec!["security".into()]), ..Default::default() }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(wrong_domain.matches.is_empty());
}

#[tokio::test]
async fn structured_input_compatibility_filters_results() {
    let (env, _r, _d) = env_with_agents().await;
    let seeker = env.create_principal(ActorKind::Agent, "agent/seeker", Some(caller_permissions(&["code.review"], SideEffects::Read))).await;
    let s = env.ctx(&seeker).await;
    let ok = env
        .domain
        .search_catalog(
            &s,
            SearchRequest {
                required_capabilities: vec!["code.review".into()],
                input: Some(json!({"repository": "billing/import-service"})),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(ok.matches.len(), 1);
    let bad = env
        .domain
        .search_catalog(&s, SearchRequest { required_capabilities: vec!["code.review".into()], input: Some(json!({"commit": "abc"})), ..Default::default() })
        .await
        .unwrap();
    assert!(bad.matches.is_empty(), "input without the required repository property is not compatible");
    let supplies = env
        .domain
        .search_catalog(
            &s,
            SearchRequest {
                required_capabilities: vec!["code.review".into()],
                input_schema: Some(json!({"type": "object", "properties": {"repository": {"type": "string"}}})),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(supplies.matches.len(), 1);
    let lacks = env
        .domain
        .search_catalog(
            &s,
            SearchRequest {
                required_capabilities: vec!["code.review".into()],
                input_schema: Some(json!({"type": "object", "properties": {"other": {"type": "string"}}})),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(lacks.matches.is_empty());
    let wants_output = env
        .domain
        .search_catalog(
            &s,
            SearchRequest {
                required_capabilities: vec!["code.review".into()],
                output_schema: Some(json!({"type": "object", "properties": {"verdict": {"type": "string"}}})),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(wants_output.matches.len(), 1);
}

#[tokio::test]
async fn policy_filtering_happens_before_results_so_hidden_capabilities_are_not_leaked() {
    let (env, _r, _d) = env_with_agents().await;
    // may only see code.review: the deployer's capabilities (and the deployer itself) must be invisible
    let limited = env.create_principal(ActorKind::Agent, "agent/limited", Some(caller_permissions(&["code.review"], SideEffects::Read))).await;
    let l = env.ctx(&limited).await;
    let res = env.domain.search_catalog(&l, SearchRequest { query: Some("production deployment execute".into()), ..Default::default() }).await.unwrap();
    assert!(res.matches.is_empty());
    let probe_hidden =
        env.domain.search_catalog(&l, SearchRequest { required_capabilities: vec!["deployment.execute".into()], ..Default::default() }).await.unwrap();
    let probe_missing =
        env.domain.search_catalog(&l, SearchRequest { required_capabilities: vec!["totally.absent".into()], ..Default::default() }).await.unwrap();
    assert_eq!(
        serde_json::to_value(&probe_hidden.matches).unwrap(),
        serde_json::to_value(&probe_missing.matches).unwrap(),
        "hidden and nonexistent are indistinguishable"
    );
    assert_eq!(env.domain.get_agent(&l, "agent/deployer").await.unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(env.domain.get_capability(&l, "deployment.execute", "1").await.unwrap_err().code, ErrorCode::NotFound);
    assert!(env.domain.get_capability(&l, "code.review", "2.1").await.is_ok());
    // a mixed card is trimmed to the visible capability
    let mixed = env.create_principal(ActorKind::Agent, "agent/mixed", Some(caller_permissions(&["deployment.inspect"], SideEffects::Read))).await;
    let card = env.domain.get_agent(&env.ctx(&mixed).await, "agent/deployer").await.unwrap();
    assert_eq!(card.agent_card.capabilities.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["deployment.inspect"]);
}

#[tokio::test]
async fn capability_contracts_are_immutable_per_version() {
    let (env, reviewer, _d) = env_with_agents().await;
    let ctx = env.ctx(&reviewer).await;
    let mut changed = capability("code.review", "2.1", "read", "Totally different behaviour");
    changed["tags"] = json!(["changed"]);
    let err = env.domain.register_agent(&ctx, RegisterAgent { card: card("agent/reviewer", vec![changed]), ..Default::default() }).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    let bumped = capability("code.review", "2.2", "read", "Reviews code, now faster");
    let entry = env.domain.register_agent(&ctx, RegisterAgent { card: card("agent/reviewer", vec![bumped]), ..Default::default() }).await.unwrap();
    assert_eq!(entry.approval.status, ApprovalStatus::Draft, "material changes need re-approval");
    assert_eq!(entry.agent_card.card_version, Some(2));
}

#[tokio::test]
async fn an_agent_cannot_register_a_card_for_someone_else_or_exceed_its_authority() {
    let env = Env::new().await;
    let p = env.create_principal(ActorKind::Agent, "agent/mallory", Some(worker_permissions(SideEffects::Read))).await;
    let ctx = env.ctx(&p).await;
    let err = env
        .domain
        .register_agent(&ctx, RegisterAgent { card: card("agent/someone-else", vec![capability("code.review", "1", "read", "x")]), ..Default::default() })
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::SenderMismatch);
    let err = env
        .domain
        .register_agent(
            &ctx,
            RegisterAgent { card: card("agent/mallory", vec![capability("deployment.execute", "1", "irreversible", "x")]), ..Default::default() },
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::PolicyDenied, "declaring irreversible effects above the agent's own maximum is refused");
    let mut bad_schema = capability("bad.schema", "1", "read", "x");
    bad_schema["inputSchema"] = json!({"type": "not-a-type"});
    let err = env.domain.register_agent(&ctx, RegisterAgent { card: card("agent/mallory", vec![bad_schema]), ..Default::default() }).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::ValidationFailed);
    let mut malformed = card("agent/mallory", vec![capability("code.review", "1", "read", "x")]);
    malformed["unexpected"] = json!(true);
    assert_eq!(env.domain.register_agent(&ctx, RegisterAgent { card: malformed, ..Default::default() }).await.unwrap_err().code, ErrorCode::SchemaViolation);
}

#[tokio::test]
async fn logical_agents_are_distinct_from_runtime_instances() {
    let env = Env::new().await;
    let w = env.worker("agent/reviewer", vec![capability("code.review", "2.1", "read", "Review")], worker_permissions(SideEffects::Read)).await;
    let seeker = env.create_principal(ActorKind::Agent, "agent/seeker", Some(caller_permissions(&["code.review"], SideEffects::Read))).await;
    let s = env.ctx(&seeker).await;
    let find = || async {
        env.domain.search_catalog(&s, SearchRequest { required_capabilities: vec!["code.review".into()], ..Default::default() }).await.unwrap().matches[0]
            .availability
    };
    assert_eq!(find().await, AvailabilityState::Available);
    // a second process of the same logical agent does not create a second catalog entry
    let second = env.new_runtime(&w).await;
    assert_ne!(second.runtime, w.runtime);
    let res = env.domain.search_catalog(&s, SearchRequest { required_capabilities: vec!["code.review".into()], ..Default::default() }).await.unwrap();
    assert_eq!(res.matches.len(), 1);
    // runtime ids are unique per process (ID-02): reusing one for another agent is refused
    let other = env.worker("agent/other", vec![capability("code.format", "1", "read", "Format")], worker_permissions(SideEffects::Read)).await;
    let mut hijack = other.clone();
    hijack.runtime = w.runtime.clone();
    let refused = env.try_ctx(&hijack).await.unwrap_err();
    assert_eq!(refused.code, ErrorCode::Unauthenticated, "a runtime id bound to another agent cannot be presented");
    // all runtimes gone -> still queueable (durable inbox), never "available"
    env.advance(600);
    assert_eq!(find().await, AvailabilityState::Queueable);
}
