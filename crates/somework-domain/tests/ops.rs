mod common;

use common::*;
use serde_json::json;
use somework_core::{ErrorCode, contracts::*};
use somework_domain::messages::{MemberRef, SendMessage};

fn hello(to: &str) -> SendMessage {
    SendMessage {
        recipients: vec![MemberRef { kind: ActorKind::Agent, id: to.into() }],
        content: Some(MessageContent { media_type: "text/plain".into(), data: json!("hi") }),
        ..Default::default()
    }
}

async fn setup() -> (Env, Principal, Principal) {
    let env = Env::new().await;
    let worker = env.worker("agent/reviewer", vec![capability("code.review", "2.1", "read", "Review pull requests")], agent_permissions()).await;
    let caller = env.create_principal(ActorKind::Agent, "agent/author", Some(agent_permissions())).await;
    (env, worker, caller)
}

#[tokio::test]
async fn policy_versions_are_recorded_with_every_decision() {
    let (env, _worker, caller) = setup().await;
    let admin = env.admin_ctx().await;
    let mut p = env.domain.get_policy(&admin).await.unwrap();
    p.version = "2026-10-03.2".into();
    p.deny_rules.push(somework_domain::policy::DenyRule {
        id: "freeze".into(),
        actions: vec!["message.send".into()],
        reason: "change freeze".into(),
        ..Default::default()
    });
    env.domain.put_policy(&admin, p).await.unwrap();
    let err = env.domain.send_message(&env.ctx(&caller).await, hello("agent/reviewer")).await.unwrap_err();
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
async fn event_cursor_resumes_after_ack() {
    let (env, _worker, caller) = setup().await;
    let c = env.ctx(&caller).await;
    for _ in 0..3 {
        env.domain.send_message(&c, hello("agent/reviewer")).await.unwrap();
    }
    let events = env.domain.list_events(&c, 0, 100).await.unwrap();
    assert!(!events.is_empty());
    let mid = events[events.len() / 2].seq;
    env.domain.ack_events(&c, mid).await.unwrap();
    assert_eq!(env.domain.event_cursor(&c).await.unwrap(), mid);
    let rest = env.domain.list_events(&c, mid, 100).await.unwrap();
    assert!(rest.iter().all(|e| e.seq > mid));
    assert!(rest.len() < events.len());
    // long-poll returns promptly when nothing new arrives within the wait
    let started = std::time::Instant::now();
    let none = env.domain.watch_events(&c, events.last().unwrap().seq, 10, std::time::Duration::from_millis(300)).await.unwrap();
    assert!(none.is_empty() && started.elapsed() >= std::time::Duration::from_millis(250));
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
    env.domain.send_message(&c, hello("agent/reviewer")).await.unwrap();
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

#[tokio::test]
async fn system_info_reports_service_state_to_operators_only() {
    let (env, worker, caller) = setup().await;
    for agent in [&worker, &caller] {
        let denied = env.domain.system_info(&env.ctx(agent).await).await.unwrap_err();
        assert_eq!(denied.code, ErrorCode::PolicyDenied, "an ordinary agent may not read the operator view");
    }
    env.domain.update_principal(&env.admin_ctx().await, ActorKind::Agent, "agent/author", None, Some("disabled".into()), None).await.unwrap();
    let info = env.domain.system_info(&env.admin_ctx().await).await.unwrap();
    assert_eq!(info["version"], env!("CARGO_PKG_VERSION"));
    assert!(info["database"]["bytes"].as_i64().unwrap() > 0);
    assert!(info["migrationsApplied"].as_i64().unwrap() > 0);
    assert!(info["uptimeSeconds"].is_u64());
    let principals = info["principals"].as_array().unwrap();
    let author = principals.iter().find(|p| p["id"] == "agent/author").unwrap();
    assert_eq!(author["status"], "disabled");
    let reviewer = principals.iter().find(|p| p["id"] == "agent/reviewer").unwrap();
    assert_eq!(reviewer["status"], "active");
    assert!(!info.to_string().contains("publicKey"), "no key material is reported");
}
