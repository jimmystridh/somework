mod common;

use chrono::Duration;
use common::*;
use serde_json::json;
use somework_core::{ErrorCode, contracts::*, jws};
use somework_domain::{
    auth::{AuthMeta, DelegateGrant},
    messages::{MemberRef, SendMessage},
    tasks::{ClaimRequest, ProgressRequest},
};

fn meta() -> AuthMeta {
    AuthMeta { transport: "test".into(), peer_cert_sha256: None }
}

#[tokio::test]
async fn assertions_are_audience_bound_short_lived_and_signature_checked() {
    let env = Env::new().await;
    let p = env.create_principal(ActorKind::Agent, "agent/a", None).await;
    let now = env.domain.now();
    let ok = jws::mint_assertion(&p.key, &p.issuer(), &env.domain.service_audience(), None, now, Duration::minutes(5));
    assert!(env.domain.authenticate(&ok, &meta()).await.is_ok());

    let other_audience = jws::mint_assertion(&p.key, &p.issuer(), "somework:operations", None, now, Duration::minutes(5));
    assert_eq!(env.domain.authenticate(&other_audience, &meta()).await.unwrap_err().code, ErrorCode::Unauthenticated);

    let too_long = jws::mint_assertion(&p.key, &p.issuer(), &env.domain.service_audience(), None, now, Duration::hours(24));
    assert_eq!(env.domain.authenticate(&too_long, &meta()).await.unwrap_err().code, ErrorCode::Unauthenticated, "long-lived assertions are refused");

    let forged = jws::mint_assertion(&jws::new_signing_key(), &p.issuer(), &env.domain.service_audience(), None, now, Duration::minutes(5));
    assert_eq!(env.domain.authenticate(&forged, &meta()).await.unwrap_err().code, ErrorCode::Unauthenticated);

    // expiry is enforced against the domain clock
    env.advance(3600);
    assert_eq!(env.domain.authenticate(&ok, &meta()).await.unwrap_err().code, ErrorCode::Unauthenticated);

    // disabling a principal takes effect immediately
    let fresh = jws::mint_assertion(&p.key, &p.issuer(), &env.domain.service_audience(), None, env.domain.now(), Duration::minutes(5));
    assert!(env.domain.authenticate(&fresh, &meta()).await.is_ok());
    env.domain.update_principal(&env.admin_ctx().await, ActorKind::Agent, "agent/a", None, Some("disabled".into()), None).await.unwrap();
    assert_eq!(env.domain.authenticate(&fresh, &meta()).await.unwrap_err().code, ErrorCode::Unauthenticated);
}

#[tokio::test]
async fn single_use_assertions_cannot_be_replayed() {
    let env = Env::new().await;
    let p = env.create_principal(ActorKind::Agent, "agent/a", None).await;
    let mut claims = json!({
        "iss": p.issuer(), "sub": p.issuer(), "aud": [env.domain.service_audience()],
        "iat": env.domain.now().timestamp(), "exp": (env.domain.now() + Duration::minutes(2)).timestamp(), "jti": "once-and-only-once-123456", "once": true
    });
    let token = jws::sign(jws::TYP_ASSERTION, &p.issuer(), &p.key, &claims);
    assert!(env.domain.authenticate(&token, &meta()).await.is_ok());
    assert!(env.domain.authenticate(&token, &meta()).await.unwrap_err().message.contains("replay"));
    claims["jti"] = json!("a-different-jti-xxxxxxxxxx");
    let fresh = jws::sign(jws::TYP_ASSERTION, &p.issuer(), &p.key, &claims);
    assert!(env.domain.authenticate(&fresh, &meta()).await.is_ok());
}

#[tokio::test]
async fn task_grants_narrow_the_workers_authority_and_die_with_the_task() {
    let env = Env::new().await;
    let worker = env
        .worker("agent/w", vec![capability("code.review", "2.1", "read", "Review")], {
            let mut p = worker_permissions(SideEffects::Read);
            p.actions.push("task.delegate".into());
            p
        })
        .await;
    let requester = env.create_principal(ActorKind::Agent, "agent/r", Some(caller_permissions(&["code.review"], SideEffects::Read))).await;
    let task = env.domain.submit_task(&env.ctx(&requester).await, submit("code.review", "2.1")).await.unwrap().task.task.task_id;
    let w = env.ctx(&worker).await;
    let claim = env.domain.claim_task(&w, &task, ClaimRequest::default()).await.unwrap();

    let grant_actor = env.domain.authenticate(&claim.authorization_token, &meta()).await.unwrap();
    assert_eq!(grant_actor.task_scope.as_deref(), Some(task.as_str()));
    assert!(grant_actor.permissions.allows_action("task.update"));
    assert!(!grant_actor.permissions.allows_action("task.submit"), "the task grant does not carry the worker's general rights");
    assert!(!grant_actor.permissions.allows_action("task.claim"));

    // finishing the task revokes the grant
    env.domain.progress_task(&w, &task, ProgressRequest { fencing_token: Some(1), ..Default::default() }).await.unwrap();
    env.domain
        .complete_task(
            &w,
            &task,
            somework_domain::tasks::CompleteRequest { fencing_token: Some(1), result: Some(json!({"verdict": "approve"})), ..Default::default() },
        )
        .await
        .unwrap();
    let err = env.domain.authenticate(&claim.authorization_token, &meta()).await.unwrap_err();
    assert!(err.message.contains("revoked"), "{err:?}");
}

#[tokio::test]
async fn delegated_grants_can_only_narrow_and_decrement_depth() {
    let env = Env::new().await;
    let worker = env
        .worker("agent/w", vec![capability("code.review", "2.1", "read", "Review")], {
            let mut p = worker_permissions(SideEffects::Read);
            p.delegation = somework_domain::policy::DelegationPerm { allowed: true, max_depth: 2 };
            p.actions.push("task.delegate".into());
            p
        })
        .await;
    let helper = env.create_principal(ActorKind::Agent, "agent/helper", None).await;
    let mut caller_perms = caller_permissions(&["code.review"], SideEffects::Read);
    caller_perms.delegation = somework_domain::policy::DelegationPerm { allowed: true, max_depth: 2 };
    let requester = env.create_principal(ActorKind::Agent, "agent/r", Some(caller_perms)).await;
    let task = env.domain.submit_task(&env.ctx(&requester).await, submit("code.review", "2.1")).await.unwrap().task.task.task_id;
    let w = env.ctx(&worker).await;
    let claim = env.domain.claim_task(&w, &task, ClaimRequest::default()).await.unwrap();
    let as_task = somework_domain::Ctx::new(env.domain.authenticate(&claim.authorization_token, &meta()).await.unwrap());

    let widen = env
        .domain
        .delegate_grant(
            &as_task,
            DelegateGrant {
                subject: Some(MemberRef { kind: ActorKind::Agent, id: "agent/helper".into() }),
                actions: vec!["task.submit".into()],
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert_eq!(widen.code, ErrorCode::PolicyDenied, "cannot grant an action the parent grant lacks");
    let child = env
        .domain
        .delegate_grant(
            &as_task,
            DelegateGrant {
                subject: Some(MemberRef { kind: ActorKind::Agent, id: "agent/helper".into() }),
                actions: vec!["task.read".into()],
                ttl_seconds: Some(60),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(child.remaining_depth, claim.authority.delegation_remaining - 1);
    let child_actor = env.domain.authenticate(&child.token, &meta()).await.unwrap();
    assert_eq!(child_actor.id, "agent/helper");
    assert!(child_actor.permissions.allows_action("task.read") && !child_actor.permissions.allows_action("task.update"));
    let _ = helper;
}

#[tokio::test]
async fn denials_are_recorded_audited_and_projected_as_non_waking_events() {
    let env = Env::new().await;
    let _w = env.worker("agent/w", vec![capability("code.review", "2.1", "read", "Review")], worker_permissions(SideEffects::Read)).await;
    let weak = env.create_principal(ActorKind::Agent, "agent/weak", Some(caller_permissions(&["code.review"], SideEffects::None))).await;
    let c = env.ctx(&weak).await;
    let err = env.domain.submit_task(&c, submit("code.review", "2.1")).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::PolicyDenied);
    let denials: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM policy_decisions WHERE decision = 'deny' AND actor = 'agent:agent/weak'")
        .fetch_one(env.domain.db.pool())
        .await
        .unwrap();
    assert_eq!(denials, 1);
    let audit = env.domain.list_audit(&env.admin_ctx().await, None, 0, 500).await.unwrap();
    assert!(audit.iter().any(|a| a.outcome == "denied" && a.authenticated_actor == "agent:agent/weak"));
    let events = env.domain.list_events(&c, 0, 50).await.unwrap();
    let denied = events.iter().find(|e| e.kind == "policy.denied").expect("policy.denied event");
    assert!(!denied.wake);
    assert!(audit.iter().all(|a| a.detail.get("input").is_none()), "no request bodies in audit detail");
}

#[tokio::test]
async fn audit_hash_chain_detects_tampering() {
    let env = Env::new().await;
    env.create_principal(ActorKind::Agent, "agent/a", None).await;
    env.create_principal(ActorKind::Agent, "agent/b", None).await;
    assert_eq!(env.domain.verify_audit_chain().await.unwrap(), None);
    // a privileged DBA bypassing the triggers still cannot do it silently
    sqlx::query("DROP TRIGGER audit_events_no_update").execute(env.domain.db.pool()).await.unwrap();
    sqlx::query("UPDATE audit_events SET outcome = 'tampered' WHERE seq = (SELECT MIN(seq) FROM audit_events)").execute(env.domain.db.pool()).await.unwrap();
    assert!(env.domain.verify_audit_chain().await.unwrap().is_some());
}

#[tokio::test]
async fn human_identities_map_explicitly_and_never_by_display_name() {
    let env = Env::new().await;
    let admin = env.admin_ctx().await;
    env.domain
        .create_principal(
            &admin,
            somework_domain::auth::CreatePrincipal {
                kind: ActorKind::Human,
                id: "human/alice".into(),
                display_name: Some("Alice".into()),
                permissions: None,
                public_key: None,
                matrix_user_id: Some("@alice:example.org".into()),
                oidc_issuer: Some("https://idp.example.org".into()),
                oidc_subject: Some("sub-123".into()),
            },
        )
        .await
        .unwrap();
    let mapped = env.domain.principal_for_matrix_user("@alice:example.org").await.unwrap().unwrap();
    assert_eq!(mapped.id, "human/alice");
    assert!(env.domain.principal_for_matrix_user("@mallory:example.org").await.unwrap().is_none());
    assert!(env.domain.actor_for_oidc("https://idp.example.org", "sub-123").await.is_ok());
    assert_eq!(env.domain.actor_for_oidc("https://idp.example.org", "sub-other").await.unwrap_err().code, ErrorCode::Unauthenticated);
    assert_eq!(env.domain.actor_for_oidc("https://evil.example.org", "sub-123").await.unwrap_err().code, ErrorCode::Unauthenticated);
}

#[tokio::test]
async fn approvals_are_bound_to_digest_revision_expiry_and_a_different_person() {
    let env = Env::new().await;
    let _worker = env
        .worker("agent/deployer", vec![capability("deployment.execute", "1", "irreversible", "Execute")], worker_permissions(SideEffects::Irreversible))
        .await;
    let requester = env.create_principal(ActorKind::Agent, "agent/pm", Some(caller_permissions(&["deployment.*"], SideEffects::Irreversible))).await;
    let mut approver_perms = somework_domain::policy::Permissions::default_human();
    approver_perms.approves = vec!["deployment.*".into()];
    let approver = env.create_principal(ActorKind::Human, "human/alice", Some(approver_perms)).await;
    let outsider = env.create_principal(ActorKind::Human, "human/bob", Some(somework_domain::policy::Permissions::default_human())).await;
    let submitted = env.domain.submit_task(&env.ctx(&requester).await, submit("deployment.execute", "1")).await.unwrap();
    let approval_id = submitted.approval_id.clone().unwrap();
    let approval = env.domain.get_approval(&env.ctx(&approver).await, &approval_id).await.unwrap();
    let decide = |ctx, digest: String, rev: u64| {
        let d = env.domain.clone();
        let id = approval_id.clone();
        async move {
            d.decide_approval(
                &ctx,
                &id,
                somework_domain::tasks::DecideApproval { decision: "approved".into(), action_digest: digest, task_revision: rev, comment: None },
            )
            .await
        }
    };
    // wrong approver, wrong digest, wrong revision
    assert_eq!(decide(env.ctx(&outsider).await, approval.action_digest.clone(), 1).await.unwrap_err().code, ErrorCode::PolicyDenied);
    assert_eq!(decide(env.ctx(&approver).await, "0".repeat(64), 1).await.unwrap_err().code, ErrorCode::StaleRevision);
    assert_eq!(decide(env.ctx(&approver).await, approval.action_digest.clone(), 7).await.unwrap_err().code, ErrorCode::StaleRevision);
    // expiry: after the TTL the approval can no longer be used and maintenance rejects the task
    env.advance(7200);
    assert_eq!(decide(env.ctx(&approver).await, approval.action_digest.clone(), 1).await.unwrap_err().code, ErrorCode::Expired);
    env.domain.run_maintenance().await.unwrap();
    let t = env.domain.get_task(&env.ctx(&requester).await, &submitted.task.task.task_id).await.unwrap();
    assert_eq!(t.task.state, somework_core::fsm::TaskState::Rejected);
    assert_eq!(t.task.failure.unwrap().code, "approval_expired");
}

#[tokio::test]
async fn requesters_cannot_approve_their_own_irreversible_actions() {
    let env = Env::new().await;
    let _w = env
        .worker("agent/deployer", vec![capability("deployment.execute", "1", "irreversible", "Execute")], worker_permissions(SideEffects::Irreversible))
        .await;
    let mut perms = somework_domain::policy::Permissions::default_human();
    perms.approves = vec!["*".into()];
    perms.capabilities = vec!["deployment.*".into()];
    perms.side_effects_at_most = Some(SideEffects::Irreversible);
    let alice = env.create_principal(ActorKind::Human, "human/alice", Some(perms)).await;
    let c = env.ctx(&alice).await;
    let submitted = env.domain.submit_task(&c, submit("deployment.execute", "1")).await.unwrap();
    let approval = env.domain.get_approval(&c, submitted.approval_id.as_deref().unwrap()).await.unwrap();
    let err = env
        .domain
        .decide_approval(
            &c,
            &approval.approval_id,
            somework_domain::tasks::DecideApproval { decision: "approved".into(), action_digest: approval.action_digest, task_revision: 1, comment: None },
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::PolicyDenied);
}

#[tokio::test]
async fn fails_closed_when_the_policy_store_is_unavailable() {
    let env = Env::new().await;
    let p = env.create_principal(ActorKind::Agent, "agent/a", None).await;
    let ctx = env.ctx(&p).await;
    sqlx::query("DROP TRIGGER IF EXISTS policy_decisions_no_update").execute(env.domain.db.pool()).await.unwrap();
    sqlx::query("DELETE FROM policies").execute(env.domain.db.pool()).await.unwrap();
    let err = env
        .domain
        .send_message(
            &ctx,
            SendMessage {
                recipients: vec![MemberRef { kind: ActorKind::Agent, id: "agent/a".into() }],
                content: Some(MessageContent { media_type: "text/plain".into(), data: json!("hi") }),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err.code, ErrorCode::PolicyUnavailable | ErrorCode::ValidationFailed), "{err:?}");
    let search = env.domain.search_catalog(&ctx, Default::default()).await.unwrap_err();
    assert_eq!(search.code, ErrorCode::PolicyUnavailable, "reads also fail closed");
}
