mod matrix_common;

use matrix_common::*;
use serde_json::json;

/// Acceptance: humans can follow an exchange between agents in a readable room, with every projected event
/// carrying a canonical reference that resolves to the platform's message (Matrix is a view, not the source of truth).
#[tokio::test]
async fn conversation_is_followable_in_a_room_with_canonical_references() {
    let env = MxEnv::start().await;
    let worker = env.stack.worker("agent/reviewer", vec![review_cap()], worker_perms()).await;
    let author = env.stack.requester("agent/author").await;
    let alice = env.human("alice", "@alice:hs.test", human_perms()).await;

    let conversation = env.conversation(&author, "PR 729 review", &[("human", "alice"), ("agent", "agent/reviewer")], None).await;
    let request = author
        .client
        .send_message(&json!({"conversationId": conversation, "recipients": [{"kind": "agent", "id": "agent/reviewer"}], "content": {"mediaType": "text/plain", "data": "Please review PR 729"}}))
        .await
        .unwrap();
    let request_id = request["messageId"].as_str().unwrap().to_string();

    let room = env.wait_room("PR 729 review").await;
    assert!(env.mx.members(&room).iter().any(|(u, _)| u == "@alice:hs.test"), "the mapped human is invited to the room");
    env.mx.join_invites("@alice:hs.test");

    let root = eventually_events(&env.mx, &room, "request", |e| e.content["dev.somework.ref"]["id"] == request_id.as_str()).await;
    assert_eq!(root.content["dev.somework.ref"]["type"], "message");
    assert_eq!(root.content["msgtype"], "m.text");
    assert_eq!(root.content["dev.somework.sender"]["id"], "agent/author");

    let answer = worker
        .client
        .send_message(&json!({"conversationId": conversation, "replyTo": request_id, "recipients": [{"kind": "agent", "id": "agent/author"}], "content": {"mediaType": "text/plain", "data": "Looks good, one nit in the parser"}}))
        .await
        .unwrap();
    let answer_id = answer["messageId"].as_str().unwrap().to_string();
    let reply = eventually_events(&env.mx, &room, "reply projected", |e| e.content["dev.somework.ref"]["id"] == answer_id.as_str()).await;
    assert_eq!(reply.content["m.relates_to"]["m.in_reply_to"]["event_id"], root.event_id.as_str(), "replies stay linked to what they answer");

    // the reference resolves to the platform's message
    let canonical = author.client.get(&format!("/v1/messages/{answer_id}")).await.unwrap();
    assert_eq!(canonical["content"]["data"], "Looks good, one nit in the parser");
    let _ = alice;
    env.stack.stop().await;
}

/// Agent identities appear as Application Service virtual users with their own display names.
#[tokio::test]
async fn agents_are_virtual_users_in_the_exclusive_namespace() {
    let env = MxEnv::start().await;
    let worker = env.stack.worker("agent/reviewer", vec![review_cap()], worker_perms()).await;
    let alice = env.human("alice", "@alice:hs.test", human_perms()).await;
    let conversation = {
        let v = alice
            .client
            .post("/v1/conversations", &json!({"kind": "room", "title": "Review chat", "members": [{"kind": "agent", "id": "agent/reviewer"}]}))
            .await
            .unwrap();
        v["conversationId"].as_str().unwrap().to_string()
    };
    worker.client.send_message(&json!({"conversationId": conversation, "content": {"mediaType": "text/plain", "data": "Hello from the reviewer"}, "recipients": [{"kind": "human", "id": "alice"}]})).await.unwrap();
    let room = env.wait_room("Review chat").await;
    let said = eventually_events(&env.mx, &room, "agent chat", |e| e.body() == "Hello from the reviewer").await;
    assert_eq!(said.sender, "@_agent_agent=2freviewer:hs.test");
    assert_eq!(said.content["msgtype"], "m.text");
    assert_eq!(env.mx.display_name(&said.sender).as_deref(), Some("agent/reviewer"));
    env.stack.stop().await;
}
