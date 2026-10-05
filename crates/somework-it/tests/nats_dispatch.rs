mod nats_common;

use std::time::Duration;

use nats_common::*;
use serde_json::json;
use somework_client::Client;
use somework_core::{ErrorCode, fsm::TaskState};

/// Claim-then-ACK exactly as in the spec: ACK on success and on "already claimed", never ACK on transient errors.
async fn handle(msg: &async_nats::jetstream::Message, payload: &serde_json::Value, client: &Client) -> Result<(), somework_client::ClientError> {
    match client.claim_task(payload["taskId"].as_str().unwrap(), Some(30)).await {
        Ok(_) => {
            msg.ack().await.ok();
            Ok(())
        }
        Err(e) if matches!(e.code, ErrorCode::AlreadyClaimed | ErrorCode::TaskTerminal | ErrorCode::InvalidTransition) => {
            msg.ack().await.ok();
            Ok(())
        }
        Err(e) => Err(e),
    }
}

#[tokio::test]
async fn outbound_only_worker_receives_work_over_nats_and_completes_it() {
    let env = start_env().await;
    let worker = reviewer(&env.stack, "agent/reviewer").await;
    let author = env.stack.requester("agent/author", &["code.review"], somework_core::contracts::SideEffects::Read).await;
    let conn = connect_agent(&worker).await;
    let pool = conn.pool_consumer().await;

    let task = author.client.submit_task(&submit_body(), None).await.unwrap();
    let (msg, payload) = next_message(&pool, Duration::from_secs(10)).await.expect("work-ready notification");

    let mut keys: Vec<&str> = payload.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort();
    assert_eq!(keys, ["capabilityId", "capabilityVersion", "eventId", "poolId", "revision", "taskId", "traceparent"]);
    assert_eq!(payload["taskId"], task.task_id);
    assert_eq!(payload["revision"], 2);
    assert_eq!(payload["capabilityId"], "code.review");
    assert_eq!(payload["capabilityVersion"], "2.1");
    assert_eq!(payload["poolId"], "agent/reviewer");
    assert!(payload["traceparent"].as_str().unwrap().starts_with("00-"));

    handle(&msg, &payload, &worker.client).await.unwrap();
    let claim = worker.client.get_task(&task.task_id).await.unwrap();
    assert_eq!(claim.state, TaskState::Claimed);
    worker.client.progress_task(&task.task_id, &json!({"fencingToken": 1, "message": "working"})).await.unwrap();
    worker.client.complete_task(&task.task_id, 1, &json!({"verdict": "approve"}), &[]).await.unwrap();
    assert_eq!(author.client.wait_terminal(&task.task_id, Duration::from_secs(5)).await.unwrap().state, TaskState::Succeeded);
    env.stack.stop().await;
}

#[tokio::test]
async fn transient_claim_error_does_not_ack_and_the_notification_is_redelivered() {
    let env = start_env_with(|c| c.ack_wait_secs = 2).await;
    let worker = reviewer(&env.stack, "agent/reviewer").await;
    let author = env.stack.requester("agent/author", &["code.review"], somework_core::contracts::SideEffects::Read).await;
    let conn = connect_agent(&worker).await;
    let pool = conn.pool_consumer().await;
    let task = author.client.submit_task(&submit_body(), None).await.unwrap();

    let (msg, payload) = next_message(&pool, Duration::from_secs(10)).await.unwrap();
    let dead = Client::assertion("http://127.0.0.1:1", (*worker.key).clone(), "agent", "agent/reviewer", "development").with_retries(0);
    let err = handle(&msg, &payload, &dead).await.unwrap_err();
    assert!(err.is_retryable(), "{err}");

    let (again, payload) = next_message(&pool, Duration::from_secs(10)).await.expect("redelivery after ack_wait");
    assert_eq!(again.info().unwrap().delivered, 2);
    handle(&again, &payload, &worker.client).await.unwrap();
    assert_eq!(worker.client.get_task(&task.task_id).await.unwrap().state, TaskState::Claimed);
    env.stack.stop().await;
}

#[tokio::test]
async fn racing_workers_produce_exactly_one_canonical_lease_and_both_ack() {
    let env = start_env().await;
    let a = reviewer(&env.stack, "agent/rev-a").await;
    let b = reviewer(&env.stack, "agent/rev-b").await;
    let author = env.stack.requester("agent/author", &["code.review"], somework_core::contracts::SideEffects::Read).await;
    let (ca, cb) = (connect_agent(&a).await, connect_agent(&b).await);
    let (pa, pb) = (ca.pool_consumer().await, cb.pool_consumer().await);
    let task = author.client.submit_task(&submit_body(), None).await.unwrap();

    let ((ma, xa), (mb, xb)) =
        tokio::join!(async { next_message(&pa, Duration::from_secs(10)).await.unwrap() }, async { next_message(&pb, Duration::from_secs(10)).await.unwrap() });
    assert_eq!(xa["taskId"], xb["taskId"]);
    let (ra, rb) = tokio::join!(handle(&ma, &xa, &a.client), handle(&mb, &xb, &b.client));
    ra.unwrap();
    rb.unwrap();

    let t = author.client.get_task(&task.task_id).await.unwrap();
    assert_eq!(t.state, TaskState::Claimed);
    assert_eq!(t.lease.as_ref().unwrap().fencing_token, 1, "one claim, one fence");
    let owner = env.stack.admin.get_task(&task.task_id).await.unwrap().assignee.expect("one canonical owner");
    assert!(owner.id == "agent/rev-a" || owner.id == "agent/rev-b");
    env.stack.stop().await;
}

#[tokio::test]
async fn duplicate_jetstream_delivery_changes_nothing_and_msg_id_dedupes_republish() {
    let env = start_env().await;
    let worker = reviewer(&env.stack, "agent/reviewer").await;
    let author = env.stack.requester("agent/author", &["code.review"], somework_core::contracts::SideEffects::Read).await;
    let conn = connect_agent(&worker).await;
    let pool = conn.pool_consumer().await;
    let task = author.client.submit_task(&submit_body(), None).await.unwrap();
    let (msg, payload) = next_message(&pool, Duration::from_secs(10)).await.unwrap();
    handle(&msg, &payload, &worker.client).await.unwrap();
    let before = author.client.get(&format!("/v1/tasks/{}/events", task.task_id)).await.unwrap()["events"].as_array().unwrap().len();

    // the broker (admin connection) redelivers the same notification under a new message id, and once more under an old one
    let admin_cfg = env.nats.plane_config();
    let admin = async_nats::ConnectOptions::with_user_and_password(admin_cfg.user.clone().unwrap(), admin_cfg.password.clone().unwrap())
        .connect(&admin_cfg.url)
        .await
        .unwrap();
    let js = async_nats::jetstream::new(admin);
    let subject = expected_pool_subject("agent/reviewer");
    let mut headers = async_nats::HeaderMap::new();
    headers.insert("Nats-Msg-Id", "manual-redelivery-1");
    js.publish_with_headers(subject.clone(), headers.clone(), serde_json::to_vec(&payload).unwrap().into()).await.unwrap().await.unwrap();
    let dup = js.publish_with_headers(subject, headers, serde_json::to_vec(&payload).unwrap().into()).await.unwrap().await.unwrap();
    assert!(dup.duplicate, "same Nats-Msg-Id inside the duplicate window is absorbed by JetStream");

    let (second, payload2) = next_message(&pool, Duration::from_secs(10)).await.unwrap();
    assert_eq!(payload2["taskId"], task.task_id);
    handle(&second, &payload2, &worker.client).await.unwrap();
    let after = author.client.get(&format!("/v1/tasks/{}/events", task.task_id)).await.unwrap()["events"].as_array().unwrap().len();
    assert_eq!(before, after, "a duplicate delivery must not create canonical state");
    env.stack.stop().await;
}

#[tokio::test]
async fn dispatch_latency_p95_stays_under_one_second_for_200_tasks() {
    let env = start_env().await;
    let worker = reviewer(&env.stack, "agent/reviewer").await;
    let author = env.stack.requester("agent/author", &["code.review"], somework_core::contracts::SideEffects::Read).await;
    let conn = connect_agent(&worker).await;
    let pool = conn.pool_consumer().await;

    use futures::StreamExt;
    let mut messages = pool.messages().await.unwrap();
    let submitted = std::sync::Arc::new(parking_lot_free::Map::default());
    let collector = {
        let submitted = submitted.clone();
        tokio::spawn(async move {
            let mut latencies = vec![];
            while latencies.len() < 200 {
                let Some(Ok(msg)) = messages.next().await else { break };
                let id = serde_json::from_slice::<serde_json::Value>(&msg.payload).unwrap()["taskId"].as_str().unwrap().to_string();
                msg.ack().await.ok();
                let started = loop {
                    if let Some(t) = submitted.get(&id) {
                        break t;
                    }
                    tokio::time::sleep(Duration::from_millis(2)).await;
                };
                latencies.push(started.elapsed());
            }
            latencies
        })
    };
    for _ in 0..200 {
        let c = author.client.clone();
        let t = c.submit_task(&submit_body(), None).await.unwrap();
        submitted.insert(t.task_id, std::time::Instant::now());
    }
    let mut latencies = tokio::time::timeout(Duration::from_secs(60), collector).await.unwrap().unwrap();
    latencies.sort();
    let p95 = latencies[(latencies.len() as f64 * 0.95) as usize - 1];
    assert!(p95 <= Duration::from_secs(1), "queued-to-worker-notification p95 was {p95:?}");
    env.stack.stop().await;
}

mod parking_lot_free {
    use std::{collections::HashMap, sync::Mutex, time::Instant};

    #[derive(Default)]
    pub struct Map(Mutex<HashMap<String, Instant>>);

    impl Map {
        pub fn insert(&self, k: String, v: Instant) {
            self.0.lock().unwrap().insert(k, v);
        }
        pub fn get(&self, k: &str) -> Option<Instant> {
            self.0.lock().unwrap().get(k).copied()
        }
    }
}
