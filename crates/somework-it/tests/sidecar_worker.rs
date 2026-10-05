use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use futures::FutureExt;
use serde_json::{Value, json};
use somework_client::{Client, TaskInfo};
use somework_core::{
    contracts::{Failure, SideEffects},
    fsm::TaskState,
};
use somework_domain::policy::Permissions;
use somework_sidecar::{
    config::{WakeMode, WorkerConfig},
    worker::{
        Worker,
        adapter::{Adapter, AdapterOutcome, CallbackAdapter, Job, JobCtl},
        wake::{PollingWakeSource, WakeKind, WakeSource},
    },
};
use somework_testkit::{
    Agent, Stack, capability,
    process::eventually,
    sidecar::{WorkerProcess, agent_key_file, write_script},
};
use tokio_util::sync::CancellationToken;

fn perms(se: SideEffects) -> Permissions {
    let mut p = Permissions::default_agent();
    p.side_effects_at_most = Some(se);
    p
}

fn review_input() -> Value {
    json!({"capability": {"id": "code.review", "version": "2.1"}, "input": {"repository": "billing/import-service", "commit": "61a8d52"}})
}

fn cfg(lease: i64) -> WorkerConfig {
    WorkerConfig { wake: WakeMode::Poll, lease_seconds: lease, poll_wait_seconds: 1, progress_throttle_ms: 50, ..Default::default() }
}

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

fn start(agent: &Agent, adapter: Arc<dyn Adapter>, lease: i64) -> Running {
    let worker = Worker::new(agent.client.clone(), agent.id.clone(), cfg(lease), adapter);
    let stop = CancellationToken::new();
    let token = stop.clone();
    let handle = tokio::spawn(async move {
        let _ = worker.run(token).await;
    });
    Running { stop, handle }
}

fn callback<F, Fut>(f: F) -> Arc<dyn Adapter>
where
    F: Fn(Job, JobCtl) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = AdapterOutcome> + Send + 'static,
{
    Arc::new(CallbackAdapter::new(move |job, ctl| f(job, ctl).boxed()))
}

async fn wait_state(client: &Client, id: &str, state: TaskState) -> TaskInfo {
    eventually(&format!("task {id} to reach {state}"), Duration::from_secs(30), || async {
        let t = client.get_task(id).await.ok()?;
        (t.state == state).then_some(t)
    })
    .await
}

fn approve() -> AdapterOutcome {
    AdapterOutcome::Completed { result: json!({"verdict": "approve"}), artifacts: vec![] }
}

async fn reviewer_stack() -> (Stack, Agent, Agent) {
    let stack = Stack::start().await;
    let worker = stack
        .worker("agent/reviewer", vec![capability("code.review", "2.1", "read", "Review pull requests for correctness and security")], perms(SideEffects::Read))
        .await;
    let author = stack.requester("agent/author", &["code.review"], SideEffects::Read).await;
    (stack, worker, author)
}

#[tokio::test]
async fn polling_worker_runs_tasks_end_to_end_with_throttled_progress() {
    let (stack, worker, author) = reviewer_stack().await;
    let running = start(
        &worker,
        callback(|job, ctl| async move {
            assert_eq!(job.kind, "task");
            assert_eq!(job.capability["id"], "code.review");
            for i in 0..5 {
                let _ = ctl.events.send(somework_sidecar::worker::adapter::AdapterEvent::Progress {
                    message: Some(format!("step {i}")),
                    checkpoint: Some(json!({"step": i})),
                    percent: Some(i as f64 * 20.0),
                });
            }
            approve()
        }),
        30,
    );
    let task = author.client.submit_task(&review_input(), None).await.unwrap();
    let done = wait_state(&author.client, &task.task_id, TaskState::Succeeded).await;
    assert_eq!(done.result.unwrap()["verdict"], "approve");
    let events = stack.admin.get(&format!("/v1/tasks/{}/events", task.task_id)).await.unwrap();
    let kinds: Vec<&str> = events["events"].as_array().unwrap().iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert!(kinds.contains(&"task.claimed") && kinds.contains(&"task.running") && kinds.last() == Some(&"task.succeeded"), "{kinds:?}");
    let progress = kinds.iter().filter(|k| **k == "task.progress").count();
    assert!((1..5).contains(&progress), "5 rapid progress events must be throttled into fewer checkpoints, got {progress}");
    running.stop().await;
    stack.stop().await;
}

#[tokio::test]
async fn heartbeat_keeps_a_long_task_alive_past_the_initial_lease() {
    let (stack, worker, author) = reviewer_stack().await;
    let running = start(
        &worker,
        callback(|_, _| async {
            tokio::time::sleep(Duration::from_secs(4)).await; // four times the lease
            approve()
        }),
        1,
    );
    let task = author.client.submit_task(&review_input(), None).await.unwrap();
    let done = wait_state(&author.client, &task.task_id, TaskState::Succeeded).await;
    assert_eq!(done.attempt, 1, "the lease must never have lapsed");
    running.stop().await;
    stack.stop().await;
}

#[tokio::test]
async fn cooperative_cancellation_is_acknowledged_by_the_sidecar() {
    let (stack, worker, author) = reviewer_stack().await;
    let running = start(
        &worker,
        callback(|_, ctl| async move {
            ctl.cancel.cancelled().await;
            AdapterOutcome::Canceled
        }),
        1,
    );
    let task = author.client.submit_task(&review_input(), None).await.unwrap();
    wait_state(&author.client, &task.task_id, TaskState::Running).await;
    let requested = author.client.cancel_task(&task.task_id, Some("not needed")).await.unwrap();
    assert_eq!(requested.state, TaskState::CancelRequested);
    // the sidecar sees cancel_requested on its next heartbeat, signals the adapter and acknowledges
    wait_state(&author.client, &task.task_id, TaskState::Canceled).await;
    running.stop().await;
    stack.stop().await;
}

#[tokio::test]
async fn input_required_round_trip() {
    let (stack, worker, author) = reviewer_stack().await;
    let running = start(
        &worker,
        callback(|job, _| async move {
            match job.inputs.first() {
                None => AdapterOutcome::InputRequired { question: json!({"ask": "approve or reject?"}) },
                Some(answer) => AdapterOutcome::Completed { result: json!({"verdict": answer["verdict"]}), artifacts: vec![] },
            }
        }),
        2,
    );
    let task = author.client.submit_task(&review_input(), None).await.unwrap();
    let waiting = wait_state(&author.client, &task.task_id, TaskState::InputRequired).await;
    assert_eq!(waiting.blocker.unwrap()["question"]["ask"], "approve or reject?");
    author.client.provide_input(&task.task_id, &json!({"verdict": "reject"})).await.unwrap();
    let done = wait_state(&author.client, &task.task_id, TaskState::Succeeded).await;
    assert_eq!(done.result.unwrap()["verdict"], "reject");
    running.stop().await;
    stack.stop().await;
}

#[tokio::test]
async fn capability_timeout_fails_the_task_without_retrying() {
    let stack = Stack::start().await;
    let mut cap = capability("code.review", "2.1", "read", "Review pull requests");
    cap["timeoutSeconds"] = json!(1);
    let worker = stack.worker("agent/reviewer", vec![cap], perms(SideEffects::Read)).await;
    let author = stack.requester("agent/author", &["code.review"], SideEffects::Read).await;
    let running = start(
        &worker,
        callback(|_, ctl| async move {
            ctl.cancel.cancelled().await;
            AdapterOutcome::Canceled
        }),
        5,
    );
    let task = author.client.submit_task(&review_input(), None).await.unwrap();
    let failed = wait_state(&author.client, &task.task_id, TaskState::Failed).await;
    assert_eq!(failed.failure.unwrap().code, "timeout");
    assert_eq!(failed.attempt, 1);
    running.stop().await;
    stack.stop().await;
}

#[tokio::test]
async fn results_violating_the_output_schema_become_invalid_result_failures() {
    let (stack, worker, author) = reviewer_stack().await;
    let running = start(&worker, callback(|_, _| async { AdapterOutcome::Completed { result: json!({"verdict": "maybe"}), artifacts: vec![] } }), 5);
    let task = author.client.submit_task(&review_input(), None).await.unwrap();
    let failed = wait_state(&author.client, &task.task_id, TaskState::Failed).await;
    assert_eq!(failed.failure.unwrap().code, "invalid_result");
    running.stop().await;
    stack.stop().await;
}

#[tokio::test]
async fn adapter_failures_are_committed_as_task_failures() {
    let (stack, worker, author) = reviewer_stack().await;
    let running = start(
        &worker,
        callback(|_, _| async {
            AdapterOutcome::Failed(Failure { code: "repo_unreachable".into(), message: "cannot clone".into(), retryable: true, details: None })
        }),
        5,
    );
    let task = author.client.submit_task(&review_input(), None).await.unwrap();
    let failed = wait_state(&author.client, &task.task_id, TaskState::Failed).await;
    let f = failed.failure.unwrap();
    assert_eq!((f.code.as_str(), f.retryable), ("repo_unreachable", true));
    running.stop().await;
    stack.stop().await;
}

#[tokio::test]
async fn killing_the_sidecar_mid_task_lets_another_runtime_finish_retry_safe_work() {
    let (stack, worker, author) = reviewer_stack().await;
    let dir = stack.dir.path();
    let marker = dir.join("started");
    let script = write_script(dir, "slow.sh", &format!("cat >/dev/null; echo started > {}; sleep 60", marker.display()));
    let mut first = WorkerProcess::spawn(&stack.url, &agent_key_file(dir, &worker), &script, 2);
    let task = author.client.submit_task(&review_input(), None).await.unwrap();
    eventually("adapter start", Duration::from_secs(30), || async { marker.exists().then_some(()) }).await;
    first.kill9().await;

    // lease expires (2 s), the reaper re-queues, a different runtime completes the task
    let second = start(&worker, callback(|_, _| async { approve() }), 5);
    let done = wait_state(&author.client, &task.task_id, TaskState::Succeeded).await;
    assert_eq!(done.attempt, 2, "the retry-safe task was attempted again after the lease lapsed");
    second.stop().await;
    stack.stop().await;
}

#[tokio::test]
async fn irreversible_work_is_parked_for_reconciliation_not_retried() {
    let stack = Stack::start().await;
    stack
        .admin
        .put(
            "/v1/admin/policy",
            &json!({"version": "no-approvals", "approvals": {"requireSideEffectsAtLeast": null, "requireForCapabilities": [], "ttlSeconds": 3600}}),
        )
        .await
        .unwrap();
    let worker =
        stack.worker("agent/payer", vec![capability("payments.charge", "1", "irreversible", "Charge a customer card")], perms(SideEffects::Irreversible)).await;
    let author = stack.requester("agent/author", &["payments.charge"], SideEffects::Irreversible).await;
    let dir = stack.dir.path();
    let marker = dir.join("charging");
    let script = write_script(dir, "charge.sh", &format!("cat >/dev/null; echo charging > {}; sleep 60", marker.display()));
    let mut first = WorkerProcess::spawn(&stack.url, &agent_key_file(dir, &worker), &script, 2);
    let task =
        author.client.submit_task(&json!({"capability": {"id": "payments.charge", "version": "1"}, "input": {"repository": "order-1"}}), None).await.unwrap();
    eventually("charge started", Duration::from_secs(30), || async { marker.exists().then_some(()) }).await;
    first.kill9().await;

    let parked = wait_state(&author.client, &task.task_id, TaskState::Blocked).await;
    assert_eq!(parked.blocker.unwrap()["kind"], "reconciliation");

    // a healthy worker must not pick it up and repeat the side effect
    let second = start(&worker, callback(|_, _| async { panic!("an irreversible task must never be retried automatically") }), 5);
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(author.client.get_task(&task.task_id).await.unwrap().state, TaskState::Blocked);
    second.stop().await;

    stack
        .admin
        .post(&format!("/v1/tasks/{}/reconcile", task.task_id), &json!({"resolution": "failed", "note": "operator verified the charge did not happen"}))
        .await
        .unwrap();
    assert_eq!(author.client.get_task(&task.task_id).await.unwrap().state, TaskState::Failed);
    stack.stop().await;
}

#[tokio::test]
async fn a_paused_worker_that_resumes_after_losing_its_lease_has_its_result_discarded() {
    let (stack, worker, author) = reviewer_stack().await;
    let dir = stack.dir.path();
    let marker = dir.join("started");
    let script = write_script(
        dir,
        "late.sh",
        &format!("cat >/dev/null; echo started > {}; sleep 4; echo '{{\"type\":\"result\",\"result\":{{\"verdict\":\"approve\"}}}}'", marker.display()),
    );
    let first = WorkerProcess::spawn(&stack.url, &agent_key_file(dir, &worker), &script, 1);
    let task = author.client.submit_task(&review_input(), None).await.unwrap();
    eventually("adapter start", Duration::from_secs(30), || async { marker.exists().then_some(()) }).await;
    first.signal("STOP"); // no more heartbeats from the first sidecar

    // the lease (1 s) lapses; a second runtime takes over under a higher fencing token
    let second = start(&worker, callback(|_, _| async { AdapterOutcome::Completed { result: json!({"verdict": "reject"}), artifacts: vec![] } }), 5);
    let done = wait_state(&author.client, &task.task_id, TaskState::Succeeded).await;
    assert_eq!(done.result.as_ref().unwrap()["verdict"], "reject");
    let revision = done.revision;

    first.signal("CONT"); // the old worker wakes up holding fence 1 and its (stale) "approve"
    tokio::time::sleep(Duration::from_secs(5)).await;
    let after = author.client.get_task(&task.task_id).await.unwrap();
    assert_eq!(after.result.unwrap()["verdict"], "reject", "a stale fencing token must not overwrite the committed result");
    assert_eq!(after.revision, revision);
    second.stop().await;
    let mut first = first;
    first.kill9().await;
    stack.stop().await;
}

#[tokio::test]
async fn polling_wake_source_reports_ready_tasks_once_per_window() {
    let (stack, worker, author) = reviewer_stack().await;
    let source = PollingWakeSource::new(worker.client.clone(), 1);
    assert!(source.next().await.unwrap().is_empty());
    let task = author.client.submit_task(&review_input(), None).await.unwrap();
    let first = source.next().await.unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].kind, WakeKind::Task { task_id: task.task_id.clone() });
    assert!(source.next().await.unwrap().is_empty(), "a still-queued task is not re-announced inside the retry window");
    stack.stop().await;
}

struct ReplyAdapter;

#[async_trait]
impl Adapter for ReplyAdapter {
    async fn run(&self, _job: Job, _ctl: JobCtl) -> AdapterOutcome {
        approve()
    }

    async fn on_message(&self, job: Job, _ctl: JobCtl) -> Option<String> {
        Some(format!("pong: {}", job.message?["content"]["data"].as_str()?))
    }
}

#[tokio::test]
async fn directed_messages_wake_the_agent_but_notices_never_do() {
    let (stack, worker, author) = reviewer_stack().await;
    let running = start(&worker, Arc::new(ReplyAdapter), 5);

    let sent = author
        .client
        .send_message(
            &json!({"type": "chat.message", "recipients": [{"kind": "agent", "id": "agent/reviewer"}], "content": {"mediaType": "text/plain", "data": "ping"}}),
        )
        .await
        .unwrap();
    let conversation = sent["conversationId"].as_str().unwrap().to_string();
    // a notice must not trigger a turn
    author.client.send_message(&json!({"type": "chat.notice", "conversationId": conversation, "recipients": [{"kind": "agent", "id": "agent/reviewer"}], "content": {"mediaType": "text/plain", "data": "status"}})).await.unwrap();

    let replies = eventually("reply from the woken agent", Duration::from_secs(30), || async {
        let page = author.client.get(&format!("/v1/conversations/{conversation}/messages")).await.ok()?;
        let msgs = page["messages"].as_array()?.clone();
        msgs.iter().any(|m| m["content"]["data"] == "pong: ping").then_some(msgs)
    })
    .await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let page = author.client.get(&format!("/v1/conversations/{conversation}/messages")).await.unwrap();
    let pongs = page["messages"].as_array().unwrap().iter().filter(|m| m["content"]["data"].as_str().is_some_and(|d| d.starts_with("pong"))).count();
    assert_eq!(pongs, 1, "exactly one reply: {replies:?}");
    running.stop().await;
    stack.stop().await;
}
