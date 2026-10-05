mod matrix_common;

use std::time::Duration;

use matrix_common::*;
use serde_json::json;
use somework_core::contracts::SideEffects;
use somework_domain::policy::Permissions;
use somework_testkit::{Agent, process::eventually};

struct Deploy {
    env: MxEnv,
    author: Agent,
    room: String,
}

fn approver_perms(approves: &[&str]) -> Permissions {
    let mut p = Permissions::default_human();
    p.approves = approves.iter().map(|s| s.to_string()).collect();
    p
}

async fn setup() -> Deploy {
    let env = MxEnv::start().await;
    let _deployer = env
        .stack
        .worker(
            "agent/deployer",
            vec![somework_testkit::capability("deployment.execute", "1.0", "irreversible", "Execute a production deployment")],
            worker_perms(SideEffects::Irreversible),
        )
        .await;
    let author = env.stack.requester("agent/author", &["deployment.execute"], SideEffects::Irreversible).await;
    env.human("carol", "@carol:hs.test", approver_perms(&["deployment.*"])).await;
    env.human("dave", "@dave:hs.test", approver_perms(&[])).await;
    let conversation = env.conversation(&author, "Prod deploy", &[("human", "carol"), ("human", "dave")], None).await;
    author.client.send_message(&json!({"conversationId": conversation, "content": {"mediaType": "text/plain", "data": "deploy window opens"}})).await.unwrap();
    let room = env.wait_room("Prod deploy").await;
    env.mx.join_invites("@carol:hs.test");
    env.mx.join_invites("@dave:hs.test");
    Deploy { env, author, room }
}

async fn conversation_id(d: &Deploy) -> String {
    let rooms = d.env.stack.domain().mapping_by_external("matrix", &d.room).await.unwrap().unwrap();
    rooms.object_id
}

async fn request_deploy(d: &Deploy) -> (String, String) {
    let task = d
        .author
        .client
        .submit_task(&json!({"capability": {"id": "deployment.execute", "version": "1.0"}, "conversationId": conversation_id(d).await, "input": {"repository": "billing/import-service", "commit": "61a8d52"}}), None)
        .await
        .unwrap();
    assert_eq!(task.state.as_str(), "submitted", "irreversible work waits for a structured human approval");
    let approval_id = task.pending_approval.as_ref().unwrap()["approvalId"].as_str().unwrap().to_string();
    (task.task_id, approval_id)
}

async fn prompt_event(d: &Deploy, approval_id: &str) -> String {
    let e = eventually_events(&d.env.mx, &d.room, "approval prompt", |e| e.body().contains("Approval required") && e.body().contains(approval_id)).await;
    e.event_id
}

#[tokio::test]
async fn reaction_approves_exactly_the_requested_action() {
    let d = setup().await;
    let (task_id, approval_id) = request_deploy(&d).await;
    let prompt = prompt_event(&d, &approval_id).await;
    let structured = eventually_events(&d.env.mx, &d.room, "structured approval event", |e| {
        e.kind == "dev.somework.approval.v1" && e.content["approval_id"] == approval_id.as_str()
    })
    .await;
    assert_eq!(structured.content["task_revision"], 1);
    assert!(structured.content["action_digest"].as_str().unwrap().len() == 64);

    d.env.mx.react(&d.room, "@carol:hs.test", &prompt, "👍");
    eventually("task queued after the approval", Duration::from_secs(10), || async {
        (d.env.stack.admin.get_task(&task_id).await.unwrap().state.as_str() == "queued").then_some(())
    })
    .await;
    let audit = d.env.stack.admin.get("/v1/admin/audit?limit=500").await.unwrap();
    assert!(
        audit["events"].as_array().unwrap().iter().any(|e| e["action"] == "approval.decide" && e["authenticatedActor"] == "human:carol"),
        "the decision is attributed to the mapped human"
    );
    d.env.stack.stop().await;
}

#[tokio::test]
async fn thumbs_down_rejects_the_task() {
    let d = setup().await;
    let (task_id, approval_id) = request_deploy(&d).await;
    let prompt = prompt_event(&d, &approval_id).await;
    d.env.mx.react(&d.room, "@carol:hs.test", &prompt, "👎");
    eventually("rejected", Duration::from_secs(10), || async {
        (d.env.stack.admin.get_task(&task_id).await.unwrap().state.as_str() == "rejected").then_some(())
    })
    .await;
    d.env.stack.stop().await;
}

#[tokio::test]
async fn stale_unauthorized_and_expired_reactions_do_not_approve() {
    let d = setup().await;

    // unauthorized approver (not allowed to approve deployments) and a 👍 on an unrelated message are inert
    let (task_a, approval_a) = request_deploy(&d).await;
    let prompt_a = prompt_event(&d, &approval_a).await;
    d.env.mx.react(&d.room, "@dave:hs.test", &prompt_a, "👍");
    eventually_events(&d.env.mx, &d.room, "unauthorized notice", |e| e.body().starts_with("Approval not applied")).await;
    assert_eq!(d.env.stack.admin.get_task(&task_a).await.unwrap().state.as_str(), "submitted");

    // stale: the task is canceled after the prompt, so the old prompt no longer approves anything
    d.author.client.cancel_task(&task_a, Some("changed my mind")).await.unwrap();
    d.env.mx.react(&d.room, "@carol:hs.test", &prompt_a, "👍");
    eventually("stale approval refused", Duration::from_secs(10), || async {
        d.env.mx.events(&d.room).into_iter().find(|e| e.body().starts_with("Approval not applied") && e.body().contains("superseded"))
    })
    .await;
    assert_eq!(d.env.stack.admin.get_task(&task_a).await.unwrap().state.as_str(), "canceled");

    // expired: push the expiry into the past, then react
    let (task_b, approval_b) = request_deploy(&d).await;
    let prompt_b = prompt_event(&d, &approval_b).await;
    let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}", d.env.stack.domain().cfg.database_path.display())).await.unwrap();
    sqlx::query("UPDATE approvals SET expires_at = '2000-01-01T00:00:00.000Z' WHERE approval_id = ?").bind(&approval_b).execute(&pool).await.unwrap();
    d.env.mx.react(&d.room, "@carol:hs.test", &prompt_b, "👍");
    eventually("expired approval refused", Duration::from_secs(10), || async {
        d.env.mx.events(&d.room).into_iter().find(|e| e.body().starts_with("Approval not applied") && e.body().contains("expired"))
    })
    .await;
    assert_ne!(d.env.stack.admin.get_task(&task_b).await.unwrap().state.as_str(), "queued");
    d.env.stack.stop().await;
}
