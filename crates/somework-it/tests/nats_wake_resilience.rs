//! The worker's NATS wake transport must never be the only way work reaches it: lost notifications, an outage and a
//! deleted consumer may add latency, but queued work is still picked up, and exactly once.

mod nats_common;

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use futures::FutureExt;
use nats_common::*;
use serde_json::{Value, json};
use somework_client::Client;
use somework_core::{contracts::SideEffects, fsm::TaskState, subjects};
use somework_sidecar::{
    config::{WakeMode, WorkerConfig},
    worker::{
        Worker,
        adapter::{AdapterOutcome, CallbackAdapter},
    },
};
use somework_testkit::{
    Agent,
    nats::{ADMIN_PASSWORD, ADMIN_USER, NatsServer},
    process::eventually,
};
use tokio_util::sync::CancellationToken;

type Executions = Arc<Mutex<HashMap<String, usize>>>;

struct Running {
    stop: CancellationToken,
    handle: tokio::task::JoinHandle<()>,
}

impl Running {
    async fn stop(self) {
        self.stop.cancel();
        let _ = self.handle.await;
    }
}

fn start_worker(agent: &Agent, executions: Executions) -> Running {
    start_worker_with(agent, executions, 1)
}

fn start_worker_with(agent: &Agent, executions: Executions, reconcile_seconds: u64) -> Running {
    start_worker_mode(agent, executions, WakeMode::Nats, reconcile_seconds)
}

fn start_worker_mode(agent: &Agent, executions: Executions, wake: WakeMode, reconcile_seconds: u64) -> Running {
    let cfg = WorkerConfig { wake, reconcile_seconds, poll_wait_seconds: 1, lease_seconds: 30, progress_throttle_ms: 50, ..Default::default() };
    let adapter = Arc::new(CallbackAdapter::new(move |job, _ctl| {
        let executions = executions.clone();
        async move {
            *executions.lock().unwrap().entry(job.task["taskId"].as_str().unwrap_or_default().to_string()).or_default() += 1;
            AdapterOutcome::Completed { result: json!({"verdict": "approve"}), artifacts: vec![] }
        }
        .boxed()
    }));
    let worker = Worker::new(agent.client.clone(), agent.id.clone(), cfg, adapter);
    let stop = CancellationToken::new();
    let token = stop.clone();
    let handle = tokio::spawn(async move {
        let _ = worker.run(token).await;
    });
    Running { stop, handle }
}

async fn admin_js(nats: &NatsServer) -> async_nats::jetstream::Context {
    let client = async_nats::ConnectOptions::with_user_and_password(ADMIN_USER.into(), ADMIN_PASSWORD.into()).connect(nats.url()).await.expect("admin connect");
    async_nats::jetstream::new(client)
}

async fn succeeded(client: &Client, task_id: &str) {
    eventually(&format!("task {task_id} to succeed"), Duration::from_secs(40), || async {
        (client.get_task(task_id).await.ok()?.state == TaskState::Succeeded).then_some(())
    })
    .await;
}

fn executed_once(executions: &Executions, task_id: &str) {
    assert_eq!(executions.lock().unwrap().get(task_id).copied(), Some(1), "task {task_id} must run exactly once");
}

#[tokio::test]
async fn nats_alone_wakes_the_worker_when_nothing_is_lost() {
    let env = start_env().await;
    let worker = reviewer(&env.stack, "agent/reviewer").await;
    let author = env.stack.requester("agent/author", &["code.review"], SideEffects::Read).await;
    drop(connect_agent(&worker).await);
    let executions = Executions::default();
    // the HTTP sweep is pushed out of the test's reach, so only the NATS notification can wake the worker
    let running = start_worker_with(&worker, executions.clone(), 100_000);
    let task = author.client.submit_task(&submit_body(), None).await.unwrap();
    succeeded(&author.client, &task.task_id).await;
    executed_once(&executions, &task.task_id);
    running.stop().await;
    env.stack.stop().await;
}

#[tokio::test]
async fn a_lost_work_notification_is_recovered_by_the_http_sweep() {
    let env = start_env().await;
    let worker = reviewer(&env.stack, "agent/reviewer").await;
    let author = env.stack.requester("agent/author", &["code.review"], SideEffects::Read).await;
    let connection = connect_agent(&worker).await; // provisions the agent's consumers
    let work_stream = connection.info["nats"]["poolConsumers"][0]["stream"].as_str().unwrap().to_string();
    drop(connection);

    let task = author.client.submit_task(&submit_body(), None).await.unwrap();
    wait_outbox_empty(&env.stack, "nats").await;
    // the notification is published, then lost before any worker saw it
    admin_js(&env.nats).await.get_stream(&work_stream).await.unwrap().purge().await.unwrap();

    let executions = Executions::default();
    let running = start_worker(&worker, executions.clone());
    succeeded(&author.client, &task.task_id).await;
    executed_once(&executions, &task.task_id);
    running.stop().await;
    env.stack.stop().await;
}

#[tokio::test]
async fn nats_outage_degrades_to_http_and_work_continues_before_during_and_after() {
    let mut env = start_env().await;
    let worker = reviewer(&env.stack, "agent/reviewer").await;
    let author = env.stack.requester("agent/author", &["code.review"], SideEffects::Read).await;
    drop(connect_agent(&worker).await);
    let executions = Executions::default();
    let running = start_worker(&worker, executions.clone());

    let before = author.client.submit_task(&submit_body(), None).await.unwrap();
    succeeded(&author.client, &before.task_id).await;

    env.nats.stop();
    let during = author.client.submit_task(&submit_body(), None).await.unwrap();
    succeeded(&author.client, &during.task_id).await;

    env.nats.restart().await;
    wait_outbox_empty(&env.stack, "nats").await;
    let after = author.client.submit_task(&submit_body(), None).await.unwrap();
    succeeded(&author.client, &after.task_id).await;

    for id in [&before.task_id, &during.task_id, &after.task_id] {
        executed_once(&executions, id);
    }
    running.stop().await;
    env.stack.stop().await;
}

#[tokio::test]
async fn a_deleted_consumer_does_not_strand_queued_work() {
    let env = start_env().await;
    let worker = reviewer(&env.stack, "agent/reviewer").await;
    let author = env.stack.requester("agent/author", &["code.review"], SideEffects::Read).await;
    let connection = connect_agent(&worker).await;
    let pool: &Value = &connection.info["nats"]["poolConsumers"][0];
    let (stream, consumer) = (pool["stream"].as_str().unwrap().to_string(), pool["consumer"].as_str().unwrap().to_string());
    drop(connection);

    let executions = Executions::default();
    let running = start_worker(&worker, executions.clone());
    let warmup = author.client.submit_task(&submit_body(), None).await.unwrap();
    succeeded(&author.client, &warmup.task_id).await;

    admin_js(&env.nats).await.delete_consumer_from_stream(&consumer, &stream).await.expect("delete the pool consumer");
    let task = author.client.submit_task(&submit_body(), None).await.unwrap();
    succeeded(&author.client, &task.task_id).await;
    executed_once(&executions, &task.task_id);
    assert_eq!(stream, subjects::STREAM_WORK);
    running.stop().await;
    env.stack.stop().await;
}

#[tokio::test]
async fn a_worker_started_while_the_broker_is_down_works_over_http_and_picks_nats_up_later() {
    let mut env = start_env().await;
    let worker = reviewer(&env.stack, "agent/reviewer").await;
    let author = env.stack.requester("agent/author", &["code.review"], SideEffects::Read).await;
    drop(connect_agent(&worker).await);
    wait_outbox_empty(&env.stack, "nats").await;
    env.nats.stop();

    let executions = Executions::default();
    // wake = auto, sweep out of reach: only the HTTP fallback can serve work while the broker is down
    let running = start_worker_mode(&worker, executions.clone(), WakeMode::Auto, 100_000);
    let during = author.client.submit_task(&submit_body(), None).await.unwrap();
    succeeded(&author.client, &during.task_id).await;

    env.nats.restart().await;
    wait_outbox_empty(&env.stack, "nats").await;
    let after = author.client.submit_task(&submit_body(), None).await.unwrap();
    succeeded(&author.client, &after.task_id).await;
    for id in [&during.task_id, &after.task_id] {
        executed_once(&executions, id);
    }
    running.stop().await;
    env.stack.stop().await;
}
