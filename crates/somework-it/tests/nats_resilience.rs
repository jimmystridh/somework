mod nats_common;

use std::time::Duration;

use nats_common::*;
use serde_json::json;
use somework_core::contracts::SideEffects;
use somework_testkit::process::eventually;

#[tokio::test]
async fn offline_agent_receives_its_durable_inbox_after_reconnect() {
    let env = start_env().await;
    let sleeper = reviewer(&env.stack, "agent/sleeper").await;
    let author = env.stack.requester("agent/author", &["code.review"], SideEffects::Read).await;
    // make sure the inbox consumer exists before the agent ever connects (it is provisioned from the directory)
    let first = connect_agent(&sleeper).await;
    drop(first);

    author.client.send_message(&json!({"type": "chat.message", "recipients": [{"kind": "agent", "id": "agent/sleeper"}], "content": {"mediaType": "text/plain", "data": "please look at PR 729"}})).await.unwrap();
    let mut body = submit_body();
    body["targetAgentId"] = json!("agent/sleeper");
    let task = author.client.submit_task(&body, None).await.unwrap();

    // the agent was offline when both were sent; on reconnect both are waiting
    let back = connect_agent(&sleeper).await;
    let inbox = back.inbox_consumer().await;
    let items = eventually("directed message in the durable inbox", Duration::from_secs(10), || async {
        let items = drain(&inbox, Duration::from_millis(700)).await;
        (!items.is_empty()).then_some(items)
    })
    .await;
    assert!(items.iter().any(|i| i["kind"] == "message" && i["messageType"] == "chat.message" && i["wake"] == true), "{items:?}");
    let pool = back.pool_consumer().await;
    let (_, work) = next_message(&pool, Duration::from_secs(10)).await.expect("directed task delivered after reconnect");
    assert_eq!(work["taskId"], task.task_id);
    env.stack.stop().await;
}

#[tokio::test]
async fn nats_outage_keeps_accepting_tasks_and_delivers_after_restoration() {
    let mut env = start_env().await;
    let worker = reviewer(&env.stack, "agent/reviewer").await;
    let author = env.stack.requester("agent/author", &["code.review"], SideEffects::Read).await;
    drop(connect_agent(&worker).await);
    wait_outbox_empty(&env.stack, "nats").await;

    env.nats.stop();
    let mut ids = vec![];
    for _ in 0..3 {
        let t = author.client.submit_task(&submit_body(), None).await.expect("submission is canonical even while NATS is down");
        ids.push(t.task_id);
    }
    assert!(outbox_pending(&env.stack, "nats").await >= 3, "events wait in the outbox");

    env.nats.restart().await;
    wait_outbox_empty(&env.stack, "nats").await;
    let conn = connect_agent(&worker).await;
    let pool = conn.pool_consumer().await;
    let mut seen = vec![];
    while let Some((msg, payload)) = next_message(&pool, Duration::from_secs(5)).await {
        msg.ack().await.ok();
        seen.push(payload["taskId"].as_str().unwrap().to_string());
        if seen.len() == 3 {
            break;
        }
    }
    seen.sort();
    ids.sort();
    assert_eq!(seen, ids);
    env.stack.stop().await;
}

#[tokio::test]
async fn jetstream_state_loss_is_repaired_by_republishing_canonical_queued_tasks() {
    let mut env = start_env().await;
    let worker = reviewer(&env.stack, "agent/reviewer").await;
    let author = env.stack.requester("agent/author", &["code.review"], SideEffects::Read).await;
    drop(connect_agent(&worker).await);
    let mut ids = vec![];
    for _ in 0..2 {
        ids.push(author.client.submit_task(&submit_body(), None).await.unwrap().task_id);
    }
    wait_outbox_empty(&env.stack, "nats").await;

    env.nats.stop();
    env.nats.wipe_store();
    env.nats.restart().await;

    // streams and consumers come back through the reconciler; accepted work is re-enqueued from SQLite
    let conn = eventually("worker consumer re-provisioned", Duration::from_secs(20), || async {
        let info = worker.client.get("/v1/connection").await.ok()?;
        let n = &info["nats"];
        let client = async_nats::connect_with_options(
            n["url"].as_str()?,
            async_nats::ConnectOptions::with_user_and_password(n["user"].as_str()?.into(), n["password"].as_str()?.into()),
        )
        .await
        .ok()?;
        let js = async_nats::jetstream::new(client);
        let stream = js.get_stream(n["workStream"].as_str()?).await.ok()?;
        stream.get_consumer::<async_nats::jetstream::consumer::pull::Config>(n["poolConsumers"][0]["consumer"].as_str()?).await.ok()
    })
    .await;
    assert_eq!(env.stack.domain().republish_queued_tasks().await.unwrap(), 2);
    let mut seen = vec![];
    while let Some((msg, payload)) = next_message(&conn, Duration::from_secs(10)).await {
        msg.ack().await.ok();
        seen.push(payload["taskId"].as_str().unwrap().to_string());
        if seen.len() == 2 {
            break;
        }
    }
    seen.sort();
    ids.sort();
    assert_eq!(seen, ids);
    env.stack.stop().await;
}
