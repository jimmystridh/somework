mod nats_common;

use std::time::Duration;

use futures::StreamExt;
use nats_common::*;
use serde_json::{Value, json};
use somework_core::{contracts::SideEffects, jws};
use somework_nats::{ChunkKind, ChunkPublisher, StreamChunk};
use somework_testkit::{Agent, process::eventually};

async fn open_sse(stack_url: &str, requester: &Agent, task_id: &str) -> tokio::sync::mpsc::UnboundedReceiver<(String, Value)> {
    let token =
        jws::mint_assertion(&requester.key, &format!("agent:{}", requester.id), "somework:development", None, chrono::Utc::now(), chrono::Duration::minutes(5));
    let resp = reqwest::Client::new()
        .get(format!("{stack_url}/v1/tasks/{task_id}/stream"))
        .bearer_auth(token)
        .header("accept", "text/event-stream")
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success(), "{}", resp.status());
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        let mut buf = String::new();
        let mut bytes = resp.bytes_stream();
        while let Some(Ok(chunk)) = bytes.next().await {
            buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(pos) = buf.find("\n\n") {
                let frame: String = buf.drain(..pos + 2).collect();
                let mut event = String::new();
                let mut data = String::new();
                for line in frame.lines() {
                    if let Some(v) = line.strip_prefix("event:") {
                        event = v.trim().into();
                    } else if let Some(v) = line.strip_prefix("data:") {
                        data.push_str(v.trim());
                    }
                }
                if !event.is_empty() {
                    let _ = tx.send((event, serde_json::from_str(&data).unwrap_or(Value::Null)));
                }
            }
        }
    });
    rx
}

#[tokio::test]
async fn live_chunks_stream_over_core_nats_and_late_consumers_recover_from_the_snapshot() {
    let env = start_env().await;
    let worker = reviewer(&env.stack, "agent/reviewer").await;
    let author = env.stack.requester("agent/author", &["code.review"], SideEffects::Read).await;
    let task = author.client.submit_task(&submit_body(), None).await.unwrap();
    let claim = worker.client.claim_task(&task.task_id, Some(60)).await.unwrap();
    worker.client.progress_task(&task.task_id, &json!({"fencingToken": claim.fencing_token, "message": "started"})).await.unwrap();
    let runtime = worker.client.runtime_instance_id().unwrap();

    let mut sse = open_sse(&env.stack.url, &author, &task.task_id).await;
    let (event, snapshot) = tokio::time::timeout(Duration::from_secs(5), sse.recv()).await.unwrap().unwrap();
    assert_eq!(event, "snapshot");
    assert_eq!(snapshot["state"], "running");

    let conn = connect_agent(&worker).await;
    let publisher = ChunkPublisher::new(conn.client.clone());
    let good = |seq| StreamChunk {
        task_id: task.task_id.clone(),
        runtime_instance_id: runtime.clone(),
        fencing_token: claim.fencing_token,
        seq,
        kind: ChunkKind::Text,
        text: format!("token-{seq}"),
    };
    // publishes keep coming until the SSE subscription is live; a stale-fence chunk and a foreign-runtime chunk are interleaved
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut seq = 0;
    let first = loop {
        assert!(tokio::time::Instant::now() < deadline, "no live chunk arrived over SSE");
        seq += 1;
        let good = good(seq);
        let stale = StreamChunk { fencing_token: 99, seq: 1000 + seq, ..good.clone() };
        let foreign = StreamChunk { runtime_instance_id: "rt_other".into(), seq: 2000 + seq, ..good.clone() };
        publisher.publish(&stale).await.unwrap();
        publisher.publish(&foreign).await.unwrap();
        publisher.publish(&good).await.unwrap();
        if let Ok(Some((event, chunk))) = tokio::time::timeout(Duration::from_millis(300), sse.recv()).await
            && event == "chunk"
        {
            break chunk;
        }
    };
    assert_eq!(first["fencingToken"], claim.fencing_token);
    assert!(first["seq"].as_u64().unwrap() < 1000, "stale-fence and foreign-runtime chunks are never relayed: {first}");
    assert_eq!(first["kind"], "text");

    // a consumer that missed every chunk still recovers the durable state (STR-02)
    let mut late = open_sse(&env.stack.url, &author, &task.task_id).await;
    let (event, snapshot) = tokio::time::timeout(Duration::from_secs(5), late.recv()).await.unwrap().unwrap();
    assert_eq!(event, "snapshot");
    assert_eq!(snapshot["state"], "running");
    assert_eq!(snapshot["revision"], 4);
    env.stack.stop().await;
}

#[tokio::test]
async fn presence_signals_refresh_registered_runtimes_only() {
    let env = start_env().await;
    let worker = reviewer(&env.stack, "agent/reviewer").await;
    let runtime = worker.client.runtime_instance_id().unwrap();
    let conn = connect_agent(&worker).await;
    let last_seen = || async {
        let v = env.stack.admin.get("/v1/runtimes?agentId=agent%2Freviewer").await.unwrap();
        v["runtimes"].as_array().unwrap().iter().find(|r| r["runtimeInstanceId"] == runtime.as_str()).unwrap()["lastSeenAt"].as_str().unwrap().to_string()
    };
    let before = last_seen().await;
    let subject = somework_core::subjects::presence("agent/reviewer");
    eventually("presence refresh", Duration::from_secs(10), || async {
        conn.client.publish(subject.clone(), json!({"agentId": "agent/reviewer", "runtimeInstanceId": runtime}).to_string().into()).await.unwrap();
        conn.client.flush().await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        (last_seen().await > before).then_some(())
    })
    .await;
    env.stack.stop().await;
}

#[tokio::test]
async fn consumer_lag_is_exposed_on_the_metrics_endpoint() {
    let env = start_env().await;
    let worker = reviewer(&env.stack, "agent/reviewer").await;
    let author = env.stack.requester("agent/author", &["code.review"], SideEffects::Read).await;
    drop(connect_agent(&worker).await);
    for _ in 0..5 {
        author.client.submit_task(&submit_body(), None).await.unwrap();
    }
    let lag = eventually("pool consumer lag >= 5", Duration::from_secs(15), || async {
        let text = reqwest::get(format!("{}/metrics", env.stack.url)).await.ok()?.text().await.ok()?;
        text.lines()
            .find(|l| l.starts_with("somework_jetstream_consumer_lag{") && l.contains("SOMEWORK_WORK") && l.contains("pool_agent~2freviewer"))?
            .rsplit(' ')
            .next()?
            .parse::<f64>()
            .ok()
            .filter(|v| *v >= 5.0)
    })
    .await;
    assert!(lag >= 5.0);
    env.stack.stop().await;
}
