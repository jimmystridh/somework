use std::time::Duration;

use serde_json::{Value, json};
use somework_core::contracts::{ActorKind, SideEffects};
use somework_domain::policy::Permissions;
use somework_testkit::{
    Stack, capability,
    sidecar::{McpProcess, WorkerProcess, agent_key_file, write_script},
};

const TOOLS: [&str; 18] = [
    "collab_catalog_search",
    "collab_agent_get",
    "collab_message_send",
    "collab_task_submit",
    "collab_task_get",
    "collab_task_claim",
    "collab_task_progress",
    "collab_task_input",
    "collab_task_complete",
    "collab_task_fail",
    "collab_task_cancel",
    "collab_context_create",
    "collab_context_offer",
    "collab_context_accept",
    "collab_artifact_begin_upload",
    "collab_artifact_complete_upload",
    "collab_artifact_get",
    "collab_subscribe",
];

fn worker_perms(se: SideEffects) -> Permissions {
    let mut p = Permissions::default_agent();
    p.side_effects_at_most = Some(se);
    p
}

#[tokio::test]
async fn handshake_lists_exactly_the_spec_tools_with_schemas() {
    let stack = Stack::start().await;
    let author = stack.requester("agent/author", &["code.review"], SideEffects::Read).await;
    let keys = agent_key_file(stack.dir.path(), &author);
    let mut mcp = McpProcess::spawn(&stack.url, &keys, &[]).await;

    let listed = mcp.request("tools/list", json!({})).await;
    let tools = listed["result"]["tools"].as_array().unwrap();
    let mut names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    names.sort();
    let mut expected = TOOLS.to_vec();
    expected.sort();
    assert_eq!(names, expected);
    for t in tools {
        assert_eq!(t["inputSchema"]["type"], "object", "{}", t["name"]);
        assert!(t["description"].as_str().unwrap().len() > 10);
    }
    assert!(mcp.request("ping", json!({})).await["result"].is_object());
    let unknown = mcp.request("nope/method", json!({})).await;
    assert_eq!(unknown["error"]["code"], -32601);
    let templates = mcp.request("resources/templates/list", json!({})).await;
    assert_eq!(templates["result"]["resourceTemplates"].as_array().unwrap().len(), 5);
    stack.stop().await;
}

#[tokio::test]
async fn discovery_submit_result_without_any_transport_credentials() {
    let stack = Stack::start().await;
    let worker = stack
        .worker(
            "agent/reviewer",
            vec![capability("code.review", "2.1", "read", "Review pull requests for correctness and security")],
            worker_perms(SideEffects::Read),
        )
        .await;
    let author = stack.requester("agent/author", &["code.review"], SideEffects::Read).await;
    let dir = stack.dir.path();
    let adapter = write_script(
        dir,
        "review.sh",
        r#"cat >/dev/null; echo '{"type":"progress","message":"reading the diff"}'; echo '{"type":"result","result":{"verdict":"approve"}}'"#,
    );
    let mut worker_proc = WorkerProcess::spawn(&stack.url, &agent_key_file(dir, &worker), &adapter, 10);

    let mut mcp = McpProcess::spawn(&stack.url, &agent_key_file(dir, &author), &[]).await;
    let found = mcp.ok("collab_catalog_search", json!({"query": "Review a pull request for correctness and security", "limit": 3})).await;
    assert_eq!(found["matches"][0]["agentId"], "agent/reviewer");

    let task = mcp.ok("collab_task_submit", json!({"capability": {"id": "code.review", "version": "2.1"}, "input": {"repository": "billing/import-service", "commit": "61a8d52"}, "idempotencyKey": "mcp-review-1"})).await;
    let done = mcp.ok("collab_task_get", json!({"taskId": task["taskId"], "waitSeconds": 20})).await;
    assert_eq!(done["state"], "succeeded", "{done}");
    assert_eq!(done["result"]["verdict"], "approve");

    let again = mcp.ok("collab_task_submit", json!({"capability": {"id": "code.review", "version": "2.1"}, "input": {"repository": "billing/import-service", "commit": "61a8d52"}, "idempotencyKey": "mcp-review-1"})).await;
    assert_eq!(again["taskId"], task["taskId"], "idempotent submit through MCP");

    // the model never sees tokens or infrastructure credentials
    for needle in ["\"authorizationToken\"", "eyJ", "nats://", "password"] {
        assert!(!mcp.transcript.contains(needle), "MCP output leaked {needle}");
    }
    worker_proc.kill9().await;
    stack.stop().await;
}

#[tokio::test]
async fn errors_map_to_problem_codes() {
    let stack = Stack::start().await;
    let _worker = stack
        .worker(
            "agent/deployer",
            vec![capability("deploy.run", "1", "write", "Deploys a service"), capability("code.review", "2.1", "read", "Review pull requests")],
            {
                let mut p = worker_perms(SideEffects::Write);
                p.capabilities = vec![];
                p
            },
        )
        .await;
    let author = stack.requester("agent/author", &["deploy.run", "code.review"], SideEffects::Read).await;
    let mut mcp = McpProcess::spawn(&stack.url, &agent_key_file(stack.dir.path(), &author), &[]).await;

    // side-effect class above the caller's maximum -> policy_denied
    let (is_err, denied) = mcp.tool("collab_task_submit", json!({"capability": {"id": "deploy.run", "version": "1"}, "input": {"repository": "x"}})).await;
    assert!(is_err);
    assert_eq!(denied["code"], "policy_denied", "{denied}");

    // schema violation (missing required property)
    let (is_err, bad) = mcp.tool("collab_task_submit", json!({"capability": {"id": "code.review", "version": "2.1"}, "input": {}})).await;
    assert!(is_err);
    assert_eq!(bad["code"], "schema_violation", "{bad}");

    // stale revision
    let ok = mcp.ok("collab_task_submit", json!({"capability": {"id": "code.review", "version": "2.1"}, "input": {"repository": "r"}})).await;
    let (is_err, stale) = mcp.tool("collab_task_cancel", json!({"taskId": ok["taskId"], "expectedRevision": 99})).await;
    assert!(is_err);
    assert_eq!(stale["code"], "stale_revision", "{stale}");

    // unknown tool is a tool error, not a transport error
    let (is_err, unknown) = mcp.tool("collab_nope", json!({})).await;
    assert!(is_err);
    assert_eq!(unknown["code"], "not_found");
    stack.stop().await;
}

#[tokio::test]
async fn agent_friendly_search_text_upload_and_shorthand_context() {
    let stack = Stack::start().await;
    let _worker = stack.worker("agent/reviewer", vec![capability("code.review", "2.1", "read", "Review pull requests")], worker_perms(SideEffects::Read)).await;
    let author = stack.requester("agent/author", &["code.review"], SideEffects::Read).await;
    let mut mcp = McpProcess::spawn(&stack.url, &agent_key_file(stack.dir.path(), &author), &[]).await;

    let found = mcp.ok("collab_catalog_search", json!({"query": "review"})).await;
    let capability = &found["matches"][0]["capabilities"][0];
    assert_eq!(capability["id"], "code.review", "{found}");
    assert!(capability["inputSchema"].is_object(), "search results must carry the input schema: {found}");

    let up = mcp.ok("collab_artifact_begin_upload", json!({"filename": "notes.txt", "text": "plain text", "classification": "internal"})).await;
    assert_eq!(up["sizeBytes"], 10, "{up}");

    let pack = mcp.ok("collab_context_create", json!({"objective": "Look into the flaky test", "facts": ["fails on CI only"]})).await;
    assert!(pack["contextPackId"].is_string(), "{pack}");
    stack.stop().await;
}

#[tokio::test]
async fn resources_expose_agents_tasks_contexts_artifacts_and_conversations() {
    let stack = Stack::start().await;
    let _worker = stack.worker("agent/reviewer", vec![capability("code.review", "2.1", "read", "Review")], worker_perms(SideEffects::Read)).await;
    let author = stack.requester("agent/author", &["code.review"], SideEffects::Read).await;
    let mut mcp = McpProcess::spawn(&stack.url, &agent_key_file(stack.dir.path(), &author), &[]).await;

    let agent = mcp.request("resources/read", json!({"uri": "somework://catalog/agents/agent%2Freviewer"})).await;
    let text = agent["result"]["contents"][0]["text"].as_str().unwrap();
    assert!(text.contains("agent/reviewer"));

    let task = mcp.ok("collab_task_submit", json!({"capability": {"id": "code.review", "version": "2.1"}, "input": {"repository": "r"}})).await;
    let task_id = task["taskId"].as_str().unwrap();
    let res = mcp.request("resources/read", json!({"uri": format!("somework://tasks/{task_id}")})).await;
    let v: Value = serde_json::from_str(res["result"]["contents"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(v["taskId"], task_id);
    assert_eq!(v["state"], "queued");

    let conv = task["conversationId"].as_str().unwrap();
    let summary = mcp.request("resources/read", json!({"uri": format!("somework://conversations/{conv}/summary")})).await;
    let s: Value = serde_json::from_str(summary["result"]["contents"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(s["conversationId"], conv);
    assert!(s["messageCount"].as_i64().unwrap() >= 1);

    // context pack via tool, then as resource
    let now = chrono::Utc::now().to_rfc3339();
    let pack = mcp
        .ok(
            "collab_context_create",
            json!({"pack": {
                "schemaVersion": "1.0", "objective": "Investigate the regression",
                "currentState": {"summary": "s", "completed": [], "remaining": ["x"]},
                "requestedContinuation": {"mode": "consultation", "instruction": "look"},
                "security": {"classification": "internal", "allowedDomains": ["development"], "instructionsTrusted": false},
                "provenance": {"createdBy": {"kind": "agent", "id": "agent/author", "domainId": "development"}}, "createdAt": now}}),
        )
        .await;
    let uri = format!("somework://contexts/{}/versions/{}", pack["contextPackId"].as_str().unwrap(), pack["version"]);
    let ctx = mcp.request("resources/read", json!({"uri": uri})).await;
    assert!(ctx["result"]["contents"][0]["text"].as_str().unwrap().contains("Investigate the regression"));

    // artifact upload performed by the sidecar, verified server-side, readable as metadata resource
    use sha2::{Digest, Sha256};
    let bytes = b"hello artifact";
    let up = mcp
        .ok(
            "collab_artifact_begin_upload",
            json!({"filename": "a.txt", "mediaType": "text/plain", "sizeBytes": bytes.len(), "sha256": hex::encode(Sha256::digest(bytes)), "classification": "internal", "contentBase64": base64_encode(bytes)}),
        )
        .await;
    assert_eq!(up["sizeBytes"], bytes.len());
    let meta = mcp
        .request("resources/read", json!({"uri": format!("somework://artifacts/{}/versions/{}/metadata", up["artifactId"].as_str().unwrap(), up["version"])}))
        .await;
    assert!(meta["result"]["contents"][0]["text"].as_str().unwrap().contains("a.txt"));
    let got = mcp.ok("collab_artifact_get", json!({"artifactId": up["artifactId"], "version": up["version"], "includeContent": true})).await;
    assert_eq!(got["contentBase64"], base64_encode(bytes));

    let missing = mcp.request("resources/read", json!({"uri": "somework://tasks/task_nope"})).await;
    assert_eq!(missing["error"]["code"], -32002);
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
    perms.actions = ["catalog.read", "task.submit", "task.read"].map(String::from).to_vec();
    let key = stack.create_principal(ActorKind::Agent, "agent/limited", perms).await;
    let dir = stack.dir.path();
    let path = somework_testkit::sidecar::write_key_file(dir, "agent", "agent/limited", &stack.domain_id, &key);
    let mut mcp = McpProcess::spawn(&stack.url, &path, &[]).await;
    let listed = mcp.request("tools/list", json!({})).await;
    let names: Vec<&str> = listed["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"collab_catalog_search") && names.contains(&"collab_task_submit") && names.contains(&"collab_task_get"));
    for hidden in ["collab_task_claim", "collab_task_complete", "collab_artifact_begin_upload", "collab_context_create", "collab_message_send"] {
        assert!(!names.contains(&hidden), "{hidden} should be hidden");
    }
    let (is_err, denied) = mcp.tool("collab_task_claim", json!({"taskId": "task_x"})).await;
    assert!(is_err);
    assert_eq!(denied["code"], "policy_denied");
    stack.stop().await;
}

#[tokio::test]
async fn claim_through_mcp_hides_the_task_grant_and_the_sidecar_keeps_the_lease_alive() {
    let stack = Stack::start().await;
    let worker = stack.worker("agent/reviewer", vec![capability("code.review", "2.1", "read", "Review")], worker_perms(SideEffects::Read)).await;
    let author = stack.requester("agent/author", &["code.review"], SideEffects::Read).await;
    let dir = stack.dir.path();
    let task = author.client.submit_task(&json!({"capability": {"id": "code.review", "version": "2.1"}, "input": {"repository": "r"}}), None).await.unwrap();

    let mut mcp = McpProcess::spawn(&stack.url, &agent_key_file(dir, &worker), &[]).await;
    let claimed = mcp.ok("collab_task_claim", json!({"taskId": task.task_id, "leaseSeconds": 2})).await;
    let fence = claimed["fencingToken"].as_u64().unwrap();
    assert!(claimed.get("authorizationToken").is_none(), "the task grant stays inside the sidecar");
    assert!(!mcp.transcript.contains("eyJ"));

    // longer than the 2 s lease: only the sidecar's keep-alive can have kept the task ours
    tokio::time::sleep(Duration::from_millis(4500)).await;
    mcp.ok("collab_task_progress", json!({"taskId": task.task_id, "fencingToken": fence, "message": "still working"})).await;
    let done = mcp.ok("collab_task_complete", json!({"taskId": task.task_id, "fencingToken": fence, "result": {"verdict": "reject"}})).await;
    assert_eq!(done["state"], "succeeded");
    // stale token after completion is refused
    let (is_err, stale) = mcp.tool("collab_task_progress", json!({"taskId": task.task_id, "fencingToken": fence, "message": "late"})).await;
    assert!(is_err, "{stale}");
    stack.stop().await;
}
