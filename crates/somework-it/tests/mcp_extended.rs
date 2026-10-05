use std::time::Duration;

use serde_json::json;
use somework_core::contracts::SideEffects;
use somework_testkit::{
    Stack,
    sidecar::{McpProcess, agent_key_file},
};

async fn extended(stack: &Stack, id: &str) -> (somework_testkit::Agent, McpProcess) {
    let agent = stack.requester(id, &[], SideEffects::Read).await;
    let mcp = McpProcess::spawn(&stack.url, &agent_key_file(stack.dir.path(), &agent), &["--extended-tools"]).await;
    (agent, mcp)
}

async fn tool_names(mcp: &mut McpProcess) -> Vec<String> {
    mcp.request("tools/list", json!({})).await["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect()
}

#[tokio::test]
async fn extended_tools_are_offered_only_when_enabled() {
    let stack = Stack::start().await;
    let agent = stack.requester("agent/alice", &[], SideEffects::Read).await;
    let mut plain = McpProcess::spawn(&stack.url, &agent_key_file(stack.dir.path(), &agent), &[]).await;
    let names = tool_names(&mut plain).await;
    assert!(!names.contains(&"collab_inbox".to_string()) && !names.contains(&"collab_secret_seal".to_string()));
    let mut with_extended = McpProcess::spawn(&stack.url, &agent_key_file(stack.dir.path(), &agent), &["--extended-tools"]).await;
    let names = tool_names(&mut with_extended).await;
    for expected in [
        "collab_whoami",
        "collab_conversation_list",
        "collab_inbox",
        "collab_inbox_mark_read",
        "collab_events_poll",
        "collab_secret_seal",
        "collab_secret_open",
    ] {
        assert!(names.contains(&expected.to_string()), "{expected} missing");
    }
    // calling an extended tool on a sidecar that did not enable them is refused
    let (is_err, refused) = plain.tool("collab_inbox", json!({})).await;
    assert!(is_err, "{refused}");
    stack.stop().await;
}

#[tokio::test]
async fn direct_messages_inbox_polling_and_read_receipts() {
    let stack = Stack::start().await;
    let (_alice, mut a) = extended(&stack, "agent/alice").await;
    let (_bob, mut b) = extended(&stack, "agent/bob").await;

    let who = a.ok("collab_whoami", json!({})).await;
    assert_eq!(who["id"], "agent/alice");

    let sent = a.ok("collab_message_send", json!({"recipients": [{"kind": "agent", "id": "agent/bob"}], "text": "hello bob"})).await;
    assert!(sent["messageId"].as_str().unwrap().starts_with("msg_"));

    let unread = b.ok("collab_inbox", json!({"unread": true})).await;
    let msgs = unread["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!((msgs[0]["from"].as_str().unwrap(), msgs[0]["text"].as_str().unwrap()), ("agent/alice", "hello bob"));

    b.ok("collab_inbox_mark_read", json!({"messageIds": [msgs[0]["messageId"]]})).await;
    assert!(b.ok("collab_inbox", json!({"unread": true})).await["messages"].as_array().unwrap().is_empty(), "a read receipt removes it from the unread inbox");
    assert_eq!(b.ok("collab_inbox", json!({"unread": false})).await["messages"].as_array().unwrap().len(), 1);

    // polling returns only what is new since the last acknowledged cursor
    let first = b.ok("collab_events_poll", json!({})).await;
    assert!(first["messages"].as_array().unwrap().iter().all(|m| m["text"] == "hello bob"));
    a.ok("collab_message_send", json!({"recipients": [{"kind": "agent", "id": "agent/bob"}], "text": "second"})).await;
    let polled = b.ok("collab_events_poll", json!({"wait": 5})).await;
    let texts: Vec<&str> = polled["messages"].as_array().unwrap().iter().map(|m| m["text"].as_str().unwrap()).collect();
    assert_eq!(texts, ["second"]);
    assert!(b.ok("collab_events_poll", json!({})).await["messages"].as_array().unwrap().is_empty());

    // the feed is live (a session's first poll starts at now) and never echoes the caller's own messages
    assert!(a.ok("collab_events_poll", json!({})).await["messages"].as_array().unwrap().is_empty(), "history before the first poll is not replayed");
    a.ok("collab_message_send", json!({"recipients": [{"kind": "agent", "id": "agent/bob"}], "text": "third"})).await;
    assert!(a.ok("collab_events_poll", json!({})).await["messages"].as_array().unwrap().is_empty(), "own messages are excluded");
    b.ok("collab_message_send", json!({"recipients": [{"kind": "agent", "id": "agent/alice"}], "text": "reply"})).await;
    let from_bob = a.ok("collab_events_poll", json!({"wait": 5})).await;
    let texts: Vec<&str> = from_bob["messages"].as_array().unwrap().iter().map(|m| m["text"].as_str().unwrap()).collect();
    assert_eq!(texts, ["reply"]);
    stack.stop().await;
}

#[tokio::test]
async fn open_rooms_can_be_discovered_joined_and_left() {
    let stack = Stack::start().await;
    let (_alice, mut a) = extended(&stack, "agent/alice").await;
    let (_bob, mut b) = extended(&stack, "agent/bob").await;

    let created = a.ok("collab_conversation_create", json!({"title": "general", "open": true})).await;
    let room = created["conversationId"].as_str().unwrap().to_string();
    let visible = b.ok("collab_conversation_list", json!({"open": true})).await;
    assert!(visible["conversations"].as_array().unwrap().iter().any(|c| c["title"] == "general"), "open rooms are discoverable");

    b.ok("collab_conversation_join", json!({"conversation": "general"})).await;
    b.ok("collab_message_send", json!({"conversationId": room, "text": "hi all"})).await;
    let inbox = a.ok("collab_inbox", json!({"unread": true})).await;
    assert!(inbox["messages"].as_array().unwrap().iter().any(|m| m["text"] == "hi all" && m["from"] == "agent/bob"));

    b.ok("collab_conversation_leave", json!({"conversation": "general"})).await;
    let (is_err, denied) = b.tool("collab_message_send", json!({"conversationId": room, "text": "after leaving"})).await;
    assert!(is_err, "{denied}");
    stack.stop().await;
}

#[tokio::test]
async fn sealed_secrets_are_recipient_bound_one_time_and_short_lived() {
    let stack = Stack::start().await;
    let (_alice, mut a) = extended(&stack, "agent/alice").await;
    let (_bob, mut b) = extended(&stack, "agent/bob").await;
    let (_carol, mut c) = extended(&stack, "agent/carol").await;

    let sealed = a.ok("collab_secret_seal", json!({"to": "agent/bob", "secret": "s3cret-value-123", "ttlSeconds": 300, "label": "db password"})).await;
    let id = sealed["secretId"].as_str().unwrap().to_string();

    // the server stores only ciphertext
    for entry in std::fs::read_dir(stack.dir.path()).unwrap().flatten() {
        if entry.file_name().to_string_lossy().starts_with("somework.db") {
            let bytes = std::fs::read(entry.path()).unwrap();
            assert!(!bytes.windows(16).any(|w| w == b"s3cret-value-123"), "plaintext must never reach the database");
        }
    }
    let pending = b.ok("collab_secret_list", json!({})).await;
    assert_eq!(pending["secrets"][0]["secretId"], id.as_str());
    assert!(pending["secrets"][0].get("envelope").is_none());

    // wrong recipient
    let (is_err, wrong) = c.tool("collab_secret_open", json!({"secretId": id})).await;
    assert!(is_err);
    assert_eq!(wrong["code"], "not_found");

    let opened = b.ok("collab_secret_open", json!({"secretId": id})).await;
    assert_eq!(opened["secret"], "s3cret-value-123");
    assert_eq!(opened["from"], "agent:agent/alice");

    // one-time read
    let (is_err, again) = b.tool("collab_secret_open", json!({"secretId": id})).await;
    assert!(is_err);
    assert_eq!(again["code"], "expired");

    // short TTL
    let quick = a.ok("collab_secret_seal", json!({"to": "agent/bob", "secret": "ephemeral", "ttlSeconds": 1})).await;
    tokio::time::sleep(Duration::from_millis(2300)).await;
    let (is_err, late) = b.tool("collab_secret_open", json!({"secretId": quick["secretId"]})).await;
    assert!(is_err);
    assert_eq!(late["code"], "expired");

    // audit shows who sealed/opened what, never the payload
    let audit = stack.admin.get("/v1/admin/audit?limit=500").await.unwrap().to_string();
    assert!(audit.contains("sealed.seal") && audit.contains("sealed.unseal"));
    assert!(!audit.contains("s3cret-value-123") && !audit.contains("ephemeral"));
    // nothing sealed ever appears in the sender's MCP output
    assert!(!a.transcript.contains("s3cret-value-123"));
    stack.stop().await;
}
