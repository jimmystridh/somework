//! Interoperability with the official Python `a2a-sdk` (HTTP+JSON binding), driven through `uv`.

mod gateway_support;

use std::path::PathBuf;

use gateway_support::*;
use serde_json::{Value, json};

fn project_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/a2a_interop")
}

async fn run_sdk(base: &str, token: &str, scenario: &str, skill: &str) -> Value {
    let out = tokio::process::Command::new("uv")
        .args(["run", "--quiet", "--project"])
        .arg(project_dir())
        .args(["python", "interop.py", base, token, scenario, skill])
        .current_dir(project_dir())
        .output()
        .await
        .expect("run uv (install uv to run the interop test)");
    assert!(out.status.success(), "interop script failed: {}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(&out.stdout).unwrap_or_else(|e| panic!("script output is not JSON ({e}): {}", String::from_utf8_lossy(&out.stdout)))
}

#[tokio::test]
async fn official_sdk_discovers_runs_and_streams() {
    let (stack, worker) = a2a_stack("operations").await;
    let client = A2aClient::enrol(&stack, "sdk-client", &["ops.diagnose"]).await;
    let (base, token) = (stack.url.clone(), client.token());

    // blocking send: the SDK waits for the task while a worker completes it
    let sdk = tokio::spawn({
        let (base, token) = (base.clone(), token.clone());
        async move { run_sdk(&base, &token, "send", "ops.diagnose").await }
    });
    run_worker_once(&worker, json!({"verdict": "approve"})).await;
    let out = sdk.await.unwrap();
    assert_eq!(out["card"]["skills"][0]["id"], "ops.diagnose", "{out}");
    assert_eq!(out["card"]["supportedInterfaces"][0]["protocolBinding"], "HTTP+JSON");
    assert_eq!(out["task"]["status"]["state"], "TASK_STATE_COMPLETED", "{out}");
    assert_eq!(out["task"]["artifacts"][0]["parts"][0]["data"]["verdict"], "approve");

    // streaming
    let sdk = tokio::spawn({
        let (base, token) = (base.clone(), token.clone());
        async move { run_sdk(&base, &token, "stream", "ops.diagnose").await }
    });
    run_worker_once(&worker, json!({"verdict": "reject"})).await;
    let out = sdk.await.unwrap();
    assert!(out["events"].as_array().unwrap().iter().any(|e| e["statusUpdate"]["status"]["state"] == "TASK_STATE_COMPLETED"), "{out}");
    assert_eq!(out["task"]["artifacts"][0]["parts"][0]["data"]["verdict"], "reject");

    // negative: unsupported capability and unsupported protocol version
    let out = run_sdk(&base, &token, "send", "ops.unknown").await;
    assert!(out["error"]["type"].as_str().unwrap().contains("Error"), "{out}");
    let out = run_sdk(&base, &token, "bad-version", "x").await;
    assert_eq!(out["status"], 400);
    assert_eq!(out["body"]["error"]["details"][0]["reason"], "VERSION_NOT_SUPPORTED");
    stack.stop().await;
}
