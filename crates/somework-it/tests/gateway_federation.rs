mod gateway_support;

use std::time::Duration;

use gateway_support::*;
use serde_json::json;
use somework_core::{contracts::SideEffects, fsm::TaskState};

#[tokio::test]
async fn exported_capability_is_invoked_across_domains_without_exposing_the_fleet() {
    let (pair, diag) = standard_pair().await;
    let author = pair.dev.requester("agent/author", &["ops.diagnose"], SideEffects::Read).await;

    // discovery by intent on the *local* catalog finds the remote capability, never the remote agent id
    let found = author.client.catalog_search(&json!({"query": "diagnose a deployment failure", "limit": 5})).await.unwrap();
    let agent_id = found["matches"][0]["agentId"].as_str().expect("a match").to_string();
    assert!(agent_id.starts_with("remote:operations/export-"), "got {agent_id}");
    assert!(!agent_id.contains("diagnostician"));

    let submitted = author.client.submit_task(&task_body("ops.diagnose"), Some("diagnose-1")).await.unwrap();
    assert_eq!(submitted.state, TaskState::Submitted, "stays submitted until the remote gateway accepts");

    let remote_id = run_worker_once(&diag, json!({"verdict": "approve"})).await;

    let done = author.client.wait_terminal(&submitted.task_id, Duration::from_secs(15)).await.unwrap();
    assert_eq!(done.state, TaskState::Succeeded, "{done:?}");
    assert_eq!(done.result.unwrap()["verdict"], "approve");

    // remote side: the task was requested by the development gateway principal, never by a development agent
    let remote = pair.ops.admin.get("/v1/admin/tasks").await.unwrap();
    let t = remote["tasks"].as_array().unwrap().iter().find(|t| t["taskId"] == remote_id).expect("remote task");
    assert_eq!(t["requester"]["id"], "gateway:development");

    // mapping table records both sides
    let mapped: (String, String) = sqlx_row(&pair.dev, &submitted.task_id).await;
    assert_eq!(mapped.0, "operations");
    assert_eq!(mapped.1, remote_id);
    pair.stop().await;
}

async fn sqlx_row(stack: &somework_testkit::Stack, task_id: &str) -> (String, String) {
    use somework_domain::db::scol;
    use sqlx::Row;
    let row = sqlx::query("SELECT peer_domain_id, external_task_id FROM federated_tasks WHERE internal_task_id = ?")
        .bind(task_id)
        .fetch_one(stack.domain().db.pool())
        .await
        .unwrap();
    let _ = row.len();
    (scol(&row, "peer_domain_id"), scol(&row, "external_task_id"))
}
