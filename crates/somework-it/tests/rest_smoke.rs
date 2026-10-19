use serde_json::json;
use somework_domain::policy::Permissions;
use somework_testkit::{Stack, capability};

#[tokio::test]
async fn discover_message_and_read_the_answer_over_http() {
    let stack = Stack::start().await;
    let reviewer = stack
        .worker(
            "agent/reviewer",
            vec![capability("code.review", "2.1", "read", "Review pull requests for correctness and security")],
            Permissions::default_agent(),
        )
        .await;
    let author = stack.requester("agent/author").await;

    // discovery by natural language, without knowing the agent id
    let found = author.client.catalog_search(&json!({"query": "Review a pull request for correctness and security", "limit": 5})).await.unwrap();
    assert_eq!(found["matches"][0]["agentId"], "agent/reviewer");
    assert!(found["traceId"].as_str().unwrap().starts_with("00-"));

    let ask = json!({"recipients": [{"kind": "agent", "id": "agent/reviewer"}], "content": {"mediaType": "text/plain", "data": "Please review PR 729"}});
    let sent = author.client.post_idem("/v1/messages", &ask, "review-pr-729").await.unwrap();
    let again = author.client.post_idem("/v1/messages", &ask, "review-pr-729").await.unwrap();
    assert_eq!(again["messageId"], sent["messageId"], "an idempotent retry returns the same message");
    let conversation = sent["conversationId"].as_str().unwrap().to_string();

    let inbox = reviewer.client.get("/v1/inbox?unread=true").await.unwrap();
    assert_eq!(inbox["messages"][0]["messageId"], sent["messageId"]);
    let (events, _) = reviewer.client.events(0, 0).await.unwrap();
    assert!(events.iter().any(|e| e["type"] == "message.created" && e["wake"] == true), "a directed message wakes its recipient");

    let answer = json!({"conversationId": conversation, "recipients": [{"kind": "agent", "id": "agent/author"}], "content": {"mediaType": "text/plain", "data": "approve"}});
    reviewer.client.post("/v1/messages", &answer).await.unwrap();
    let page = author.client.get(&format!("/v1/conversations/{conversation}/messages")).await.unwrap();
    assert_eq!(page["messages"].as_array().unwrap().len(), 2);
    assert_eq!(page["messages"][1]["content"]["data"], "approve");
    stack.stop().await;
}

#[tokio::test]
async fn an_artifact_larger_than_the_default_body_limit_uploads_over_http() {
    let stack = Stack::start().await;
    let sender = stack.requester("agent/recorder").await;
    let video = vec![7u8; 3 * 1024 * 1024];
    let uploaded = sender.client.upload_artifact("recording.webm", "video/webm", "internal", &video).await.unwrap();
    assert_eq!(uploaded.version, 1);
    stack.stop().await;
}
