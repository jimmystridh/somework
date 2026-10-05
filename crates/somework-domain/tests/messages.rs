mod common;

use std::collections::BTreeMap;

use common::*;
use serde_json::json;
use somework_core::{ErrorCode, contracts::*};
use somework_domain::messages::{CreateConversation, MemberRef, SendMessage};

fn text(body: &str) -> Option<MessageContent> {
    Some(MessageContent { media_type: "text/plain".into(), data: json!(body) })
}

fn to(id: &str) -> Vec<MemberRef> {
    vec![MemberRef { kind: ActorKind::Agent, id: id.into() }]
}

async fn two_agents() -> (Env, Principal, Principal) {
    let env = Env::new().await;
    let a = env.create_principal(ActorKind::Agent, "agent/a", None).await;
    let b = env.create_principal(ActorKind::Agent, "agent/b", None).await;
    (env, a, b)
}

#[tokio::test]
async fn directed_chat_creates_a_dm_and_wakes_only_the_recipient() {
    let (env, a, b) = two_agents().await;
    let ca = env.ctx(&a).await;
    let sent = env.domain.send_message(&ca, SendMessage { recipients: to("agent/b"), content: text("hello"), ..Default::default() }).await.unwrap();
    assert_eq!(sent.envelope.trigger_mode, TriggerMode::Directed);
    assert_eq!(sent.envelope.sender.id, "agent/a");
    let cb = env.ctx(&b).await;
    let events = env.domain.list_events(&cb, 0, 10).await.unwrap();
    assert!(events.iter().any(|e| e.kind == "message.created" && e.wake));
    let own = env.domain.list_events(&ca, 0, 10).await.unwrap();
    assert!(own.iter().all(|e| !e.wake), "own-origin messages never wake the sender");
    // a second message reuses the same conversation
    let again = env.domain.send_message(&ca, SendMessage { recipients: to("agent/b"), content: text("again"), ..Default::default() }).await.unwrap();
    assert_eq!(again.envelope.conversation_id, sent.envelope.conversation_id);
    let page = env.domain.list_messages(&cb, sent.envelope.conversation_id.as_deref().unwrap(), 0, 10).await.unwrap();
    assert_eq!(page.messages.len(), 2);
}

#[tokio::test]
async fn notices_and_status_messages_can_never_be_made_triggering() {
    let (env, a, b) = two_agents().await;
    let ca = env.ctx(&a).await;
    let notice = env
        .domain
        .send_message(&ca, SendMessage { kind: Some(MessageType::ChatNotice), recipients: to("agent/b"), content: text("working..."), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(notice.envelope.trigger_mode, TriggerMode::Never, "notices default to non-triggering");
    for kind in [MessageType::ChatNotice, MessageType::TaskStatus] {
        let err = env
            .domain
            .send_message(
                &ca,
                SendMessage {
                    kind: Some(kind),
                    recipients: to("agent/b"),
                    content: text("x"),
                    trigger_mode: Some(TriggerMode::Directed),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::TriggerNotAllowed, "{kind:?}");
    }
    // platform-emitted types cannot be forged by clients
    for kind in [MessageType::TaskResult, MessageType::StreamChunk, MessageType::ContextOffer, MessageType::ApprovalDecision] {
        let err = env
            .domain
            .send_message(&ca, SendMessage { kind: Some(kind), recipients: to("agent/b"), content: text("x"), ..Default::default() })
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::ValidationFailed, "{kind:?}");
    }
    let b_events = env.domain.list_events(&env.ctx(&b).await, 0, 50).await.unwrap();
    assert!(b_events.iter().all(|e| !e.wake), "no notice or status traffic wakes the recipient");
}

#[tokio::test]
async fn sender_identity_comes_from_credentials_not_the_body() {
    let (env, a, _b) = two_agents().await;
    let ca = env.ctx(&a).await;
    let forged = ActorRef::new(ActorKind::Agent, "agent/b", "development");
    let err = env
        .domain
        .send_message(&ca, SendMessage { sender: Some(forged), recipients: to("agent/b"), content: text("I am b"), ..Default::default() })
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::SenderMismatch);
    let honest = env
        .domain
        .send_message(
            &ca,
            SendMessage {
                sender: Some(ActorRef::new(ActorKind::Agent, "agent/a", "development")),
                recipients: to("agent/b"),
                content: text("ok"),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(honest.envelope.sender.id, "agent/a");
}

#[tokio::test]
async fn duplicate_message_ids_and_idempotency_keys_never_create_duplicates() {
    let (env, a, _b) = two_agents().await;
    let ca = env.ctx(&a).await;
    let req = || SendMessage { message_id: Some("msg_client_1".into()), recipients: to("agent/b"), content: text("once"), ..Default::default() };
    let first = env.domain.send_message(&ca, req()).await.unwrap();
    let again = env.domain.send_message(&ca, req()).await.unwrap();
    assert_eq!(first.seq, again.seq);
    let mut clash = req();
    clash.content = text("different content, same id");
    assert_eq!(env.domain.send_message(&ca, clash).await.unwrap_err().code, ErrorCode::IdempotencyConflict);
    let keyed = env.ctx(&a).await.with_idempotency("k-1");
    let m1 = env.domain.send_message(&keyed, SendMessage { recipients: to("agent/b"), content: text("keyed"), ..Default::default() }).await.unwrap();
    let m2 = env.domain.send_message(&keyed, SendMessage { recipients: to("agent/b"), content: text("keyed"), ..Default::default() }).await.unwrap();
    assert_eq!(m1.envelope.message_id, m2.envelope.message_id);
    let conv = first.envelope.conversation_id.unwrap();
    let all = env.domain.list_messages(&ca, &conv, 0, 50).await.unwrap();
    assert_eq!(all.messages.len(), 2);
}

#[tokio::test]
async fn oversized_inline_content_is_rejected_with_guidance() {
    let (env, a, _b) = two_agents().await;
    let ca = env.ctx(&a).await;
    let big = "x".repeat(40 * 1024);
    let err = env.domain.send_message(&ca, SendMessage { recipients: to("agent/b"), content: text(&big), ..Default::default() }).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::PayloadTooLarge);
    assert!(err.message.contains("artifact"));
}

#[tokio::test]
async fn conversation_membership_and_classification_gate_access() {
    let env = Env::new().await;
    let a = env.create_principal(ActorKind::Agent, "agent/a", None).await;
    let b = env.create_principal(ActorKind::Agent, "agent/b", None).await;
    let mut cleared = somework_domain::policy::Permissions::default_agent();
    cleared.classification_max = Some("restricted".into());
    let c = env.create_principal(ActorKind::Agent, "agent/cleared", Some(cleared.clone())).await;
    let mut a_perms = cleared;
    a_perms.actions.push("message.send".into());
    let ctx_a = env.ctx(&a).await;
    // agent/a is only cleared for internal: it cannot open a restricted conversation
    let err = env
        .domain
        .create_conversation(&ctx_a, CreateConversation { title: Some("incident".into()), classification: Some("restricted".into()), ..Default::default() })
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::PolicyDenied);
    let ctx_c = env.ctx(&c).await;
    let conv = env
        .domain
        .create_conversation(
            &ctx_c,
            CreateConversation {
                title: Some("incident".into()),
                classification: Some("restricted".into()),
                members: to("agent/cleared"),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let denied_member =
        env.domain.add_conversation_member(&ctx_c, &conv.conversation_id, MemberRef { kind: ActorKind::Agent, id: "agent/b".into() }).await.unwrap_err();
    assert_eq!(denied_member.code, ErrorCode::PolicyDenied, "recipient lacks clearance");
    // non-members cannot see it or post to it
    let ctx_b = env.ctx(&b).await;
    assert_eq!(env.domain.get_conversation(&ctx_b, &conv.conversation_id).await.unwrap_err().code, ErrorCode::NotFound);
    let err = env
        .domain
        .send_message(&ctx_b, SendMessage { conversation_id: Some(conv.conversation_id.clone()), content: text("let me in"), ..Default::default() })
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::PolicyDenied);
}

#[tokio::test]
async fn agent_to_agent_loops_are_cut_off_by_the_hop_guard() {
    let env = Env::with_config(|c| c.max_agent_hops = 3).await;
    let a = env.create_principal(ActorKind::Agent, "agent/a", None).await;
    let b = env.create_principal(ActorKind::Agent, "agent/b", None).await;
    let (ca, cb) = (env.ctx(&a).await, env.ctx(&b).await);
    let mut cause: Option<String> = None;
    let mut triggers = vec![];
    for i in 0..8 {
        let (ctx, to_id) = if i % 2 == 0 { (&ca, "agent/b") } else { (&cb, "agent/a") };
        let m = env
            .domain
            .send_message(ctx, SendMessage { recipients: to(to_id), content: text("answer"), causation_id: cause.clone(), ..Default::default() })
            .await
            .unwrap();
        triggers.push(m.envelope.trigger_mode);
        cause = Some(m.envelope.message_id);
    }
    assert_eq!(triggers[0], TriggerMode::Directed);
    assert!(triggers[5..].iter().all(|t| *t == TriggerMode::Never), "{triggers:?}");
}

#[tokio::test]
async fn event_subscriptions_must_state_wake_behaviour_explicitly() {
    let (env, a, _b) = two_agents().await;
    let ca = env.ctx(&a).await;
    let err = env
        .domain
        .create_subscription(
            &ca,
            somework_domain::subscriptions::CreateSubscription { kind: Some("topic".into()), selector: Some("catalog.*".into()), wake_on_match: None },
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::ValidationFailed);
    let quiet = env
        .domain
        .create_subscription(
            &ca,
            somework_domain::subscriptions::CreateSubscription { kind: Some("topic".into()), selector: Some("catalog.*".into()), wake_on_match: Some(false) },
        )
        .await
        .unwrap();
    let loud = env
        .domain
        .create_subscription(
            &ca,
            somework_domain::subscriptions::CreateSubscription {
                kind: Some("topic".into()),
                selector: Some("catalog.changed".into()),
                wake_on_match: Some(true),
            },
        )
        .await
        .unwrap();
    assert!(!quiet.wake_on_match && loud.wake_on_match);
    let admin = env.admin_ctx().await;
    let p = env.create_principal(ActorKind::Agent, "agent/newbie", Some(worker_permissions(somework_core::contracts::SideEffects::Read))).await;
    env.domain
        .register_agent(
            &env.ctx(&p).await,
            somework_domain::catalog::RegisterAgent { card: card("agent/newbie", vec![capability("code.review", "1", "read", "x")]), ..Default::default() },
        )
        .await
        .unwrap();
    let _ = admin;
    let events = env.domain.list_events(&ca, 0, 50).await.unwrap();
    assert!(events.iter().any(|e| e.kind == "catalog.changed" && e.wake), "the explicit wake subscription fires");
    env.domain.delete_subscription(&ca, &loud.subscription_id).await.unwrap();
}

#[tokio::test]
async fn audit_views_honour_the_plaintext_policy_choice() {
    let (env, a, _b) = two_agents().await;
    let ca = env.ctx(&a).await;
    env.domain
        .send_message(&ca, SendMessage { recipients: to("agent/b"), content: text("secret plans"), labels: BTreeMap::new(), ..Default::default() })
        .await
        .unwrap();
    let admin = env.admin_ctx().await;
    let shown = env.domain.audit_messages(&admin, None, None, 10).await.unwrap();
    assert_eq!(shown[0].envelope.content.data, json!("secret plans"));
    let mut policy = env.domain.get_policy(&admin).await.unwrap();
    policy.version = "metadata-only".into();
    policy.audit_plaintext = false;
    env.domain.put_policy(&admin, policy).await.unwrap();
    let hidden = env.domain.audit_messages(&admin, None, None, 10).await.unwrap();
    assert_eq!(hidden[0].envelope.content.data["redacted"], true);
    assert!(hidden[0].envelope.content.data["digest"].as_str().unwrap().len() == 64);
}
