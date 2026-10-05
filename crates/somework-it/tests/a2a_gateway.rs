mod gateway_support;

use std::time::Duration;

use gateway_support::*;
use reqwest::StatusCode;
use serde_json::{Value, json};
use somework_testkit::process::eventually;

fn invoke(message_id: &str, skill: &str) -> Value {
    json!({
        "message": {"messageId": message_id, "role": "ROLE_USER", "parts": [{"data": {"skillId": skill, "input": {"repository": "billing/import-service", "commit": "61a8d52"}}}]},
        "configuration": {"returnImmediately": true}
    })
}

async fn post(http: &reqwest::Client, url: &str, token: &str, body: &Value) -> (StatusCode, Value) {
    let r = http.post(url).bearer_auth(token).header("A2A-Version", "1.0").json(body).send().await.unwrap();
    (r.status(), r.json().await.unwrap_or(Value::Null))
}

async fn get(http: &reqwest::Client, url: &str, token: &str) -> (StatusCode, Value) {
    let r = http.get(url).bearer_auth(token).header("A2A-Version", "1.0").send().await.unwrap();
    (r.status(), r.json().await.unwrap_or(Value::Null))
}

fn reason(body: &Value) -> String {
    body["error"]["details"][0]["reason"].as_str().unwrap_or_default().to_string()
}

#[tokio::test]
async fn agent_card_discovery_with_selective_disclosure() {
    let (stack, _worker) = a2a_stack("operations").await;
    let http = reqwest::Client::new();
    let (status, card) = get(&http, &format!("{}/.well-known/agent-card.json", stack.url), "").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(card["supportedInterfaces"][0]["protocolBinding"], "HTTP+JSON");
    assert_eq!(card["supportedInterfaces"][0]["protocolVersion"], "1.0");
    assert_eq!(card["supportedInterfaces"][0]["url"], format!("{}/a2a", stack.url).replace("http://", "http://"));
    assert_eq!(card["skills"][0]["id"], "ops.diagnose");
    assert_eq!(card["capabilities"]["streaming"], true);
    assert!(card["securitySchemes"]["bearer"]["httpAuthSecurityScheme"]["scheme"] == "Bearer");
    assert!(!card.to_string().contains("agent/diagnostician"), "no internal agent ids in the public card");

    // the extended card needs authentication and is limited to what the caller may invoke
    let client = A2aClient::enrol(&stack, "partner-bot", &["ops.diagnose"]).await;
    let (status, _) = get(&http, &format!("{}/a2a/extendedAgentCard", stack.url), "bad-token").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, ext) = get(&http, &format!("{}/a2a/extendedAgentCard", stack.url), &client.token()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ext["skills"].as_array().unwrap().len(), 1);
    stack.stop().await;
}

#[tokio::test]
async fn message_send_get_list_cancel_followup_and_errors() {
    let (stack, worker) = a2a_stack("operations").await;
    let http = reqwest::Client::new();
    let base = format!("{}/a2a", stack.url);
    let client = A2aClient::enrol(&stack, "partner-bot", &["ops.diagnose"]).await;
    let token = client.token();

    let (status, sent) = post(&http, &format!("{base}/message:send"), &token, &invoke("m-1", "ops.diagnose")).await;
    assert_eq!(status, StatusCode::OK, "{sent}");
    let task = &sent["task"];
    assert_eq!(task["status"]["state"], "TASK_STATE_SUBMITTED");
    let (task_id, context_id) = (task["id"].as_str().unwrap().to_string(), task["contextId"].as_str().unwrap().to_string());

    // idempotent by messageId
    let (_, again) = post(&http, &format!("{base}/message:send"), &token, &invoke("m-1", "ops.diagnose")).await;
    assert_eq!(again["task"]["id"], task_id);

    run_worker_once(&worker, json!({"verdict": "approve"})).await;
    let done = eventually("completed task", Duration::from_secs(10), || async {
        let (_, t) = get(&http, &format!("{base}/tasks/{task_id}"), &token).await;
        (t["status"]["state"] == "TASK_STATE_COMPLETED").then_some(t)
    })
    .await;
    assert_eq!(done["artifacts"][0]["parts"][0]["data"]["verdict"], "approve");
    assert_eq!(done["contextId"], context_id);

    let (_, listed) = get(&http, &format!("{base}/tasks"), &token).await;
    assert_eq!(listed["tasks"][0]["id"], task_id);

    // terminal tasks are immutable: the follow-up becomes a sibling task in the same context
    let follow = json!({"message": {"messageId": "m-2", "contextId": context_id, "taskId": task_id, "role": "ROLE_USER", "parts": [{"data": {"input": {"repository": "billing/import-service"}}}]}, "configuration": {"returnImmediately": true}});
    let (status, followed) = post(&http, &format!("{base}/message:send"), &token, &follow).await;
    assert_eq!(status, StatusCode::OK, "{followed}");
    assert_ne!(followed["task"]["id"], task_id);
    assert_eq!(followed["task"]["contextId"], context_id);
    let lineage: Option<String> = {
        use sqlx::Row;
        sqlx::query("SELECT follow_up_of FROM federated_tasks WHERE internal_task_id = ?")
            .bind(followed["task"]["id"].as_str().unwrap())
            .fetch_one(stack.domain().db.pool())
            .await
            .unwrap()
            .get(0)
    };
    assert_eq!(lineage.as_deref(), Some(task_id.as_str()));

    // cancel the follow-up, and a terminal task cannot be canceled
    let follow_id = followed["task"]["id"].as_str().unwrap();
    let (status, canceled) = post(&http, &format!("{base}/tasks/{follow_id}:cancel"), &token, &json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(canceled["status"]["state"], "TASK_STATE_CANCELED");
    let (status, body) = post(&http, &format!("{base}/tasks/{follow_id}:cancel"), &token, &json!({})).await;
    assert_eq!((status, reason(&body).as_str()), (StatusCode::BAD_REQUEST, "TASK_NOT_CANCELABLE"));

    // errors
    let (status, body) = post(&http, &format!("{base}/message:send"), &token, &invoke("m-3", "ops.unknown")).await;
    assert_eq!((status, reason(&body).as_str()), (StatusCode::BAD_REQUEST, "UNSUPPORTED_OPERATION"));
    let r =
        http.post(format!("{base}/message:send")).bearer_auth(&token).header("A2A-Version", "0.2").json(&invoke("m-4", "ops.diagnose")).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    assert_eq!(reason(&r.json().await.unwrap()), "VERSION_NOT_SUPPORTED");
    let (status, body) = post(&http, &format!("{base}/tasks/{task_id}/pushNotificationConfigs"), &token, &json!({})).await;
    assert_eq!((status, reason(&body).as_str()), (StatusCode::BAD_REQUEST, "PUSH_NOTIFICATION_NOT_SUPPORTED"));
    let (status, _) = post(&http, &format!("{base}/message:send"), "garbage", &invoke("m-5", "ops.diagnose")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, body) = get(&http, &format!("{base}/tasks/does-not-exist"), &token).await;
    assert_eq!((status, reason(&body).as_str()), (StatusCode::NOT_FOUND, "TASK_NOT_FOUND"));

    // another principal cannot see this caller's tasks
    let other = A2aClient::enrol(&stack, "other-bot", &["ops.diagnose"]).await;
    let (status, _) = get(&http, &format!("{base}/tasks/{task_id}"), &other.token()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // a caller whose grant does not include the skill cannot tell it exists
    let narrow = A2aClient::enrol(&stack, "narrow-bot", &["something.else"]).await;
    let (status, body) = post(&http, &format!("{base}/message:send"), &narrow.token(), &invoke("m-6", "ops.diagnose")).await;
    assert_eq!((status, reason(&body).as_str()), (StatusCode::BAD_REQUEST, "UNSUPPORTED_OPERATION"));
    stack.stop().await;
}

#[tokio::test]
async fn streaming_delivers_task_status_and_artifacts() {
    let (stack, worker) = a2a_stack("operations").await;
    let http = reqwest::Client::new();
    let client = A2aClient::enrol(&stack, "partner-bot", &["ops.diagnose"]).await;
    let url = format!("{}/a2a/message:stream", stack.url);
    let req = http.post(&url).bearer_auth(client.token()).header("A2A-Version", "1.0").json(&invoke("s-1", "ops.diagnose"));
    let streaming = tokio::spawn(async move { req.send().await.unwrap().text().await.unwrap() });
    run_worker_once(&worker, json!({"verdict": "reject"})).await;
    let body = streaming.await.unwrap();
    let events: Vec<Value> = body.lines().filter_map(|l| l.strip_prefix("data:")).map(|d| serde_json::from_str(d.trim()).unwrap()).collect();
    assert!(events[0].get("task").is_some(), "first event is the task: {body}");
    assert!(events.iter().any(|e| e["artifactUpdate"]["artifact"]["parts"][0]["data"]["verdict"] == "reject"));
    assert_eq!(events.last().unwrap()["statusUpdate"]["status"]["state"], "TASK_STATE_COMPLETED");
    stack.stop().await;
}
