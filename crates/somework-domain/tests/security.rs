mod common;

use chrono::Duration;
use common::*;
use serde_json::json;
use somework_core::{ErrorCode, contracts::*, jws};
use somework_domain::{
    auth::AuthMeta,
    messages::{MemberRef, SendMessage},
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
async fn denials_are_recorded_audited_and_projected_as_non_waking_events() {
    let env = Env::new().await;
    let _w = env.create_principal(ActorKind::Agent, "agent/w", Some(agent_permissions())).await;
    let weak = env.create_principal(ActorKind::Agent, "agent/weak", Some(somework_domain::policy::Permissions::default())).await;
    let c = env.ctx(&weak).await;
    let err = env
        .domain
        .send_message(
            &c,
            SendMessage {
                recipients: vec![MemberRef { kind: ActorKind::Agent, id: "agent/w".into() }],
                content: Some(MessageContent { media_type: "text/plain".into(), data: json!("hi") }),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::PolicyDenied);
    let denials: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM policy_decisions WHERE decision = 'deny' AND actor = 'agent:agent/weak'")
        .fetch_one(env.domain.db.pool())
        .await
        .unwrap();
    assert_eq!(denials, 1);
    let audit = env.domain.list_audit(&env.admin_ctx().await, 0, 500).await.unwrap();
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
