mod nats_common;

use std::time::Duration;

use bytes::Bytes;
use nats_common::*;
use serde_json::json;
use somework_core::subjects;

async fn expect_violation(conn: &mut AgentNats) {
    let ev = tokio::time::timeout(Duration::from_secs(3), conn.events.recv()).await.expect("server error event").expect("channel");
    assert!(ev.to_lowercase().contains("permissions violation"), "{ev}");
}

#[tokio::test]
async fn agent_credentials_are_least_privilege() {
    let env = start_env().await;
    let a = reviewer(&env.stack, "agent/rev-a").await;
    let b = reviewer(&env.stack, "agent/rev-b").await;
    let mut ca = connect_agent(&a).await;
    let _cb = connect_agent(&b).await;

    // may not inject events or someone else's inbox
    for subject in
        [subjects::inbox("agent/rev-b"), subjects::event_conversation("conv_x"), subjects::EVENT_CATALOG_CHANGED.to_string(), subjects::subscription("sub_x")]
    {
        ca.client.publish(subject.clone(), Bytes::from_static(b"{}")).await.unwrap();
        ca.client.flush().await.unwrap();
        expect_violation(&mut ca).await;
    }
    // may not read other agents' inboxes through the pull API, nor wildcard-subscribe the event spaces
    let other_inbox = format!("$JS.API.CONSUMER.MSG.NEXT.{}.{}", subjects::STREAM_INBOX, subjects::inbox_consumer("agent/rev-b"));
    ca.client.publish(other_inbox, Bytes::from_static(b"{}")).await.unwrap();
    ca.client.flush().await.unwrap();
    expect_violation(&mut ca).await;
    let _ = ca.client.subscribe("somework.event.>").await;
    let _ = ca.client.subscribe("somework.inbox.>").await;
    ca.client.flush().await.unwrap();
    expect_violation(&mut ca).await;
    while tokio::time::timeout(Duration::from_millis(300), ca.events.recv()).await.is_ok() {} // second wildcard subscription

    // may pull its own consumers and publish its own presence
    let own = ca.inbox_consumer().await;
    assert!(next_message(&own, Duration::from_millis(300)).await.is_none());
    ca.client.publish(subjects::presence("agent/rev-a"), Bytes::from_static(b"{}")).await.unwrap();
    ca.client.flush().await.unwrap();
    assert!(tokio::time::timeout(Duration::from_millis(500), ca.events.recv()).await.is_err(), "allowed subjects must not raise violations");

    // presence for someone else is outside its grant
    ca.client.publish(subjects::presence("agent/rev-b"), Bytes::from_static(b"{}")).await.unwrap();
    ca.client.flush().await.unwrap();
    expect_violation(&mut ca).await;
    env.stack.stop().await;
}

#[tokio::test]
async fn subscription_wake_flags_and_non_triggering_types_never_wake() {
    let env = start_env().await;
    let worker = reviewer(&env.stack, "agent/reviewer").await;
    let author = env.stack.requester("agent/author").await;

    let quiet = worker.client.post("/v1/subscriptions", &json!({"kind": "topic", "selector": "github.*", "wakeOnMatch": false})).await.unwrap();
    let loud = worker.client.post("/v1/subscriptions", &json!({"kind": "topic", "selector": "github.*", "wakeOnMatch": true})).await.unwrap();
    assert!(worker.client.post("/v1/subscriptions", &json!({"kind": "topic", "selector": "github.*"})).await.is_err(), "wakeOnMatch must be explicit");
    assert!(
        worker.client.post("/v1/subscriptions", &json!({"kind": "capability_queue", "selector": "code.review", "wakeOnMatch": true})).await.is_err(),
        "there are no capability queues"
    );

    let conn = connect_agent(&worker).await;
    env.stack.admin.publish_event(&json!({"topic": "github.push.main", "key": "k1", "data": {}})).await.unwrap();
    let subs = conn.subscription_consumer().await;
    let mut by_id = std::collections::HashMap::new();
    while let Some((msg, payload)) = next_message(&subs, Duration::from_secs(10)).await {
        msg.ack().await.ok();
        by_id.insert(payload["subscriptionId"].as_str().unwrap().to_string(), payload["wake"].as_bool().unwrap());
        if by_id.len() == 2 {
            break;
        }
    }
    assert!(!by_id[quiet["subscriptionId"].as_str().unwrap()]);
    assert!(by_id[loud["subscriptionId"].as_str().unwrap()]);

    // loop protection: notices and event notifications cannot be made to wake anyone, and the types that no longer exist are refused
    let notice =
        json!({"type": "chat.notice", "recipients": [{"kind": "agent", "id": "agent/reviewer"}], "content": {"mediaType": "text/plain", "data": "working..."}});
    let mut forced = notice.clone();
    forced["triggerMode"] = json!("directed");
    assert_eq!(author.client.send_message(&forced).await.unwrap_err().code, somework_core::ErrorCode::TriggerNotAllowed);
    for gone in ["task.status", "task.request", "stream.chunk", "approval.request", "context.offer"] {
        let message = json!({"type": gone, "recipients": [{"kind": "agent", "id": "agent/reviewer"}], "content": {"mediaType": "text/plain", "data": "x"}});
        assert!(author.client.send_message(&message).await.is_err(), "{gone}");
    }
    author.client.send_message(&notice).await.unwrap();

    let inbox = conn.inbox_consumer().await;
    let items = drain(&inbox, Duration::from_secs(2)).await;
    let notices: Vec<_> = items.iter().filter(|i| i["messageType"] == "chat.notice").collect();
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0]["wake"], false);
    env.stack.stop().await;
}
