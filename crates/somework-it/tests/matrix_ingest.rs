mod matrix_common;

use std::time::Duration;

use matrix_common::*;
use serde_json::{Value, json};
use somework_core::contracts::SideEffects;
use somework_domain::policy::Permissions;
use somework_testkit::process::eventually;

async fn canonical_messages(_env: &MxEnv, who: &somework_testkit::Agent, conversation: &str) -> Vec<Value> {
    who.client.get(&format!("/v1/conversations/{conversation}/messages?limit=200")).await.unwrap()["messages"].as_array().cloned().unwrap_or_default()
}

async fn admin_get(env: &MxEnv, path: &str) -> Value {
    env.stack.admin.get(path).await.unwrap()
}

/// ID-04 / least privilege: a Matrix account without an explicit mapping is observed and audited but can never
/// cause execution, however it phrases its request.
#[tokio::test]
async fn unmapped_matrix_user_cannot_submit_tasks() {
    let env = MxEnv::start().await;
    let _worker = env.stack.worker("agent/reviewer", vec![review_cap()], worker_perms(SideEffects::Read)).await;
    let author = env.stack.requester("agent/author", &["code.review"], SideEffects::Read).await;
    let alice = env.human("alice", "@alice:hs.test", human_perms()).await;
    env.mx.add_user("@mallory:hs.test");
    let conversation = env.conversation(&author, "Open room", &[("human", "alice")], None).await;
    author.client.send_message(&json!({"conversationId": conversation, "content": {"mediaType": "text/plain", "data": "hello"}})).await.unwrap();
    let room = env.wait_room("Open room").await;
    env.mx.join_invites("@alice:hs.test");
    // Mallory was added to the Matrix room out of band (an invite by a room admin), but has no principal mapping
    let _ = alice;
    // the mock lets any invited user speak; invite Mallory through the bot's own client path
    let client = somework_matrix::running_bridge(&env.stack.domain().cfg.database_path.to_string_lossy()).unwrap().client.clone();
    client.invite(&room, "@somework:hs.test", "@mallory:hs.test").await.unwrap();
    env.mx.join_invites("@mallory:hs.test");

    env.mx.user_send_text(&room, "@mallory:hs.test", "!task code.review@2.1 {\"repository\": \"billing/import-service\"}", &[]);
    eventually("unmapped sender audited", Duration::from_secs(10), || async {
        let audit = admin_get(&env, "/v1/admin/audit?limit=500").await;
        audit["events"].as_array().unwrap().iter().find(|e| e["action"] == "matrix.ingest.unmapped_sender").cloned()
    })
    .await;
    let tasks = admin_get(&env, "/v1/admin/tasks").await;
    assert!(tasks["tasks"].as_array().unwrap().is_empty(), "no task may exist: {tasks}");
    // and nothing from Mallory became a canonical message either
    assert!(canonical_messages(&env, &author, &conversation).await.iter().all(|m| m["sender"]["id"] != "mallory"));
    env.stack.stop().await;
}

/// A mapped human who sits in the room but lacks the capability grant is denied by the domain (and the denial is
/// recorded); room membership never confers the right to execute.
#[tokio::test]
async fn mapped_human_without_grant_is_denied_by_policy() {
    let env = MxEnv::start().await;
    let _worker = env.stack.worker("agent/reviewer", vec![review_cap()], worker_perms(SideEffects::Read)).await;
    let author = env.stack.requester("agent/author", &["code.review"], SideEffects::Read).await;
    let mut perms = Permissions::default_human();
    perms.capabilities = vec![];
    perms.discover = vec!["code.review".into()]; // sees the capability, may not invoke it
    let bob = env.human("bob", "@bob:hs.test", perms).await;
    let conversation = env.conversation(&author, "Team room", &[("human", "bob")], None).await;
    author.client.send_message(&json!({"conversationId": conversation, "content": {"mediaType": "text/plain", "data": "hi"}})).await.unwrap();
    let room = env.wait_room("Team room").await;
    env.mx.join_invites("@bob:hs.test");

    env.mx.user_send_text(&room, "@bob:hs.test", "!task code.review@2.1 {\"repository\": \"billing/import-service\"}", &[]);
    let notice = eventually_events(&env.mx, &room, "denial notice", |e| e.content["msgtype"] == "m.notice" && e.body().starts_with("Denied by policy")).await;
    assert!(notice.body().contains("code.review"), "{}", notice.body());
    let audit = admin_get(&env, "/v1/admin/audit?limit=500").await;
    let denial = audit["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["outcome"] == "denied" && e["authenticatedActor"] == "human:bob")
        .expect("the denial is audited with the human as actor");
    assert_eq!(denial["sourceTransport"], "matrix");
    assert!(admin_get(&env, "/v1/admin/tasks").await["tasks"].as_array().unwrap().is_empty());
    let _ = bob;
    env.stack.stop().await;
}

/// Hermes-style mention gating: only a message naming an agent wakes it; everything else is recorded as `never`.
#[tokio::test]
async fn only_mentions_trigger_agents_and_commands_run_as_the_human() {
    let env = MxEnv::start().await;
    let worker = env.stack.worker("agent/reviewer", vec![review_cap()], worker_perms(SideEffects::Read)).await;
    let author = env.stack.requester("agent/author", &["code.review"], SideEffects::Read).await;
    let _alice = env.human("alice", "@alice:hs.test", human_perms()).await;
    let conversation = env.conversation(&author, "Mentions", &[("human", "alice"), ("agent", "agent/reviewer")], None).await;
    author.client.send_message(&json!({"conversationId": conversation, "content": {"mediaType": "text/plain", "data": "kickoff"}})).await.unwrap();
    let room = env.wait_room("Mentions").await;
    env.mx.join_invites("@alice:hs.test");

    env.mx.user_send_text(&room, "@alice:hs.test", "just talking among ourselves", &[]);
    env.mx.user_send_text(&room, "@alice:hs.test", "can you look at this?", &["@_agent_agent=2freviewer:hs.test"]);
    let messages = eventually("both inbound messages canonical", Duration::from_secs(10), || async {
        let m = canonical_messages(&env, &author, &conversation).await;
        (m.iter().filter(|m| m["sender"]["id"] == "alice").count() == 2).then_some(m)
    })
    .await;
    let plain = messages.iter().find(|m| m["content"]["data"] == "just talking among ourselves").unwrap();
    let mentioned = messages.iter().find(|m| m["content"]["data"] == "can you look at this?").unwrap();
    assert_eq!(plain["triggerMode"], "never");
    assert_eq!(mentioned["triggerMode"], "directed");
    assert_eq!(mentioned["recipients"][0]["id"], "agent/reviewer");
    assert_eq!(mentioned["sender"]["id"], "alice", "identity comes from the explicit mapping, not display names");
    let events = worker.client.events(0, 0).await.unwrap().0;
    let wakes: Vec<_> = events.iter().filter(|e| e["type"] == "message.created" && e["wake"] == true).collect();
    assert_eq!(wakes.len(), 1, "only the mentioned message wakes the agent: {events:?}");

    // a command is executed with alice's own permissions
    env.mx.user_send_text(&room, "@alice:hs.test", "!task code.review {\"repository\": \"billing/import-service\", \"commit\": \"61a8d52\"}", &[]);
    let notice = eventually_events(&env.mx, &room, "task submitted notice", |e| e.body().starts_with("Task task_")).await;
    let task_id = notice.body().split_whitespace().nth(1).unwrap().to_string();
    let task = env.stack.admin.get_task(&task_id).await.unwrap();
    assert_eq!(task.state.as_str(), "queued");
    assert_eq!(task.conversation_id.as_deref(), Some(conversation.as_str()));
    env.stack.stop().await;
}

/// Replays, duplicate event ids, own-origin echoes and notices never create canonical messages, and a forged
/// homeserver token is refused.
#[tokio::test]
async fn replays_echoes_and_forged_deliveries_are_inert() {
    let env = MxEnv::start().await;
    let author = env.stack.requester("agent/author", &[], SideEffects::Read).await;
    let _alice = env.human("alice", "@alice:hs.test", human_perms()).await;
    let conversation = env.conversation(&author, "Replay room", &[("human", "alice")], None).await;
    author.client.send_message(&json!({"conversationId": conversation, "content": {"mediaType": "text/plain", "data": "first"}})).await.unwrap();
    let room = env.wait_room("Replay room").await;
    env.mx.join_invites("@alice:hs.test");

    let event = env.mx.user_send_text(&room, "@alice:hs.test", "say it once", &[]);
    eventually("message ingested", Duration::from_secs(10), || async {
        canonical_messages(&env, &author, &conversation).await.iter().any(|m| m["content"]["data"] == "say it once").then_some(())
    })
    .await;
    // the homeserver redelivers the same transaction and, later, the same event in a new transaction
    assert_eq!(env.mx.push_transaction("replay-1", vec![event.to_json()], None).await, 200);
    assert_eq!(env.mx.push_transaction("replay-1", vec![event.to_json()], None).await, 200);
    assert_eq!(env.mx.push_transaction("replay-2", vec![event.to_json()], None).await, 200);
    let count = |msgs: &Vec<Value>| msgs.iter().filter(|m| m["content"]["data"] == "say it once").count();
    assert_eq!(count(&canonical_messages(&env, &author, &conversation).await), 1);

    // with echo on, the bridge's own notices/virtual-user messages come back as events: they must be ignored
    let before = canonical_messages(&env, &author, &conversation).await.len();
    tokio::time::sleep(Duration::from_millis(600)).await;
    let after = canonical_messages(&env, &author, &conversation).await;
    assert_eq!(after.iter().filter(|m| m["labels"]["transport"] == "matrix").count(), 1, "only alice's human message was ingested");
    assert_eq!(after.len(), before);

    // a notice from a human client is never actionable either
    let notice = json!({"event_id": "$n1:hs.test", "room_id": room, "sender": "@alice:hs.test", "type": "m.room.message", "content": {"msgtype": "m.notice", "body": "!task code.review {}"}, "origin_server_ts": chrono::Utc::now().timestamp_millis()});
    assert_eq!(env.mx.push_transaction("notice-1", vec![notice], None).await, 200);

    assert_eq!(env.mx.push_transaction("forged-1", vec![event.to_json()], Some("not-the-hs-token")).await, 403);
    env.stack.stop().await;
}

/// AppService compromise response: tokens rotate without restarting anything, and the homeserver-side rule that an
/// appservice may only masquerade inside its exclusive namespace holds.
#[tokio::test]
async fn token_rotation_and_namespace_confinement() {
    let env = MxEnv::start().await;
    let author = env.stack.requester("agent/author", &[], SideEffects::Read).await;
    let _alice = env.human("alice", "@alice:hs.test", human_perms()).await;
    let conversation = env.conversation(&author, "Rotation room", &[("human", "alice")], None).await;
    author.client.send_message(&json!({"conversationId": conversation, "content": {"mediaType": "text/plain", "data": "before rotation"}})).await.unwrap();
    let room = env.wait_room("Rotation room").await;
    env.mx.join_invites("@alice:hs.test");

    // masquerading as a real user outside the namespace is refused by the homeserver
    let http = reqwest::Client::new();
    let resp = http
        .post(format!("{}/_matrix/client/v3/rooms/{}/join?user_id=%40alice%3Ahs.test", env.mx.url, room.replace('!', "%21").replace(':', "%3A")))
        .bearer_auth(AS_TOKEN)
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 403);

    let bridge = somework_matrix::running_bridge(&env.stack.domain().cfg.database_path.to_string_lossy()).unwrap();
    env.mx.rotate_tokens("as_rotated", "hs_rotated");
    // the old homeserver token no longer authenticates deliveries; the new one does after rotation on our side
    let ev = json!({"event_id": "$x:hs.test", "room_id": room, "sender": "@alice:hs.test", "type": "m.room.message", "content": {"msgtype": "m.text", "body": "after rotation"}, "origin_server_ts": chrono::Utc::now().timestamp_millis()});
    assert_eq!(env.mx.push_transaction("rot-old", vec![ev.clone()], Some(HS_TOKEN)).await, 200, "bridge still holds the old token until rotated");
    bridge.rotate_tokens("as_rotated", "hs_rotated", false);
    assert_eq!(env.mx.push_transaction("rot-old2", vec![ev.clone()], Some(HS_TOKEN)).await, 403, "the previous token is dead after rotation");
    assert_eq!(env.mx.push_transaction("rot-new", vec![ev], Some("hs_rotated")).await, 200);

    // projection works again with the new appservice token
    author.client.send_message(&json!({"conversationId": conversation, "content": {"mediaType": "text/plain", "data": "after rotation again"}})).await.unwrap();
    eventually_events(&env.mx, &room, "projection after rotation", |e| e.body().contains("after rotation again")).await;
    eventually("message ingested after rotation", Duration::from_secs(10), || async {
        canonical_messages(&env, &author, &conversation).await.iter().any(|m| m["content"]["data"] == "after rotation").then_some(())
    })
    .await;
    env.stack.stop().await;
}
