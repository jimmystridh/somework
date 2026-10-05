use std::time::Duration;

use serde_json::json;
use somework_core::{contracts::SideEffects, fsm::TaskState};
use somework_domain::policy::Permissions;
use somework_testkit::{Stack, capability};

fn worker_perms(se: SideEffects) -> Permissions {
    let mut p = Permissions::default_agent();
    p.side_effects_at_most = Some(se);
    p
}

#[tokio::test]
async fn discover_submit_claim_complete_over_http() {
    let stack = Stack::start().await;
    let worker = stack
        .worker(
            "agent/reviewer",
            vec![capability("code.review", "2.1", "read", "Review pull requests for correctness and security")],
            worker_perms(SideEffects::Read),
        )
        .await;
    let author = stack.requester("agent/author", &["code.review"], SideEffects::Read).await;

    // discovery by natural language, without knowing the agent id
    let found = author.client.catalog_search(&json!({"query": "Review a pull request for correctness and security", "limit": 5})).await.unwrap();
    assert_eq!(found["matches"][0]["agentId"], "agent/reviewer");
    assert!(found["traceId"].as_str().unwrap().starts_with("00-"));

    let task = author
        .client
        .submit_task(
            &json!({"capability": {"id": "code.review", "version": "2.1"}, "input": {"repository": "billing/import-service", "commit": "61a8d52"}}),
            Some("review-pr-729"),
        )
        .await
        .unwrap();
    assert_eq!(task.state, TaskState::Queued);
    // idempotent retry returns the same task
    let again = author
        .client
        .submit_task(
            &json!({"capability": {"id": "code.review", "version": "2.1"}, "input": {"repository": "billing/import-service", "commit": "61a8d52"}}),
            Some("review-pr-729"),
        )
        .await
        .unwrap();
    assert_eq!(again.task_id, task.task_id);

    let candidates = worker.client.next_tasks(1).await.unwrap();
    assert_eq!(candidates[0]["taskId"], task.task_id);
    let claim = worker.client.claim_task(&task.task_id, Some(30)).await.unwrap();
    worker.client.progress_task(&task.task_id, &json!({"fencingToken": claim.fencing_token, "message": "analyzing"})).await.unwrap();
    worker.client.complete_task(&task.task_id, claim.fencing_token, &json!({"verdict": "approve"}), &[]).await.unwrap();

    let done = author.client.wait_terminal(&task.task_id, Duration::from_secs(5)).await.unwrap();
    assert_eq!(done.state, TaskState::Succeeded);
    assert_eq!(done.result.unwrap()["verdict"], "approve");
    stack.stop().await;
}
