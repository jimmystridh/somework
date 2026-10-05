mod matrix_common;

use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

use matrix_common::*;
use serde_json::{Value, json};
use somework_core::{ErrorCode, contracts::ActorKind, contracts::SideEffects};
use somework_domain::{config::MatrixProfile, policy::Permissions};
use somework_testkit::{Agent, process::eventually};

/// Acceptance "Matrix outage": machine workflow continues; the timeline catches up afterwards without duplicates.
#[tokio::test]
async fn matrix_outage_does_not_stop_work_and_the_timeline_catches_up_once() {
    let env = MxEnv::start().await;
    let worker = env.stack.worker("agent/reviewer", vec![review_cap()], worker_perms(SideEffects::Read)).await;
    let author = env.stack.requester("agent/author", &["code.review"], SideEffects::Read).await;
    env.mx.set_outage(true);

    let task = author.client.submit_task(&json!({"capability": {"id": "code.review", "version": "2.1"}, "input": {"repository": "r"}}), None).await.unwrap();
    let claim = worker.client.claim_task(&task.task_id, Some(30)).await.unwrap();
    worker.client.progress_task(&task.task_id, &json!({"fencingToken": claim.fencing_token, "message": "working"})).await.unwrap();
    worker.client.complete_task(&task.task_id, claim.fencing_token, &json!({"verdict": "approve"}), &[]).await.unwrap();
    assert_eq!(author.client.get_task(&task.task_id).await.unwrap().state.as_str(), "succeeded", "canonical work completed while Matrix was down");

    let outbox = env.stack.admin.get("/v1/admin/outbox").await.unwrap();
    let matrix = outbox["sinks"].as_array().unwrap().iter().find(|s| s["sink"] == "matrix").unwrap().clone();
    assert!(matrix["pending"].as_i64().unwrap() + matrix["failed"].as_i64().unwrap() > 0, "projection backlog is visible: {matrix}");
    assert!(env.mx.rooms().is_empty());

    tokio::time::sleep(Duration::from_millis(1500)).await;
    env.mx.set_outage(false);
    let room = eventually("room after recovery", Duration::from_secs(30), || async {
        env.mx.rooms().into_iter().find(|r| env.mx.events(r).iter().any(|e| e.kind == "dev.somework.task.v1" && e.content["state"] == "succeeded"))
    })
    .await;
    eventually("backlog drained", Duration::from_secs(30), || async {
        let o = env.stack.admin.get("/v1/admin/outbox").await.unwrap();
        let m = o["sinks"].as_array().unwrap().iter().find(|s| s["sink"] == "matrix").unwrap().clone();
        (m["pending"] == 0 && m["failed"] == 0).then_some(())
    })
    .await;

    let events = env.mx.events(&room);
    for state in ["queued", "claimed", "running", "succeeded"] {
        let n = events.iter().filter(|e| e.kind == "dev.somework.task.v1" && e.content["state"] == state).count();
        assert_eq!(n, 1, "{state} projected {n} times");
    }
    let roots = events.iter().filter(|e| e.content["dev.somework.ref"]["type"] == "task" && e.body().starts_with(&format!("Task {} —", task.task_id))).count();
    assert_eq!(roots, 1, "exactly one task root");
    env.stack.stop().await;
}

/// Failure mode "Matrix custom event too large": reject before projection, replace with a reference notice.
#[tokio::test]
async fn oversized_projections_are_replaced_by_a_reference() {
    let env = MxEnv::start_with(|c| c.max_event_bytes = 1200, MatrixProfile::AuditableInternal).await;
    let author = env.stack.requester("agent/author", &[], SideEffects::Read).await;
    let alice = env.human("alice", "@alice:hs.test", human_perms()).await;
    let conversation = env.conversation(&author, "Big room", &[("human", "alice")], None).await;
    let big = "x".repeat(5000);
    let sent = author.client.send_message(&json!({"conversationId": conversation, "content": {"mediaType": "text/plain", "data": big}})).await.unwrap();
    let room = env.wait_room("Big room").await;
    let notice = eventually_events(&env.mx, &room, "oversize notice", |e| e.content["dev.somework.oversize"] == true).await;
    assert!(notice.body().contains(&format!("somework://messages/{}", sent["messageId"].as_str().unwrap())));
    for e in env.mx.events(&room) {
        assert!(serde_json::to_vec(&e.content).unwrap().len() < 1200 + 700, "{} bytes in {}", serde_json::to_vec(&e.content).unwrap().len(), e.kind);
    }
    assert!(!env.mx.all_events().iter().any(|e| e.body().contains(&big)));
    let _ = alice;
    env.stack.stop().await;
}

/// "A security-sensitive conversation MUST get a different room rather than merely a different thread."
#[tokio::test]
async fn sensitive_conversations_get_dedicated_rooms() {
    let env = MxEnv::start().await;
    let _worker = env.stack.worker("agent/reviewer", vec![review_cap()], worker_perms(SideEffects::Read)).await;
    let mut perms = Permissions::default_agent();
    perms.classification_max = Some("confidential".into());
    perms.capabilities = vec!["code.review".into()];
    let key = env.stack.create_principal(ActorKind::Agent, "agent/security-author", perms).await;
    let author = Agent {
        id: "agent/security-author".into(),
        key: key.clone(),
        client: somework_client::Client::assertion(&env.stack.url, (*key).clone(), "agent", "agent/security-author", &env.stack.domain_id),
        base: env.stack.url.clone(),
        domain_id: env.stack.domain_id.clone(),
    };
    let mut hp = human_perms();
    hp.classification_max = Some("confidential".into());
    env.human("erin", "@erin:hs.test", hp).await;

    let secret = env.conversation(&author, "Incident response", &[("human", "erin")], Some("confidential")).await;
    let normal = env.conversation(&author, "Planning", &[("human", "erin")], None).await;
    for (conv, text) in [(&secret, "sensitive"), (&normal, "ordinary")] {
        author.client.send_message(&json!({"conversationId": conv, "content": {"mediaType": "text/plain", "data": text}})).await.unwrap();
    }
    let secret_room = env.wait_room("Incident response").await;
    let normal_room = env.wait_room("Planning").await;
    assert_ne!(secret_room, normal_room);
    assert!(env.mx.room_name(&secret_room).unwrap().starts_with("[confidential]"));
    let marker = env.mx.state_event(&secret_room, "dev.somework.room").unwrap();
    assert_eq!(marker.content["dedicated"], true);
    assert_eq!(env.mx.state_event(&normal_room, "dev.somework.room").unwrap().content["dedicated"], false);

    // a task in the sensitive conversation lives as a thread inside that room only
    let task = author
        .client
        .submit_task(&json!({"capability": {"id": "code.review", "version": "2.1"}, "conversationId": secret, "input": {"repository": "r"}}), None)
        .await
        .unwrap();
    eventually("task thread in the sensitive room", Duration::from_secs(10), || async {
        env.mx.events(&secret_room).into_iter().find(|e| e.content["dev.somework.ref"]["id"] == task.task_id.as_str())
    })
    .await;
    assert!(env.mx.events(&normal_room).iter().all(|e| e.content["dev.somework.ref"]["id"] != task.task_id.as_str()));
    env.stack.stop().await;
}

/// E2EE profiles: no plaintext ever reaches Matrix and rooms are flagged encrypted. `metadata_only_private` projects
/// metadata notices from a bridge without a crypto device; `encrypted_with_observer` projects real Megolm ciphertext
/// and invites the configured observer account (the full crypto behaviour is covered in `matrix_e2ee.rs`).
#[tokio::test]
async fn encrypted_profiles_never_put_plaintext_into_matrix() {
    for (profile, observer) in [(MatrixProfile::MetadataOnlyPrivate, false), (MatrixProfile::EncryptedWithObserver, true)] {
        let env = MxEnv::start_with(|c| c.observer_user = Some("@auditor:hs.test".into()), profile).await;
        env.mx.add_user("@auditor:hs.test");
        let author = env.stack.requester("agent/author", &[], SideEffects::Read).await;
        env.human("alice", "@alice:hs.test", human_perms()).await;
        let conversation = env.conversation(&author, "Private matters", &[("human", "alice")], None).await;
        author
            .client
            .send_message(&json!({"conversationId": conversation, "content": {"mediaType": "text/plain", "data": "the launch code is 0000-SECRET"}}))
            .await
            .unwrap();
        let room = env.wait_room("Private matters").await;
        if observer {
            eventually_events(&env.mx, &room, "encrypted projection", |e| e.kind == "m.room.encrypted").await;
            assert!(!env.mx.all_events().iter().any(|e| e.body().contains("withheld")), "the observer profile projects ciphertext, not metadata notices");
        } else {
            let note = eventually_events(&env.mx, &room, "metadata notice", |e| e.body().contains("withheld")).await;
            assert!(note.body().contains("chat.message"));
            assert!(!env.mx.all_events().iter().any(|e| e.kind == "m.room.encrypted"), "a bridge without a device cannot produce ciphertext");
        }
        assert!(!env.mx.all_events().iter().any(|e| e.to_json().to_string().contains("SECRET")), "no plaintext may reach Matrix in {profile:?}");
        assert!(env.mx.state_event(&room, "m.room.encryption").is_some());
        let invited = env.mx.members(&room).iter().any(|(u, _)| u == "@auditor:hs.test");
        assert_eq!(invited, observer, "observer membership for {profile:?}");
        // the canonical record still holds the content for authorized readers
        let page = author.client.get(&format!("/v1/conversations/{conversation}/messages")).await.unwrap();
        assert!(page["messages"].as_array().unwrap().iter().any(|m| m["content"]["data"] == "the launch code is 0000-SECRET"));
        env.stack.stop().await;
    }
}

struct Responder {
    handled: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
}

fn spawn_responder(agent: Agent, peer: &'static str) -> Responder {
    let handled = Arc::new(AtomicUsize::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let (h, s) = (handled.clone(), stop.clone());
    tokio::spawn(async move {
        let mut cursor = 0;
        while !s.load(Ordering::Relaxed) {
            let Ok((events, next)) = agent.client.events(cursor, 1).await else { continue };
            cursor = next;
            for e in events {
                // predisposed to answer whatever *wakes* it, exactly like a sidecar-hosted agent
                if e["type"] == "message.created" && e["wake"] == true {
                    let id = e["messageId"].as_str().unwrap().to_string();
                    h.fetch_add(1, Ordering::Relaxed);
                    let _ = agent
                        .client
                        .send_message(&json!({"recipients": [{"kind": "agent", "id": peer}], "causationId": id, "content": {"mediaType": "text/plain", "data": "ack, and what do you think?"}}))
                        .await;
                }
            }
        }
    });
    Responder { handled, stop }
}

/// Acceptance "Loop protection": notices/status/streams cannot trigger a turn, and even two agents that answer
/// every woken message stop after the hop guard instead of ping-ponging forever.
#[tokio::test]
async fn agents_cannot_ping_pong_through_notices_or_forever() {
    let env = MxEnv::start().await;
    let a = env.stack.requester("agent/echo-a", &[], SideEffects::Read).await;
    let b = env.stack.requester("agent/echo-b", &[], SideEffects::Read).await;
    let ra = spawn_responder(a.clone(), "agent/echo-b");
    let rb = spawn_responder(b.clone(), "agent/echo-a");

    // non-triggering traffic never wakes the peer
    a.client.send_message(&json!({"recipients": [{"kind": "agent", "id": "agent/echo-b"}], "type": "chat.notice", "content": {"mediaType": "text/plain", "data": "FYI: deploying"}})).await.unwrap();
    a.client.send_message(&json!({"recipients": [{"kind": "agent", "id": "agent/echo-b"}], "type": "event.notification", "triggerMode": "never", "content": {"mediaType": "text/plain", "data": "fact"}})).await.unwrap();
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert_eq!(rb.handled.load(Ordering::Relaxed), 0, "notices and notifications must not invoke an agent turn");

    // forbidden trigger modes are refused outright
    for kind in ["chat.notice", "task.status"] {
        let err = a.client.send_message(&json!({"recipients": [{"kind": "agent", "id": "agent/echo-b"}], "type": kind, "triggerMode": "directed", "content": {"mediaType": "text/plain", "data": "wake up"}})).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::TriggerNotAllowed, "{kind}");
    }
    let err = a
        .client
        .send_message(
            &json!({"recipients": [{"kind": "agent", "id": "agent/echo-b"}], "type": "stream.chunk", "content": {"mediaType": "text/plain", "data": "tok"}}),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::ValidationFailed);

    // genuine conversational ping-pong is bounded by the hop guard
    a.client
        .send_message(&json!({"recipients": [{"kind": "agent", "id": "agent/echo-b"}], "content": {"mediaType": "text/plain", "data": "hello b"}}))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_secs(4)).await;
    let total = ra.handled.load(Ordering::Relaxed) + rb.handled.load(Ordering::Relaxed);
    assert!(total >= 10, "the exchange did happen ({total} turns)");
    tokio::time::sleep(Duration::from_secs(2)).await;
    let later = ra.handled.load(Ordering::Relaxed) + rb.handled.load(Ordering::Relaxed);
    assert_eq!(total, later, "the exchange went quiet");
    assert!(later <= 20, "hop guard bounds the exchange ({later} turns)");
    ra.stop.store(true, Ordering::Relaxed);
    rb.stop.store(true, Ordering::Relaxed);

    // Matrix echoes of the bridge's own output never became canonical messages
    let inbox: Value = a.client.get("/v1/inbox?limit=500").await.unwrap();
    assert!(inbox["messages"].as_array().unwrap().iter().all(|m| m["labels"]["transport"] != "matrix"));
    env.stack.stop().await;
}
