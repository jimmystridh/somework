//! Real Matrix end-to-end encryption (Olm/Megolm via vodozemac): the `encrypted_with_observer` profile with a bridge
//! observer device, the `metadata_only_private` profile without one, key lifecycle, recovery drills and at-rest
//! protection. The homeserver is `MockMatrix` (Synapse cannot run here); the human side is `TestHumanDevice`, an
//! independent vodozemac client, so these tests prove the two crypto implementations interoperate.

mod matrix_common;

use std::time::Duration;

use matrix_common::*;
use serde_json::{Value, json};
use somework_core::contracts::SideEffects;
use somework_domain::{backup::BackupOptions, config::MatrixProfile, policy::Permissions};
use somework_matrix::Bridge;
use somework_testkit::{
    Agent,
    e2ee::TestHumanDevice,
    matrix::{MockMatrix, MxEvent},
    process::eventually,
};
use std::sync::Arc;

const BOT: &str = "@somework:hs.test";

struct World {
    env: MxEnv,
    author: Agent,
    worker: Agent,
    humans: Vec<TestHumanDevice>,
    room: String,
    conversation: String,
}

impl World {
    fn bridge(&self) -> Arc<Bridge> {
        somework_matrix::running_bridge(&self.env.stack.domain().cfg.database_path.to_string_lossy()).expect("running bridge")
    }

    fn send_as(&mut self, name: &str, room: &str, kind: &str, content: Value) -> MxEvent {
        let mxid = format!("@{name}:hs.test");
        let dev = self.humans.iter_mut().find(|h| h.user == mxid).expect("known human");
        dev.send_encrypted(&self.env.mx, room, kind, content)
    }

    fn try_decrypt(&mut self, name: &str, event: &MxEvent) -> Option<(String, Value)> {
        let mxid = format!("@{name}:hs.test");
        let dev = self.humans.iter_mut().find(|h| h.user == mxid).expect("known human");
        dev.decrypt(&self.env.mx, event)
    }

    fn human(&mut self, name: &str) -> &mut TestHumanDevice {
        let mxid = format!("@{name}:hs.test");
        self.humans.iter_mut().find(|h| h.user == mxid).expect("known human")
    }

    async fn say(&self, text: &str) {
        self.author
            .client
            .send_message(&json!({"conversationId": self.conversation, "content": {"mediaType": "text/plain", "data": text}}))
            .await
            .expect("author message");
    }

    /// Waits until `who` can decrypt a bridge projection matching `pred`; returns (event, type, plaintext content).
    async fn wait_decrypted(&mut self, who: &str, what: &str, pred: impl Fn(&str, &Value) -> bool) -> (MxEvent, String, Value) {
        let room = self.room.clone();
        let mxid = format!("@{who}:hs.test");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let events = self.env.mx.events(&room);
            let dev = self.humans.iter_mut().find(|h| h.user == mxid).expect("known human");
            for e in events.into_iter().filter(|e| {
                e.kind == "m.room.encrypted"
                    && !e.sender.starts_with("@alice")
                    && !e.sender.starts_with("@bob")
                    && !e.sender.starts_with("@carol")
                    && !e.sender.starts_with("@dave")
            }) {
                if let Some((t, c)) = dev.decrypt(&self.env.mx, &e)
                    && pred(&t, &c)
                {
                    return (e, t, c);
                }
            }
            assert!(tokio::time::Instant::now() < deadline, "timed out waiting for {what}");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn tasks(&self) -> Vec<Value> {
        self.env.stack.admin.get("/v1/admin/tasks").await.unwrap()["tasks"].as_array().cloned().unwrap_or_default()
    }

    async fn metric(&self, name: &str) -> f64 {
        let text = reqwest::get(format!("{}/metrics", self.env.stack.url)).await.unwrap().text().await.unwrap();
        text.lines().find(|l| l.starts_with(name)).and_then(|l| l.rsplit(' ').next()).and_then(|v| v.parse().ok()).unwrap_or(0.0)
    }

    async fn canonical_texts(&self) -> Vec<String> {
        let page = self.author.client.get(&format!("/v1/conversations/{}/messages?limit=200", self.conversation)).await.unwrap();
        page["messages"].as_array().unwrap().iter().filter_map(|m| m["content"]["data"].as_str().map(String::from)).collect()
    }
}

async fn world(profile: MatrixProfile, humans: &[&str], perms: impl Fn(&str) -> Permissions) -> World {
    let env = MxEnv::start_with(|c| c.crypto.device_cache_ms = 0, profile).await;
    let worker = env.stack.worker("agent/reviewer", vec![review_cap()], worker_perms(SideEffects::Read)).await;
    let author = env.stack.requester("agent/author", &["code.review"], SideEffects::Read).await;
    let mut members = vec![];
    for name in humans {
        env.human(name, &format!("@{name}:hs.test"), perms(name)).await;
        members.push(("human", *name));
    }
    let conversation = env.conversation(&author, "E2EE room", &members, None).await;
    if profile == MatrixProfile::EncryptedWithObserver {
        eventually("observer device published", Duration::from_secs(10), || async { (!env.mx.device_ids_of(BOT).is_empty()).then_some(()) }).await;
    }
    let devices: Vec<TestHumanDevice> =
        humans.iter().map(|n| TestHumanDevice::new(&env.mx, &format!("@{n}:hs.test"), &format!("{}DEV", n.to_uppercase()))).collect();
    let mut w = World { env, author, worker, humans: devices, room: String::new(), conversation };
    w.say("first message creates the room").await;
    w.room = w.env.wait_room("E2EE room").await;
    for name in humans {
        w.env.mx.join_invites(&format!("@{name}:hs.test"));
    }
    // the second projection reaches a room whose human members have joined and published devices: keys are shared now
    w.say("second message shares the room key").await;
    w
}

fn alice_perms(name: &str) -> Permissions {
    let _ = name;
    human_perms()
}

fn text(body: &str) -> Value {
    json!({"msgtype": "m.text", "body": body})
}

async fn complete_task(w: &World, task_id: &str) {
    let claim = w.worker.client.claim_task(task_id, Some(30)).await.unwrap();
    w.worker.client.progress_task(task_id, &json!({"fencingToken": claim.fencing_token, "message": "reading the diff"})).await.unwrap();
    w.worker.client.complete_task(task_id, claim.fencing_token, &json!({"verdict": "approve"}), &[]).await.unwrap();
}

fn forged_event(room: &str, sender: &str, content: &Value, id: &str) -> Value {
    json!({"event_id": id, "room_id": room, "sender": sender, "type": "m.room.encrypted", "content": content, "origin_server_ts": chrono::Utc::now().timestamp_millis()})
}

// ---- (a) observer profile round trip ------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn observer_round_trip_human_decrypts_projections_and_the_bridge_executes_encrypted_commands() {
    let mut w = world(MatrixProfile::EncryptedWithObserver, &["alice"], alice_perms).await;
    assert!(w.env.mx.state_event(&w.room, "m.room.encryption").is_some());

    // bridge -> human: the projection is ciphertext on the wire and readable by the human's device
    w.say("confidential payload for alice").await;
    let (event, kind, content) =
        w.wait_decrypted("alice", "decrypted author message", |_, c| c["body"].as_str().is_some_and(|b| b.contains("confidential payload"))).await;
    assert_eq!(kind, "m.room.message");
    assert_eq!(event.kind, "m.room.encrypted");
    let on_the_wire = serde_json::to_string(&w.env.mx.all_events().iter().map(MxEvent::to_json).collect::<Vec<_>>()).unwrap();
    assert!(!on_the_wire.contains("confidential payload"), "no plaintext of the message may reach the homeserver");
    assert_eq!(event.content["algorithm"], "m.megolm.v1.aes-sha2");
    assert!(content["body"].as_str().unwrap().contains("alice") || content["body"].as_str().unwrap().contains("confidential"));

    // human -> bridge: an encrypted !task command is decrypted by the observer device and executed as the mapped human
    let room = w.room.clone();
    w.send_as("alice", &room, "m.room.message", text("!task code.review@2.1 {\"repository\": \"billing/import-service\"}"));
    let task = eventually("task created from an encrypted command", Duration::from_secs(10), || async {
        w.tasks().await.into_iter().find(|t| t["requester"]["id"] == "alice")
    })
    .await;
    complete_task(&w, task["taskId"].as_str().unwrap()).await;

    // the task thread is projected into the encrypted room: structured event + companion notice, all readable by alice
    let (_, kind, state) = w.wait_decrypted("alice", "task succeeded event", |t, c| t == "dev.somework.task.v1" && c["state"] == "succeeded").await;
    assert_eq!(kind, "dev.somework.task.v1");
    assert_eq!(state["canonical_ref"], format!("somework://tasks/{}", task["taskId"].as_str().unwrap()));
    w.wait_decrypted("alice", "task notice", |t, c| {
        t == "m.room.message" && c["msgtype"] == "m.notice" && c["body"].as_str().is_some_and(|b| b.to_lowercase().contains("succeeded"))
    })
    .await;
    let wire_types: Vec<String> = w.env.mx.events(&w.room).into_iter().map(|e| e.kind).collect();
    assert!(
        !wire_types.iter().any(|t| t.starts_with("dev.somework.") && t != "dev.somework.room"),
        "structured events travel inside encrypted payloads only (room state is the only plaintext marker): {wire_types:?}"
    );

    // the observer's audit projection records metadata and digests
    let audit = w.env.stack.admin.get("/v1/admin/audit?limit=500").await.unwrap();
    let decrypted: Vec<&Value> = audit["events"].as_array().unwrap().iter().filter(|e| e["action"] == "matrix.observer.decrypted").collect();
    assert!(!decrypted.is_empty());
    assert!(decrypted.iter().all(|e| e["detail"]["contentDigest"].as_str().is_some_and(|d| d.len() == 64)));
    w.env.stack.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn encrypted_commands_are_policy_checked_as_the_mapped_human() {
    let mut w = world(MatrixProfile::EncryptedWithObserver, &["alice", "bob"], |n| {
        if n == "bob" {
            let mut p = Permissions::default_human();
            p.capabilities = vec![];
            p.discover = vec!["code.review".into()];
            p
        } else {
            human_perms()
        }
    })
    .await;
    let room = w.room.clone();
    w.send_as("bob", &room, "m.room.message", text("!task code.review@2.1 {\"repository\": \"billing/import-service\"}"));
    // the denial comes back as an encrypted notice the human can read, and nothing was created
    let (_, _, notice) = w.wait_decrypted("bob", "denial notice", |_, c| c["body"].as_str().is_some_and(|b| b.starts_with("Denied by policy"))).await;
    assert!(notice["body"].as_str().unwrap().contains("code.review"));
    assert!(w.tasks().await.is_empty(), "room membership and a decryptable message confer no right to execute");
    let audit = w.env.stack.admin.get("/v1/admin/audit?limit=500").await.unwrap();
    assert!(audit["events"].as_array().unwrap().iter().any(|e| e["outcome"] == "denied" && e["authenticatedActor"] == "human:bob"));
    w.env.stack.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_encrypted_reaction_approves_exactly_the_requested_action() {
    let env = MxEnv::start_with(|c| c.crypto.device_cache_ms = 0, MatrixProfile::EncryptedWithObserver).await;
    let _deployer = env
        .stack
        .worker(
            "agent/deployer",
            vec![somework_testkit::capability("deployment.execute", "1.0", "irreversible", "Execute a production deployment")],
            worker_perms(SideEffects::Irreversible),
        )
        .await;
    let author = env.stack.requester("agent/author", &["deployment.execute"], SideEffects::Irreversible).await;
    let mut approver = Permissions::default_human();
    approver.approves = vec!["deployment.*".into()];
    env.human("carol", "@carol:hs.test", approver).await;
    env.human("dave", "@dave:hs.test", Permissions::default_human()).await;
    let conversation = env.conversation(&author, "E2EE room", &[("human", "carol"), ("human", "dave")], None).await;
    eventually("observer device", Duration::from_secs(10), || async { (!env.mx.device_ids_of(BOT).is_empty()).then_some(()) }).await;
    let mut carol = TestHumanDevice::new(&env.mx, "@carol:hs.test", "CAROLDEV");
    let mut dave = TestHumanDevice::new(&env.mx, "@dave:hs.test", "DAVEDEV");
    author.client.send_message(&json!({"conversationId": conversation, "content": {"mediaType": "text/plain", "data": "deploy window opens"}})).await.unwrap();
    let room = env.wait_room("E2EE room").await;
    env.mx.join_invites("@carol:hs.test");
    env.mx.join_invites("@dave:hs.test");

    let task = author.client.submit_task(&json!({"capability": {"id": "deployment.execute", "version": "1.0"}, "conversationId": conversation, "input": {"repository": "billing/import-service"}}), None).await.unwrap();
    assert_eq!(task.state.as_str(), "submitted");
    let approval_id = task.pending_approval.as_ref().unwrap()["approvalId"].as_str().unwrap().to_string();

    // carol finds the (encrypted) approval prompt by decrypting the bridge's events
    let prompt = loop {
        let found = env.mx.events(&room).into_iter().filter(|e| e.kind == "m.room.encrypted").find(|e| {
            carol.decrypt(&env.mx, e).is_some_and(|(_, c)| c["body"].as_str().is_some_and(|b| b.contains("Approval required") && b.contains(&approval_id)))
        });
        if let Some(event) = found {
            break event;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    // dave is not an approver: his encrypted thumbs-up is refused by the domain
    let _ = dave.decrypt(&env.mx, &prompt);
    dave.send_encrypted(&env.mx, &room, "m.reaction", json!({"m.relates_to": {"rel_type": "m.annotation", "event_id": prompt.event_id, "key": "👍"}}));
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(author.client.get_task(&task.task_id).await.unwrap().state.as_str(), "submitted", "an unauthorized encrypted reaction approves nothing");

    carol.send_encrypted(&env.mx, &room, "m.reaction", json!({"m.relates_to": {"rel_type": "m.annotation", "event_id": prompt.event_id, "key": "👍"}}));
    eventually("task queued after the approval", Duration::from_secs(10), || async {
        (author.client.get_task(&task.task_id).await.unwrap().state.as_str() == "queued").then_some(())
    })
    .await;
    let audit = env.stack.admin.get("/v1/admin/audit?limit=500").await.unwrap();
    assert!(audit["events"].as_array().unwrap().iter().any(|e| e["action"] == "approval.decide" && e["authenticatedActor"] == "human:carol"));
    env.stack.stop().await;
}

// ---- (b) metadata-only profile --------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn metadata_only_private_bridge_cannot_read_human_content_and_nothing_executes() {
    let mut w = world(MatrixProfile::MetadataOnlyPrivate, &["alice"], alice_perms).await;
    assert!(w.bridge().crypto.is_none(), "this profile holds no crypto device");
    assert!(w.env.mx.device_ids_of(BOT).is_empty(), "no device keys were ever published, so members cannot share room keys with the platform");

    w.say("the launch code is 0000-SECRET").await;
    let note =
        eventually("metadata notice", Duration::from_secs(10), || async { w.env.mx.events(&w.room).into_iter().find(|e| e.body().contains("withheld")) }).await;
    assert!(note.body().contains("chat.message"));
    let room = w.room.clone();
    w.send_as("alice", &room, "m.room.message", text("!task code.review@2.1 {\"repository\": \"billing/import-service\"} PRIVATE-HUMAN-TEXT"));
    eventually("undecryptable counter", Duration::from_secs(10), || async {
        (w.metric("somework_matrix_undecryptable_events_total").await >= 1.0).then_some(())
    })
    .await;
    assert!(w.tasks().await.is_empty(), "nothing executes from encrypted-only messages");
    assert!(!w.canonical_texts().await.iter().any(|t| t.contains("PRIVATE-HUMAN-TEXT")), "the human's content never reached the domain");

    let wire = serde_json::to_string(&w.env.mx.all_events().iter().map(MxEvent::to_json).collect::<Vec<_>>()).unwrap();
    assert!(!wire.contains("SECRET"), "projections contain no plaintext content");
    assert!(!wire.contains("PRIVATE-HUMAN-TEXT"), "the encrypted human event is stored verbatim as ciphertext");
    let audit = w.env.stack.admin.get("/v1/admin/audit?limit=500").await.unwrap();
    assert!(!serde_json::to_string(&audit).unwrap().contains("PRIVATE-HUMAN-TEXT"));
    assert!(!audit["events"].as_array().unwrap().iter().any(|e| e["action"] == "matrix.observer.decrypted"));
    w.env.stack.stop().await;
}

// ---- (c) rotation, replay, forgery ---------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn megolm_rotates_on_membership_change_and_replayed_or_forged_events_are_rejected() {
    let mut w = world(MatrixProfile::EncryptedWithObserver, &["alice", "bob"], alice_perms).await;
    w.say("m1 before bob leaves").await;
    let (m1, _, _) = w.wait_decrypted("bob", "m1 for bob", |_, c| c["body"].as_str().is_some_and(|b| b.contains("m1 before"))).await;
    w.wait_decrypted("alice", "m1 for alice", |_, c| c["body"].as_str().is_some_and(|b| b.contains("m1 before"))).await;
    let s1 = m1.content["session_id"].as_str().unwrap().to_string();

    w.env.mx.leave(&w.room, "@bob:hs.test");
    w.say("m2 after bob left").await;
    let (m2, _, _) = w.wait_decrypted("alice", "m2 for alice", |_, c| c["body"].as_str().is_some_and(|b| b.contains("m2 after"))).await;
    assert_ne!(m2.content["session_id"].as_str().unwrap(), s1, "a new Megolm session starts when a member leaves");
    assert!(w.try_decrypt("bob", &m2).is_none(), "the removed device cannot decrypt later events");
    assert!(w.try_decrypt("bob", &m1).is_some(), "history it already held stays readable");
    let reasons: Vec<String> = sqlx::query_scalar("SELECT rotated_reason FROM matrix_megolm_outbound WHERE status = 'retired' AND rotated_reason IS NOT NULL")
        .fetch_all(w.env.stack.domain().db.pool())
        .await
        .unwrap();
    assert!(reasons.iter().any(|r| r == "membership_or_device_removed"), "{reasons:?}");

    // replay: the same ciphertext under a new event id is refused (message-index replay protection)
    let room = w.room.clone();
    let original = w.send_as("alice", &room, "m.room.message", text("a perfectly normal remark"));
    eventually("alice's remark ingested", Duration::from_secs(10), || async {
        w.canonical_texts().await.iter().any(|t| t.contains("a perfectly normal remark")).then_some(())
    })
    .await;
    let before = w.metric("somework_matrix_undecryptable_events_total").await;
    assert_eq!(w.env.mx.push_transaction("replay-1", vec![forged_event(&room, "@alice:hs.test", &original.content, "$replayed-copy")], None).await, 200);
    eventually("replay counted", Duration::from_secs(10), || async {
        (w.metric("somework_matrix_undecryptable_events_total").await >= before + 1.0).then_some(())
    })
    .await;
    assert_eq!(w.canonical_texts().await.iter().filter(|t| t.contains("a perfectly normal remark")).count(), 1, "the replay created no second message");

    // forgery: mallory's genuine ciphertext presented as alice's, and a swapped sender key, are both rejected
    w.env.mx.add_user("@mallory:hs.test");
    let client = w.bridge().client.clone();
    client.invite(&room, BOT, "@mallory:hs.test").await.unwrap();
    w.env.mx.join_invites("@mallory:hs.test");
    let mut mallory = TestHumanDevice::new(&w.env.mx, "@mallory:hs.test", "MALLORYDEV");
    mallory.ensure_room_session(&w.env.mx, &room);
    let genuine = mallory.encrypt_only(&room, "m.room.message", text("!task code.review@2.1 {\"repository\": \"billing/import-service\"}"));
    // the key share must have reached the bridge before the forgery is evaluated
    tokio::time::sleep(Duration::from_millis(500)).await;
    let before = w.metric("somework_matrix_undecryptable_events_total").await;
    w.env.mx.push_transaction("forge-1", vec![forged_event(&room, "@alice:hs.test", &genuine, "$forged-1")], None).await;
    let mut swapped = genuine.clone();
    swapped["sender_key"] = json!(w.human("alice").curve25519());
    w.env.mx.push_transaction("forge-2", vec![forged_event(&room, "@mallory:hs.test", &swapped, "$forged-2")], None).await;
    eventually("forgeries counted", Duration::from_secs(10), || async {
        (w.metric("somework_matrix_undecryptable_events_total").await >= before + 2.0).then_some(())
    })
    .await;
    assert!(w.tasks().await.is_empty(), "no forged event executed anything");
    let audit = w.env.stack.admin.get("/v1/admin/audit?limit=500").await.unwrap();
    let reasons: Vec<String> = audit["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["action"] == "matrix.observer.rejected")
        .map(|e| e["detail"]["reason"].as_str().unwrap_or_default().to_string())
        .collect();
    assert!(reasons.iter().any(|r| r.contains("replay")), "{reasons:?}");
    assert!(reasons.iter().any(|r| r.contains("different user")), "{reasons:?}");
    assert!(reasons.iter().any(|r| r.contains("sender_key")), "{reasons:?}");

    // a device with an invalid self-signature never receives room keys
    w.env.mx.inject_device_keys("@alice:hs.test", "EVIL", json!({"user_id": "@alice:hs.test", "device_id": "EVIL", "algorithms": ["m.megolm.v1.aes-sha2"], "keys": {"curve25519:EVIL": "A".repeat(43), "ed25519:EVIL": "B".repeat(43)}, "signatures": {"@alice:hs.test": {"ed25519:EVIL": "C".repeat(86)}}}));
    w.say("m3 after the evil device appeared").await;
    w.wait_decrypted("alice", "m3", |_, c| c["body"].as_str().is_some_and(|b| b.contains("m3 after"))).await;
    assert!(w.env.mx.client_take_to_device("@alice:hs.test", "EVIL").is_empty());
    w.env.stack.stop().await;
}

// ---- (d) key loss ------------------------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn key_loss_drill_restores_the_bridge_from_a_recovery_bundle_and_the_session_continues() {
    let mut w = world(MatrixProfile::EncryptedWithObserver, &["alice"], alice_perms).await;
    let room = w.room.clone();
    w.send_as("alice", &room, "m.room.message", text("before the incident"));
    eventually("first message ingested", Duration::from_secs(10), || async {
        w.canonical_texts().await.iter().any(|t| t.contains("before the incident")).then_some(())
    })
    .await;
    let (before_event, _, _) = w.wait_decrypted("alice", "bridge message", |_, c| c["body"].as_str().is_some()).await;
    let session_before = before_event.content["session_id"].as_str().unwrap().to_string();
    let device_before = w.env.mx.device_ids_of(BOT);

    let domain = w.env.stack.domain().clone();
    let bundle = domain.export_matrix_crypto("correct horse battery staple", 1000).await.unwrap();
    assert!(!bundle.contains("signing_key") && !bundle.contains(&session_before), "the bundle is opaque without the passphrase");
    assert!(domain.import_matrix_crypto(&bundle, "wrong passphrase!!").await.is_err(), "a wrong passphrase is refused");

    // disaster: all crypto state is gone (the in-memory caches too)
    domain.crypto_wipe().await.unwrap();
    w.bridge().crypto.as_ref().unwrap().reload().await;
    let report = domain.import_matrix_crypto(&bundle, "correct horse battery staple").await.unwrap();
    assert!(report.accounts >= 1 && report.megolm_inbound >= 1 && report.megolm_outbound >= 1, "{report:?}");
    assert!(domain.verify_matrix_crypto().await.unwrap().selftest_vector_ok);
    w.bridge().crypto.as_ref().unwrap().reload().await;

    // the same Megolm session keeps working in both directions, on the same device
    w.send_as("alice", &room, "m.room.message", text("after the restore, same session"));
    eventually("post-restore message ingested", Duration::from_secs(10), || async {
        w.canonical_texts().await.iter().any(|t| t.contains("after the restore")).then_some(())
    })
    .await;
    w.say("bridge speaks again after the restore").await;
    let (after_event, _, _) =
        w.wait_decrypted("alice", "post-restore bridge message", |_, c| c["body"].as_str().is_some_and(|b| b.contains("speaks again"))).await;
    assert_eq!(after_event.content["session_id"].as_str().unwrap(), session_before, "the outbound session survived the restore");
    assert_eq!(w.env.mx.device_ids_of(BOT), device_before, "the device identity survived the restore");
    w.env.stack.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn losing_all_key_material_without_a_backup_starts_a_fresh_device_while_old_history_stays_unreadable() {
    let mut w = world(MatrixProfile::EncryptedWithObserver, &["alice"], alice_perms).await;
    let room = w.room.clone();
    let history = w.send_as("alice", &room, "m.room.message", text("history before the loss"));
    eventually("history ingested", Duration::from_secs(10), || async {
        w.canonical_texts().await.iter().any(|t| t.contains("history before the loss")).then_some(())
    })
    .await;
    let old_device = w.env.mx.device_ids_of(BOT);
    let domain = w.env.stack.domain().clone();

    domain.crypto_wipe().await.unwrap();
    w.bridge().crypto.as_ref().unwrap().reload().await;
    // a bridge restart (which provisions the observer device) creates a brand-new device and removes the stale one
    w.bridge().crypto.as_ref().unwrap().ensure_device(BOT).await.unwrap();
    w.say("the bridge comes back with a new device").await;
    eventually("new device published, stale one removed", Duration::from_secs(15), || async {
        let now = w.env.mx.device_ids_of(BOT);
        (now.len() == 1 && now != old_device).then_some(())
    })
    .await;

    // alice's client notices the new device on its next send and shares the current session with it
    w.send_as("alice", &room, "m.room.message", text("readable by the new device"));
    eventually("new traffic works", Duration::from_secs(15), || async {
        w.canonical_texts().await.iter().any(|t| t.contains("readable by the new device")).then_some(())
    })
    .await;
    let crypto = w.bridge().crypto.clone().unwrap();
    assert!(
        crypto.decrypt_room_event(&history.to_json()).await.is_err(),
        "history from before the loss is gone for good: the new device never held that session"
    );
    assert!(w.canonical_texts().await.iter().any(|t| t.contains("history before the loss")), "canonical state is untouched by the crypto loss");
    assert!(w.tasks().await.is_empty());
    assert_eq!(w.env.stack.domain().verify_audit_chain().await.unwrap(), None, "the domain stays consistent");
    w.env.stack.stop().await;
}

// ---- (e) backup and restore of the whole domain ------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_domain_backup_and_restore_preserve_the_crypto_tables_and_decrypt_the_stored_vector() {
    let mut w = world(MatrixProfile::EncryptedWithObserver, &["alice"], alice_perms).await;
    let room = w.room.clone();
    let sent = w.send_as("alice", &room, "m.room.message", text("kept across the restore"));
    eventually("ingested", Duration::from_secs(10), || async { w.canonical_texts().await.iter().any(|t| t.contains("kept across the restore")).then_some(()) })
        .await;
    let domain = w.env.stack.domain().clone();
    domain.ensure_crypto_selftest().await.unwrap();
    let counts_before = domain.crypto_table_counts().await.unwrap();

    let dir = tempfile::tempdir_in(std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".into())).unwrap();
    let backup = dir.path().join("backup");
    domain.backup_to(&backup, &BackupOptions { include_master_key: true, ..Default::default() }).await.unwrap();
    let restored_dir = dir.path().join("restored");
    let report = somework_domain::backup::restore_backup(&backup, &restored_dir, None).await.expect("restore verification includes the crypto self-test");
    assert!(report.audit_intact);

    let mut cfg = somework_domain::config::DomainConfig::new(domain.domain_id().to_string(), restored_dir.join(somework_domain::backup::DB_FILE));
    cfg.db_synchronous_full = false;
    let restored = somework_domain::Domain::open(cfg).await.unwrap();
    assert_eq!(restored.crypto_table_counts().await.unwrap(), counts_before);
    let verified = restored.verify_matrix_crypto().await.unwrap();
    assert!(verified.selftest_vector_ok && verified.accounts >= 1 && verified.megolm_inbound >= 1);

    // the restored database still decrypts the earlier event with the recovered session
    let mcfg = w.bridge().cfg.clone();
    let crypto = somework_matrix::crypto::CryptoManager::new(
        restored.clone(),
        somework_matrix::client::MatrixClient::new(&mcfg, somework_matrix::client::Tokens::new(&mcfg)),
        mcfg,
    );
    let decrypted = crypto.decrypt_room_event(&sent.to_json()).await.expect("recovered keys decrypt the stored ciphertext");
    assert_eq!(decrypted.content["body"], "kept across the restore");
    w.env.stack.stop().await;
}

// ---- (f) secrets at rest ---------------------------------------------------------------------------------------------------

/// Distinctive fragments of an unsealed pickle: if any survives in the database file, the pickle was stored in the clear.
fn fragments(pickle: &[u8], out: &mut Vec<String>) {
    let text = String::from_utf8_lossy(pickle).to_string();
    assert!(text.len() > 200, "pickle too short to be real key material");
    for start in [0, text.len() / 3, text.len() / 2, text.len() - 64] {
        out.push(text[start..start + 48].to_string());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pickles_are_sealed_at_rest_and_no_key_material_appears_in_the_database_file() {
    let mut w = world(MatrixProfile::EncryptedWithObserver, &["alice"], alice_perms).await;
    let room = w.room.clone();
    w.send_as("alice", &room, "m.room.message", text("exercise the inbound session store"));
    eventually("ingested", Duration::from_secs(10), || async { w.canonical_texts().await.iter().any(|t| t.contains("exercise the inbound")).then_some(()) })
        .await;
    let domain = w.env.stack.domain().clone();
    let crypto = w.bridge().crypto.clone().unwrap();

    let mut secrets = vec![];
    fragments(crypto.account_pickle_json(BOT).await.unwrap().as_bytes(), &mut secrets);
    let (projection, _, _) = w.wait_decrypted("alice", "an agent projection", |_, c| c["body"].as_str().is_some()).await;
    let agent = projection.sender.clone();
    let agent_device = w.env.mx.device_ids_of(&agent).remove(0);
    let (_, curve, ed) = crypto.ensure_device(BOT).await.unwrap();
    let out = domain.crypto_out_active(&agent, &agent_device, &room).await.unwrap().expect("outbound session");
    fragments(&out.pickle, &mut secrets);
    let inbound_sessions: Vec<_> = sqlx::query_scalar::<_, String>("SELECT session_id FROM matrix_megolm_inbound").fetch_all(domain.db.pool()).await.unwrap();
    let inbound = domain.crypto_in_get(&room, &inbound_sessions[0]).await.unwrap().unwrap();
    fragments(&inbound.pickle, &mut secrets);
    assert!(secrets.len() >= 6, "the test must know real secret material: {}", secrets.len());

    domain.db.checkpoint().await.unwrap();
    let db_path = domain.cfg.database_path.clone();
    let mut bytes = std::fs::read(&db_path).unwrap();
    for suffix in ["-wal", "-shm"] {
        if let Ok(extra) = std::fs::read(format!("{}{suffix}", db_path.display())) {
            bytes.extend(extra);
        }
    }
    let haystack = String::from_utf8_lossy(&bytes);
    for s in &secrets {
        assert!(!haystack.contains(s.as_str()), "secret material found unsealed in the database file");
    }
    assert!(!haystack.contains(&curve) && !haystack.contains(&ed), "the bridge's own identity keys are only stored sealed");
    let sealed: String = sqlx::query_scalar("SELECT sealed_pickle FROM matrix_crypto_accounts LIMIT 1").fetch_one(domain.db.pool()).await.unwrap();
    assert!(sealed.contains('.') && !sealed.contains('{'), "sealed form is nonce.ciphertext, not JSON");
    w.env.stack.stop().await;
}

// ---- device lifecycle -----------------------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn device_rotation_replaces_the_identity_and_one_time_keys_are_replenished() {
    let mut w = world(MatrixProfile::EncryptedWithObserver, &["alice"], alice_perms).await;
    let crypto = w.bridge().crypto.clone().unwrap();

    // every virtual agent user has its own device; rotate the one that authored the projections alice reads
    let (first, _, _) = w.wait_decrypted("alice", "an agent projection", |_, c| c["body"].as_str().is_some()).await;
    let agent = first.sender.clone();
    let old = w.env.mx.device_ids_of(&agent);
    assert_eq!(old.len(), 1);
    let fresh = crypto.rotate_device(&agent).await.unwrap();
    assert_ne!(fresh, old[0]);
    assert_eq!(w.env.mx.device_ids_of(&agent), vec![fresh.clone()], "the rotated-out device is removed from the homeserver");
    w.say("spoken by the rotated device").await;
    let (event, _, _) = w.wait_decrypted("alice", "message from the new device", |_, c| c["body"].as_str().is_some_and(|b| b.contains("rotated device"))).await;
    assert_eq!(event.content["device_id"], fresh.as_str(), "projections now come from the new device");
    assert_ne!(event.content["session_id"], first.content["session_id"], "the new device starts its own Megolm session");

    let observer = w.env.mx.device_ids_of(BOT).remove(0);
    let before = w.env.mx.one_time_key_count(BOT, &observer);
    crypto.handle_otk_counts(&json!({BOT: {observer.clone(): {"signed_curve25519": 5}}})).await;
    assert!(w.env.mx.one_time_key_count(BOT, &observer) > before, "low one-time key counts trigger an upload");
    w.env.stack.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_policy_decides_whether_the_observers_audit_projection_keeps_plaintext() {
    for keep in [true, false] {
        let mut w = world(MatrixProfile::EncryptedWithObserver, &["alice"], alice_perms).await;
        let domain = w.env.stack.domain().clone();
        let mut policy = domain.get_policy(&domain.system_ctx()).await.unwrap();
        policy.version = format!("audit-plaintext-{keep}");
        policy.audit_plaintext = keep;
        domain.put_policy(&domain.system_ctx(), policy).await.unwrap();
        let room = w.room.clone();
        w.send_as("alice", &room, "m.room.message", text("a remark for the auditor"));
        eventually("ingested", Duration::from_secs(10), || async {
            w.canonical_texts().await.iter().any(|t| t.contains("a remark for the auditor")).then_some(())
        })
        .await;
        let audit = w.env.stack.admin.get("/v1/admin/audit?limit=500").await.unwrap();
        let entry = audit["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["action"] == "matrix.observer.decrypted" && e["detail"]["type"] == "m.room.message" && e["detail"]["senderDevice"] == "ALICEDEV")
            .cloned()
            .expect("observer audit entry");
        assert_eq!(entry["detail"].get("content").is_some(), keep, "audit_plaintext={keep}: {entry}");
        assert_eq!(entry["detail"]["contentDigest"].as_str().unwrap().len(), 64);
        w.env.stack.stop().await;
    }
}

#[allow(dead_code)]
fn _types(_: &MockMatrix) {}
