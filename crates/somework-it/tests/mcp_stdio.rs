use serde_json::{Value, json};
use somework_core::contracts::ActorKind;
use somework_domain::policy::Permissions;
use somework_testkit::{
    Stack, capability,
    sidecar::{McpProcess, agent_key_file},
};

const TOOLS: [&str; 7] = [
    "collab_catalog_search",
    "collab_agent_get",
    "collab_message_send",
    "collab_artifact_begin_upload",
    "collab_artifact_complete_upload",
    "collab_artifact_get",
    "collab_subscribe",
];

#[tokio::test]
async fn handshake_lists_exactly_the_tools_with_schemas() {
    let stack = Stack::start().await;
    let author = stack.requester("agent/author").await;
    let keys = agent_key_file(stack.dir.path(), &author);
    let mut mcp = McpProcess::spawn(&stack.url, &keys, &[]).await;

    let listed = mcp.request("tools/list", json!({})).await;
    let tools = listed["result"]["tools"].as_array().unwrap();
    let mut names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    names.sort();
    let mut expected = TOOLS.to_vec();
    expected.sort();
    assert_eq!(names, expected, "there are no task or context tools any more");
    for t in tools {
        assert_eq!(t["inputSchema"]["type"], "object", "{}", t["name"]);
        assert!(t["description"].as_str().unwrap().len() > 10);
    }
    assert!(mcp.request("ping", json!({})).await["result"].is_object());
    let unknown = mcp.request("nope/method", json!({})).await;
    assert_eq!(unknown["error"]["code"], -32601);
    let templates = mcp.request("resources/templates/list", json!({})).await;
    assert_eq!(templates["result"]["resourceTemplates"].as_array().unwrap().len(), 3);
    stack.stop().await;
}

#[tokio::test]
async fn discovery_and_a_message_without_any_transport_credentials() {
    let stack = Stack::start().await;
    let reviewer = stack
        .worker(
            "agent/reviewer",
            vec![capability("code.review", "2.1", "read", "Review pull requests for correctness and security")],
            Permissions::default_agent(),
        )
        .await;
    let author = stack.requester("agent/author").await;
    let dir = stack.dir.path();

    let mut mcp = McpProcess::spawn(&stack.url, &agent_key_file(dir, &author), &[]).await;
    let found = mcp.ok("collab_catalog_search", json!({"query": "Review a pull request for correctness and security", "limit": 3})).await;
    assert_eq!(found["matches"][0]["agentId"], "agent/reviewer");

    let sent = mcp
        .ok(
            "collab_message_send",
            json!({"recipients": [{"kind": "agent", "id": "agent/reviewer"}], "text": "Please review PR 729", "idempotencyKey": "mcp-review-1"}),
        )
        .await;
    let again = mcp
        .ok(
            "collab_message_send",
            json!({"recipients": [{"kind": "agent", "id": "agent/reviewer"}], "text": "Please review PR 729", "idempotencyKey": "mcp-review-1"}),
        )
        .await;
    assert_eq!(again["messageId"], sent["messageId"], "idempotent send through MCP");
    let (events, _) = reviewer.client.events(0, 0).await.unwrap();
    assert!(events.iter().any(|e| e["type"] == "message.created" && e["wake"] == true), "the reviewer was woken");

    // the model never sees tokens or infrastructure credentials
    for needle in ["\"authorizationToken\"", "eyJ", "nats://", "password"] {
        assert!(!mcp.transcript.contains(needle), "MCP output leaked {needle}");
    }
    stack.stop().await;
}

#[tokio::test]
async fn errors_map_to_problem_codes() {
    let stack = Stack::start().await;
    let _reviewer = stack.worker("agent/reviewer", vec![capability("code.review", "2.1", "read", "Review pull requests")], Permissions::default_agent()).await;
    let author = stack.requester("agent/author").await;
    let mut mcp = McpProcess::spawn(&stack.url, &agent_key_file(stack.dir.path(), &author), &[]).await;

    // a message needs someone to talk to
    let (is_err, nobody) = mcp.tool("collab_message_send", json!({"text": "hello?"})).await;
    assert!(is_err);
    assert_eq!(nobody["code"], "validation_failed", "{nobody}");

    // trigger modes that do not exist any more are refused by the tool's own schema check at the domain
    let (is_err, gone) =
        mcp.tool("collab_message_send", json!({"recipients": [{"kind": "agent", "id": "agent/reviewer"}], "text": "x", "triggerMode": "task-state"})).await;
    assert!(is_err, "{gone}");

    // unknown agent
    let (is_err, missing) = mcp.tool("collab_agent_get", json!({"agentId": "agent/nobody"})).await;
    assert!(is_err);
    assert_eq!(missing["code"], "not_found", "{missing}");

    // unknown tool is a tool error, not a transport error
    let (is_err, unknown) = mcp.tool("collab_task_submit", json!({})).await;
    assert!(is_err);
    assert_eq!(unknown["code"], "not_found");
    stack.stop().await;
}

#[tokio::test]
async fn agent_friendly_search_and_text_upload() {
    let stack = Stack::start().await;
    let _reviewer = stack.worker("agent/reviewer", vec![capability("code.review", "2.1", "read", "Review pull requests")], Permissions::default_agent()).await;
    let author = stack.requester("agent/author").await;
    let mut mcp = McpProcess::spawn(&stack.url, &agent_key_file(stack.dir.path(), &author), &[]).await;

    let found = mcp.ok("collab_catalog_search", json!({"query": "review"})).await;
    let capability = &found["matches"][0]["capabilities"][0];
    assert_eq!(capability["id"], "code.review", "{found}");
    assert!(capability["inputSchema"].is_object(), "search results must carry the input schema: {found}");

    let up = mcp.ok("collab_artifact_begin_upload", json!({"filename": "notes.txt", "text": "plain text", "classification": "internal"})).await;
    assert_eq!(up["sizeBytes"], 10, "{up}");
    stack.stop().await;
}

#[tokio::test]
async fn resources_expose_agents_artifacts_and_conversations_and_an_artifact_travels_with_a_message() {
    let stack = Stack::start().await;
    let reviewer = stack.worker("agent/reviewer", vec![capability("code.review", "2.1", "read", "Review")], Permissions::default_agent()).await;
    let author = stack.requester("agent/author").await;
    let mut mcp = McpProcess::spawn(&stack.url, &agent_key_file(stack.dir.path(), &author), &[]).await;

    let agent = mcp.request("resources/read", json!({"uri": "somework://catalog/agents/agent%2Freviewer"})).await;
    let text = agent["result"]["contents"][0]["text"].as_str().unwrap();
    assert!(text.contains("agent/reviewer"));

    // an artifact stored by the sidecar (hashed and verified server-side), then attached to a message
    use sha2::{Digest, Sha256};
    let bytes = b"hello artifact";
    let up = mcp
        .ok(
            "collab_artifact_begin_upload",
            json!({"filename": "a.txt", "mediaType": "text/plain", "sizeBytes": bytes.len(), "sha256": hex::encode(Sha256::digest(bytes)), "classification": "internal", "contentBase64": base64_encode(bytes)}),
        )
        .await;
    assert_eq!(up["sizeBytes"], bytes.len());
    let mut up = up;
    up.as_object_mut().unwrap().remove("traceId");
    let sent = mcp
        .ok("collab_message_send", json!({"recipients": [{"kind": "agent", "id": "agent/reviewer"}], "text": "see the file", "artifacts": [up.clone()]}))
        .await;
    assert_eq!(sent["artifacts"][0]["artifactId"], up["artifactId"]);

    // the receiver reads the attachment through its own credentials
    let mut theirs = McpProcess::spawn(&stack.url, &agent_key_file(stack.dir.path(), &reviewer), &[]).await;
    let got = theirs.ok("collab_artifact_get", json!({"artifactId": up["artifactId"], "version": up["version"], "includeContent": true})).await;
    assert_eq!(got["contentBase64"], base64_encode(bytes));

    let meta = mcp
        .request("resources/read", json!({"uri": format!("somework://artifacts/{}/versions/{}/metadata", up["artifactId"].as_str().unwrap(), up["version"])}))
        .await;
    assert!(meta["result"]["contents"][0]["text"].as_str().unwrap().contains("a.txt"));

    let conv = sent["conversationId"].as_str().unwrap();
    let summary = mcp.request("resources/read", json!({"uri": format!("somework://conversations/{conv}/summary")})).await;
    let s: Value = serde_json::from_str(summary["result"]["contents"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(s["conversationId"], conv);
    assert_eq!(s["messageCount"], 1);

    let missing = mcp.request("resources/read", json!({"uri": "somework://tasks/task_nope"})).await;
    assert_eq!(missing["error"]["code"], -32002, "there is no task resource any more");
    stack.stop().await;
}

fn base64_encode(b: &[u8]) -> String {
    use base64::{Engine, engine::general_purpose::STANDARD};
    STANDARD.encode(b)
}

#[tokio::test]
async fn tools_the_principal_cannot_use_are_hidden() {
    let stack = Stack::start().await;
    let mut perms = Permissions::default_human();
    perms.actions = ["catalog.read", "message.read"].map(String::from).to_vec();
    let key = stack.create_principal(ActorKind::Agent, "agent/limited", perms).await;
    let dir = stack.dir.path();
    let path = somework_testkit::sidecar::write_key_file(dir, "agent", "agent/limited", &stack.domain_id, &key);
    let mut mcp = McpProcess::spawn(&stack.url, &path, &[]).await;
    let listed = mcp.request("tools/list", json!({})).await;
    let names: Vec<&str> = listed["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"collab_catalog_search") && names.contains(&"collab_subscribe"));
    for hidden in ["collab_message_send", "collab_artifact_begin_upload", "collab_artifact_complete_upload"] {
        assert!(!names.contains(&hidden), "{hidden} should be hidden");
    }
    let (is_err, denied) = mcp.tool("collab_message_send", json!({"recipients": [{"kind": "agent", "id": "agent/x"}], "text": "hi"})).await;
    assert!(is_err);
    assert_eq!(denied["code"], "policy_denied");
    stack.stop().await;
}
