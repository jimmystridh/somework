mod common;

use chrono::Duration;
use common::*;
use serde_json::json;
use somework_core::{ErrorCode, contracts::*, fsm::TaskState, jws};
use somework_domain::{
    auth::AuthMeta,
    messages::{MemberRef, SendMessage},
    tasks::{CancelRequest, ClaimRequest, ProgressRequest, ReconcileRequest, TaskFilter},
};

async fn setup() -> (Env, Principal, Principal) {
    let env = Env::new().await;
    let worker =
        env.worker("agent/reviewer", vec![capability("code.review", "2.1", "read", "Review pull requests")], worker_permissions(SideEffects::Read)).await;
    let caller = env.create_principal(ActorKind::Agent, "agent/author", Some(caller_permissions(&["code.review"], SideEffects::Read))).await;
    (env, worker, caller)
}

#[tokio::test]
async fn signing_key_rotation_keeps_old_grants_verifiable_until_revoked() {
    let (env, worker, caller) = setup().await;
    let task = env.domain.submit_task(&env.ctx(&caller).await, submit("code.review", "2.1")).await.unwrap().task.task.task_id;
    let claim = env.domain.claim_task(&env.ctx(&worker).await, &task, ClaimRequest::default()).await.unwrap();
    let before = jws::parse(&claim.authorization_token).unwrap().kid().unwrap().to_string();
    let new_kid = env.domain.rotate_signing_key().await.unwrap();
    assert_ne!(before, new_kid);
    let meta = AuthMeta { transport: "t".into(), peer_cert_sha256: None };
    assert!(env.domain.authenticate(&claim.authorization_token, &meta).await.is_ok(), "grants signed by a retired key stay valid for their lifetime");
    let second = env.new_runtime(&worker).await;
    let _ = second;
    let ctx = env.admin_ctx().await;
    let task2 = env.domain.submit_task(&env.ctx(&caller).await, submit("code.review", "2.1")).await.unwrap().task.task.task_id;
    let claim2 = env.domain.claim_task(&env.ctx(&worker).await, &task2, ClaimRequest::default()).await.unwrap();
    assert_eq!(jws::parse(&claim2.authorization_token).unwrap().kid().unwrap(), new_kid);
    let _ = ctx;
}

#[tokio::test]
async fn policy_versions_are_recorded_with_every_decision() {
    let (env, _worker, caller) = setup().await;
    let admin = env.admin_ctx().await;
    let mut p = env.domain.get_policy(&admin).await.unwrap();
    p.version = "2026-10-03.2".into();
    p.deny_rules.push(somework_domain::policy::DenyRule {
        id: "freeze".into(),
        actions: vec!["task.submit".into()],
        reason: "change freeze".into(),
        ..Default::default()
    });
    env.domain.put_policy(&admin, p).await.unwrap();
    let err = env.domain.submit_task(&env.ctx(&caller).await, submit("code.review", "2.1")).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::PolicyDenied);
    assert!(err.message.contains("change freeze"));
    let version: String = sqlx::query_scalar("SELECT policy_version FROM policy_decisions WHERE decision = 'deny' ORDER BY occurred_at DESC LIMIT 1")
        .fetch_one(env.domain.db.pool())
        .await
        .unwrap();
    assert_eq!(version, "2026-10-03.2");
    // a non-admin cannot read or change the policy
    assert!(env.domain.get_policy(&env.ctx(&caller).await).await.is_err());
    assert!(env.domain.put_policy(&env.ctx(&caller).await, Default::default()).await.is_err());
    let dup =
        env.domain.put_policy(&admin, somework_domain::policy::PolicyDocument { version: "2026-10-03.2".into(), ..Default::default() }).await.unwrap_err();
    assert_eq!(dup.code, ErrorCode::Conflict);
}

#[tokio::test]
async fn reconciliation_can_retry_or_cancel() {
    let env = Env::new().await;
    let worker = env
        .worker("agent/deployer", vec![capability("deployment.execute", "1", "irreversible", "Execute")], worker_permissions(SideEffects::Irreversible))
        .await;
    let caller = env.create_principal(ActorKind::Agent, "agent/pm", Some(caller_permissions(&["deployment.*"], SideEffects::Irreversible))).await;
    let admin = env.admin_ctx().await;
    let mut policy = env.domain.get_policy(&admin).await.unwrap();
    policy.version = "no-approval".into();
    policy.approvals.require_side_effects_at_least = None;
    env.domain.put_policy(&admin, policy).await.unwrap();
    let c = env.ctx(&caller).await;
    let park = |label: &'static str| {
        let env = &env;
        let worker = &worker;
        let c = c.clone();
        async move {
            let id = env.domain.submit_task(&c, submit("deployment.execute", "1")).await.unwrap().task.task.task_id;
            let w = env.ctx(worker).await;
            env.domain.claim_task(&w, &id, ClaimRequest { lease_seconds: Some(5), ..Default::default() }).await.unwrap();
            env.advance(60);
            env.domain.run_maintenance().await.unwrap();
            let _ = label;
            id
        }
    };
    let retry = park("retry").await;
    let t = env
        .domain
        .reconcile_task(
            &admin,
            &retry,
            ReconcileRequest { resolution: "retry".into(), note: Some("verified the action did not run".into()), ..Default::default() },
        )
        .await
        .unwrap();
    assert_eq!((t.task.state, t.task.attempt), (TaskState::Queued, 2));
    let cancel = park("cancel").await;
    // a requester cannot cancel a parked task; an operator can
    assert_eq!(env.domain.cancel_task(&c, &cancel, CancelRequest::default()).await.unwrap_err().code, ErrorCode::InvalidTransition);
    let t = env.domain.cancel_task(&admin, &cancel, CancelRequest::default()).await.unwrap();
    assert_eq!(t.task.state, TaskState::Canceled);
    // only operators can reconcile at all
    let third = park("denied").await;
    let err = env.domain.reconcile_task(&c, &third, ReconcileRequest { resolution: "retry".into(), ..Default::default() }).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::PolicyDenied);
}

#[tokio::test]
async fn deadline_overrun_requests_cancellation_of_running_work() {
    let (env, worker, caller) = setup().await;
    let c = env.ctx(&caller).await;
    let mut req = submit("code.review", "2.1");
    req.deadline_at = Some(somework_core::clock::ts(env.domain.now() + Duration::seconds(30)));
    let id = env.domain.submit_task(&c, req).await.unwrap().task.task.task_id;
    let w = env.ctx(&worker).await;
    env.domain.claim_task(&w, &id, ClaimRequest { lease_seconds: Some(600), ..Default::default() }).await.unwrap();
    env.domain.progress_task(&w, &id, ProgressRequest { fencing_token: Some(1), ..Default::default() }).await.unwrap();
    env.advance(60);
    assert_eq!(env.domain.run_maintenance().await.unwrap().deadlines_cancel_requested, 1);
    assert_eq!(env.domain.get_task(&c, &id).await.unwrap().task.state, TaskState::CancelRequested);
}

#[tokio::test]
async fn task_listing_filters_paginates_and_respects_visibility() {
    let (env, worker, caller) = setup().await;
    let c = env.ctx(&caller).await;
    let mut ids = vec![];
    for _ in 0..7 {
        ids.push(env.domain.submit_task(&c, submit("code.review", "2.1")).await.unwrap().task.task.task_id);
        env.advance(1);
    }
    env.domain.cancel_task(&c, &ids[0], Default::default()).await.unwrap();
    let page1 = env.domain.list_tasks(&c, TaskFilter { limit: Some(3), ..Default::default() }).await.unwrap();
    assert_eq!(page1.tasks.len(), 3);
    assert_eq!(page1.tasks[0].task.task_id, ids[6], "newest first");
    let page2 = env.domain.list_tasks(&c, TaskFilter { limit: Some(3), cursor: page1.next_cursor.clone(), ..Default::default() }).await.unwrap();
    assert!(page2.tasks.iter().all(|t| !page1.tasks.iter().any(|p| p.task.task_id == t.task.task_id)));
    let canceled = env.domain.list_tasks(&c, TaskFilter { state: Some("canceled".into()), ..Default::default() }).await.unwrap();
    assert_eq!(canceled.tasks.len(), 1);
    // an unrelated agent sees nothing; the worker sees queued tasks only once assigned
    let other = env.create_principal(ActorKind::Agent, "agent/other", None).await;
    assert!(env.domain.list_tasks(&env.ctx(&other).await, Default::default()).await.unwrap().tasks.is_empty());
    assert_eq!(env.domain.get_task(&env.ctx(&other).await, &ids[1]).await.unwrap_err().code, ErrorCode::NotFound);
    env.domain.claim_task(&env.ctx(&worker).await, &ids[1], ClaimRequest::default()).await.unwrap();
    assert_eq!(
        env.domain
            .list_tasks(&env.ctx(&worker).await, TaskFilter { assignee_id: Some("agent/reviewer".into()), ..Default::default() })
            .await
            .unwrap()
            .tasks
            .len(),
        1
    );
    // operators see everything
    let all = env.domain.list_tasks(&env.admin_ctx().await, TaskFilter { all: Some(true), limit: Some(50), ..Default::default() }).await.unwrap();
    assert_eq!(all.tasks.len(), 7);
}

#[tokio::test]
async fn event_cursor_resumes_after_ack() {
    let (env, _worker, caller) = setup().await;
    let c = env.ctx(&caller).await;
    let ids: Vec<_> = futures_util_join(&env, &c, 3).await;
    let events = env.domain.list_events(&c, 0, 100).await.unwrap();
    assert!(!events.is_empty());
    let mid = events[events.len() / 2].seq;
    env.domain.ack_events(&c, mid).await.unwrap();
    assert_eq!(env.domain.event_cursor(&c).await.unwrap(), mid);
    let rest = env.domain.list_events(&c, mid, 100).await.unwrap();
    assert!(rest.iter().all(|e| e.seq > mid));
    assert!(rest.len() < events.len());
    let _ = ids;
    // long-poll returns promptly when nothing new arrives within the wait
    let started = std::time::Instant::now();
    let none = env.domain.watch_events(&c, events.last().unwrap().seq, 10, std::time::Duration::from_millis(300)).await.unwrap();
    assert!(none.is_empty() && started.elapsed() >= std::time::Duration::from_millis(250));
}

async fn futures_util_join(env: &Env, c: &somework_domain::Ctx, n: usize) -> Vec<String> {
    let mut out = vec![];
    for _ in 0..n {
        out.push(env.domain.submit_task(c, submit("code.review", "2.1")).await.unwrap().task.task.task_id);
    }
    out
}

#[tokio::test]
async fn message_read_receipts_and_retention() {
    let env = Env::new().await;
    let a = env.create_principal(ActorKind::Agent, "agent/a", None).await;
    let b = env.create_principal(ActorKind::Agent, "agent/b", None).await;
    let (ca, cb) = (env.ctx(&a).await, env.ctx(&b).await);
    let m = env
        .domain
        .send_message(
            &ca,
            SendMessage {
                recipients: vec![MemberRef { kind: ActorKind::Agent, id: "agent/b".into() }],
                content: Some(MessageContent { media_type: "text/plain".into(), data: json!("hi") }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(env.domain.inbox(&cb, true, 10).await.unwrap().len(), 1);
    assert_eq!(env.domain.mark_messages_read(&cb, std::slice::from_ref(&m.envelope.message_id)).await.unwrap(), 1);
    assert!(env.domain.inbox(&cb, true, 10).await.unwrap().is_empty());
    assert_eq!(env.domain.inbox(&cb, false, 10).await.unwrap().len(), 1);
    // retention: messages past the window are purged, young audit records are not
    env.advance(91 * 24 * 3600);
    let purged = env.domain.purge_retention().await.unwrap();
    assert!(purged >= 1);
    assert!(env.domain.inbox(&cb, false, 10).await.unwrap().is_empty());
    assert!(env.domain.verify_audit_chain().await.is_ok());
}

#[tokio::test]
async fn expired_idempotency_records_are_purged() {
    let (env, _w, caller) = setup().await;
    let c = env.ctx(&caller).await.with_idempotency("k");
    env.domain.submit_task(&c, submit("code.review", "2.1")).await.unwrap();
    env.advance(48 * 3600);
    assert_eq!(env.domain.purge_expired_idempotency().await.unwrap(), 1);
}

#[tokio::test]
async fn runtime_lifecycle_and_presence() {
    let (env, worker, _caller) = setup().await;
    let w = env.ctx(&worker).await;
    let hb = env.domain.runtime_heartbeat(&w).await.unwrap();
    assert_eq!(hb.status, "active");
    env.domain.end_runtime(&w).await.unwrap();
    assert!(env.try_ctx(&worker).await.is_err(), "an ended runtime id can never be presented again");
    let fresh = env.new_runtime(&worker).await;
    assert!(env.domain.runtime_heartbeat(&env.ctx(&fresh).await).await.is_ok());
    let seen = env.domain.list_runtimes(&env.admin_ctx().await, Some("agent/reviewer")).await.unwrap();
    assert_eq!(seen.len(), 2);
}
