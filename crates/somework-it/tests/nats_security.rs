mod nats_common;

use std::time::Duration;

use bytes::Bytes;
use nats_common::*;
use serde_json::json;
use somework_core::{contracts::SideEffects, subjects};

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

    // may not inject work, events or someone else's inbox
    for subject in [
        subjects::work_pool("agent/rev-a"),
        subjects::inbox("agent/rev-b"),
        subjects::event_task("task_x"),
        subjects::EVENT_CATALOG_CHANGED.to_string(),
        subjects::subscription("sub_x"),
    ] {
        ca.client.publish(subject.clone(), Bytes::from_static(b"{}")).await.unwrap();
        ca.client.flush().await.unwrap();
        expect_violation(&mut ca).await;
    }
    // may not read other agents' inboxes through the pull API, nor wildcard-subscribe the work/event spaces
    let other_inbox = format!("$JS.API.CONSUMER.MSG.NEXT.{}.{}", subjects::STREAM_INBOX, subjects::inbox_consumer("agent/rev-b"));
    ca.client.publish(other_inbox, Bytes::from_static(b"{}")).await.unwrap();
    ca.client.flush().await.unwrap();
    expect_violation(&mut ca).await;
    let _ = ca.client.subscribe("somework.event.>").await;
    let _ = ca.client.subscribe("somework.work.>").await;
    ca.client.flush().await.unwrap();
    expect_violation(&mut ca).await;
    while tokio::time::timeout(Duration::from_millis(300), ca.events.recv()).await.is_ok() {} // second wildcard subscription

    // may pull its own consumers and publish ephemeral chunks + its own presence
    let own = ca.inbox_consumer().await;
    assert!(next_message(&own, Duration::from_millis(300)).await.is_none());
    ca.client.publish(subjects::presence("agent/rev-a"), Bytes::from_static(b"{}")).await.unwrap();
    ca.client.publish(subjects::stream_task_text("task_x"), Bytes::from_static(b"{}")).await.unwrap();
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
    let author = env.stack.requester("agent/author", &["code.review"], SideEffects::Read).await;

    let quiet = worker.client.post("/v1/subscriptions", &json!({"kind": "capability_queue", "selector": "code.review", "wakeOnMatch": false})).await.unwrap();
    let loud = worker.client.post("/v1/subscriptions", &json!({"kind": "capability_queue", "selector": "code.review", "wakeOnMatch": true})).await.unwrap();
    assert!(
        worker.client.post("/v1/subscriptions", &json!({"kind": "capability_queue", "selector": "code.review"})).await.is_err(),
        "wakeOnMatch must be explicit"
    );

    let conn = connect_agent(&worker).await;
    author.client.submit_task(&submit_body(), None).await.unwrap();
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

    // loop protection: notices / task status / stream chunks cannot be made to wake anyone
    let notice =
        json!({"type": "chat.notice", "recipients": [{"kind": "agent", "id": "agent/reviewer"}], "content": {"mediaType": "text/plain", "data": "working..."}});
    let mut forced = notice.clone();
    forced["triggerMode"] = json!("directed");
    assert_eq!(author.client.send_message(&forced).await.unwrap_err().code, somework_core::ErrorCode::TriggerNotAllowed);
    let mut status =
        json!({"type": "task.status", "recipients": [{"kind": "agent", "id": "agent/reviewer"}], "content": {"mediaType": "text/plain", "data": "50%"}});
    status["triggerMode"] = json!("directed");
    assert_eq!(author.client.send_message(&status).await.unwrap_err().code, somework_core::ErrorCode::TriggerNotAllowed);
    let chunk = json!({"type": "stream.chunk", "recipients": [{"kind": "agent", "id": "agent/reviewer"}], "content": {"mediaType": "text/plain", "data": "x"}});
    assert!(author.client.send_message(&chunk).await.is_err());
    author.client.send_message(&notice).await.unwrap();

    let inbox = conn.inbox_consumer().await;
    let items = drain(&inbox, Duration::from_secs(2)).await;
    let notices: Vec<_> = items.iter().filter(|i| i["messageType"] == "chat.notice").collect();
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0]["wake"], false);
    env.stack.stop().await;
}
