//! A2A import and egress: a SomeWork domain invokes an external A2A agent (here another SomeWork gateway).

mod gateway_support;

use std::time::Duration;

use gateway_support::*;
use serde_json::json;
use somework_core::{contracts::SideEffects, fsm::TaskState, jws};

#[tokio::test]
async fn imported_a2a_agent_is_invoked_through_the_a2a_client() {
    let (ops, worker) = a2a_stack("operations").await;
    let (dev, _) = a2a_stack("development").await;
    let partner = A2aClient::enrol(&ops, "development-gateway", &["ops.diagnose"]).await;

    // CAT-06: import the external card; it lands as a draft source=a2a entry until approved
    let card_url = format!("{}/.well-known/agent-card.json", ops.url);
    let draft = dev.admin.post("/v1/admin/federation/a2a/import", &json!({"url": card_url})).await.unwrap();
    assert_eq!(draft["approval"]["status"], "draft");
    assert_eq!(draft["source"]["type"], "a2a");
    assert!(draft["source"]["digest"].as_str().is_some());
    let agent_id = draft["agentCard"]["agentId"].as_str().unwrap().to_string();
    assert!(agent_id.starts_with("a2a:127.0.0.1:"));
    dev.admin
        .post(&format!("/v1/agents/{}/approval", agent_id.replace(':', "%3A").replace('/', "%2F")), &json!({"status": "approved", "visibility": "domain"}))
        .await
        .unwrap();

    // credentials for the external origin are sealed in the domain database
    let origin = format!("http://{}", ops.url.trim_start_matches("http://"));
    dev.admin
        .put("/v1/admin/federation/a2a/credentials", &json!({"origin": origin, "scheme": "assertion", "secret": jws::signing_key_to_b64(&partner.key), "issuer": partner.issuer, "audience": partner.audience}))
        .await
        .unwrap();

    let capability_id = draft["agentCard"]["capabilities"][0]["id"].as_str().unwrap().to_string();
    let author = dev.requester("agent/author", &[&capability_id], SideEffects::Write).await;
    let task = author
        .client
        .submit_task(&json!({"capability": {"id": capability_id, "version": "1"}, "input": {"repository": "billing/import-service"}}), None)
        .await
        .unwrap();
    run_worker_once(&worker, json!({"verdict": "approve"})).await;
    let done = author.client.wait_terminal(&task.task_id, Duration::from_secs(20)).await.unwrap();
    assert_eq!(done.state, TaskState::Succeeded, "{done:?}");
    assert_eq!(done.result.unwrap()["verdict"], "approve");

    // the mapping table ties the local task to the external A2A task
    use sqlx::Row;
    let row = sqlx::query(
        "SELECT direction, external_task_id, remote_interface, protocol_version, remote_agent_card_digest FROM federated_tasks WHERE internal_task_id = ?",
    )
    .bind(&task.task_id)
    .fetch_one(dev.domain().db.pool())
    .await
    .unwrap();
    assert_eq!(row.get::<String, _>("direction"), "a2a_out");
    assert!(row.get::<String, _>("remote_interface").ends_with("/a2a"));
    assert_eq!(row.get::<String, _>("protocol_version"), "1.0");
    assert!(row.get::<Option<String>, _>("remote_agent_card_digest").is_some());
    ops.stop().await;
    dev.stop().await;
}

#[tokio::test]
async fn cards_without_an_http_json_interface_are_refused() {
    let (dev, _) = a2a_stack("development").await;
    let card = json!({"name": "rpc-only", "description": "d", "supportedInterfaces": [{"url": "http://x/rpc", "protocolBinding": "JSONRPC", "protocolVersion": "1.0"}], "skills": [{"id": "s", "name": "s", "description": "d"}]});
    let err = dev.admin.post("/v1/admin/federation/a2a/import", &json!({"card": card})).await.unwrap_err();
    assert_eq!(err.status, 422);
    dev.stop().await;
}
