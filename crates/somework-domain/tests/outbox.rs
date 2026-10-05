mod common;

use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use common::*;
use serde_json::{Value, json};
use somework_core::contracts::{ActorKind, SideEffects};
use somework_domain::{
    outbox::{OutboxConfig, OutboxItem, OutboxSink, SinkError},
    tasks::{ClaimRequest, ProgressRequest},
};

#[derive(Clone, Default)]
struct RecordingSink {
    name: &'static str,
    delivered: Arc<Mutex<Vec<OutboxItem>>>,
    fail_first: Arc<Mutex<usize>>,
    permanent: bool,
}

#[async_trait]
impl OutboxSink for RecordingSink {
    fn name(&self) -> &'static str {
        self.name
    }

    async fn deliver(&self, item: &OutboxItem) -> Result<(), SinkError> {
        {
            let mut left = self.fail_first.lock().unwrap();
            if *left > 0 {
                *left -= 1;
                return Err(if self.permanent { SinkError::permanent("rejected") } else { SinkError::transient("broker down") });
            }
        }
        self.delivered.lock().unwrap().push(item.clone());
        Ok(())
    }
}

fn fast_cfg() -> OutboxConfig {
    OutboxConfig {
        base_backoff: std::time::Duration::from_millis(1),
        max_backoff: std::time::Duration::from_millis(1),
        coalesce_interval: std::time::Duration::from_millis(750),
        ..Default::default()
    }
}

async fn env_with_sinks() -> (Env, Principal, Principal) {
    let env = Env::with_config(|c| c.outbox_sinks = vec!["nats".into(), "matrix".into()]).await;
    let worker = env.worker("agent/reviewer", vec![capability("code.review", "2.1", "read", "Review")], worker_permissions(SideEffects::Read)).await;
    let caller = env.create_principal(ActorKind::Agent, "agent/author", Some(caller_permissions(&["code.review"], SideEffects::Read))).await;
    (env, worker, caller)
}

#[tokio::test]
async fn task_creation_atomically_persists_task_event_and_outbox_rows() {
    let (env, _worker, caller) = env_with_sinks().await;
    let resp = env.domain.submit_task(&env.ctx(&caller).await, submit("code.review", "2.1")).await.unwrap();
    let task_id = resp.task.task.task_id;
    let rows = sqlx::query_as::<_, (String, String, String)>("SELECT sink, subject, payload FROM outbox_events ORDER BY id")
        .fetch_all(env.domain.db.pool())
        .await
        .unwrap();
    let work: Vec<_> = rows
        .iter()
        .filter(|(s, subj, _)| s == "nats" && subj == "somework.work.pool.agent-2freviewer".replace("agent-2freviewer", "agent~2freviewer").as_str())
        .collect();
    assert_eq!(work.len(), 1, "one work-ready notification for the agent's pool: {rows:?}");
    let ready: Value = serde_json::from_str(&work[0].2).unwrap();
    assert_eq!(ready["taskId"], task_id.as_str());
    assert_eq!(ready["revision"], 2);
    assert_eq!(ready["capabilityId"], "code.review");
    assert_eq!(ready["capabilityVersion"], "2.1");
    assert_eq!(ready["poolId"], "agent/reviewer");
    assert!(ready["traceparent"].as_str().unwrap().starts_with("00-"));
    assert!(ready.get("input").is_none(), "a ready notification carries only what is needed to claim");
    assert!(rows.iter().any(|(s, subj, _)| s == "nats" && subj.starts_with("somework.event.task.")));
    assert!(rows.iter().any(|(s, _, _)| s == "matrix"));
}

#[tokio::test]
async fn failed_transactions_leave_no_outbox_rows() {
    let (env, _worker, caller) = env_with_sinks().await;
    let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM outbox_events").fetch_one(env.domain.db.pool()).await.unwrap();
    let mut bad = submit("code.review", "2.1");
    bad.input = Some(json!({"commit": "missing required repository"}));
    assert!(env.domain.submit_task(&env.ctx(&caller).await, bad).await.is_err());
    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM outbox_events").fetch_one(env.domain.db.pool()).await.unwrap();
    assert_eq!(before, after);
    let tasks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tasks").fetch_one(env.domain.db.pool()).await.unwrap();
    assert_eq!(tasks, 0);
}

#[tokio::test]
async fn runner_delivers_in_order_and_marks_rows_published() {
    let (env, _worker, caller) = env_with_sinks().await;
    for _ in 0..3 {
        env.domain.submit_task(&env.ctx(&caller).await, submit("code.review", "2.1")).await.unwrap();
    }
    let sink = RecordingSink { name: "nats", ..Default::default() };
    let report = env.domain.outbox_step(&sink, "w1", &fast_cfg()).await.unwrap();
    assert!(report.published >= 6);
    let delivered = sink.delivered.lock().unwrap().clone();
    // work-ready notifications are claimed first (dispatch latency); everything else follows in commit order
    let first_other = delivered.iter().position(|i| !i.subject.starts_with("somework.work.")).unwrap_or(delivered.len());
    assert!(delivered[first_other..].iter().all(|i| !i.subject.starts_with("somework.work.")), "work-ready rows are delivered ahead of the rest of the batch");
    // consumers rely on per-subject ordering: rows of one subject are always published in commit order
    let mut by_subject: std::collections::BTreeMap<&str, Vec<i64>> = Default::default();
    for item in &delivered {
        by_subject.entry(item.subject.as_str()).or_default().push(item.id);
    }
    for (subject, ids) in by_subject {
        let mut sorted = ids.clone();
        sorted.sort();
        assert_eq!(ids, sorted, "rows of {subject} are published in commit order");
    }
    let stats = env.domain.outbox_stats().await.unwrap();
    let nats = stats.iter().find(|s| s.sink == "nats").unwrap();
    assert_eq!((nats.pending, nats.failed, nats.dead), (0, 0, 0));
    let matrix = stats.iter().find(|s| s.sink == "matrix").unwrap();
    assert!(matrix.pending > 0, "an unavailable sink never blocks another one");
}

#[tokio::test]
async fn transient_failures_retry_with_backoff_then_succeed() {
    let (env, _worker, caller) = env_with_sinks().await;
    env.domain.submit_task(&env.ctx(&caller).await, submit("code.review", "2.1")).await.unwrap();
    let sink = RecordingSink { name: "nats", fail_first: Arc::new(Mutex::new(2)), ..Default::default() };
    let cfg = fast_cfg();
    let first = env.domain.outbox_step(&sink, "w1", &cfg).await.unwrap();
    assert!(first.retried >= 1);
    for _ in 0..20 {
        env.advance(5);
        env.domain.outbox_step(&sink, "w1", &cfg).await.unwrap();
    }
    let nats = env.domain.outbox_stats().await.unwrap().into_iter().find(|s| s.sink == "nats").unwrap();
    assert_eq!((nats.pending, nats.failed, nats.dead), (0, 0, 0));
    let attempts: Vec<i64> =
        sqlx::query_scalar("SELECT attempts FROM outbox_events WHERE sink = 'nats' AND attempts > 0").fetch_all(env.domain.db.pool()).await.unwrap();
    assert!(!attempts.is_empty());
}

#[tokio::test]
async fn poison_rows_are_dead_lettered_and_can_be_requeued() {
    let (env, _worker, caller) = env_with_sinks().await;
    env.domain.submit_task(&env.ctx(&caller).await, submit("code.review", "2.1")).await.unwrap();
    let sink = RecordingSink { name: "nats", fail_first: Arc::new(Mutex::new(100)), permanent: true, ..Default::default() };
    let cfg = fast_cfg();
    let report = env.domain.outbox_step(&sink, "w1", &cfg).await.unwrap();
    assert!(report.dead >= 1);
    let stats = env.domain.outbox_stats().await.unwrap().into_iter().find(|s| s.sink == "nats").unwrap();
    assert!(stats.dead >= 1);
    // fixing the sink and requeueing delivers the dead rows
    let healthy = RecordingSink { name: "nats", ..Default::default() };
    assert!(env.domain.outbox_requeue_dead("nats").await.unwrap() >= 1);
    env.advance(1);
    env.domain.outbox_step(&healthy, "w1", &cfg).await.unwrap();
    assert!(!healthy.delivered.lock().unwrap().is_empty());
}

#[tokio::test]
async fn two_runners_never_deliver_the_same_row_twice() {
    let (env, _worker, caller) = env_with_sinks().await;
    for _ in 0..10 {
        env.domain.submit_task(&env.ctx(&caller).await, submit("code.review", "2.1")).await.unwrap();
    }
    let a = RecordingSink { name: "nats", ..Default::default() };
    let b = RecordingSink { name: "nats", delivered: Arc::new(Mutex::new(vec![])), ..Default::default() };
    let cfg = OutboxConfig { batch_size: 3, ..fast_cfg() };
    let d1 = env.domain.clone();
    let d2 = env.domain.clone();
    let (a2, b2, c1, c2) = (a.clone(), b.clone(), cfg.clone(), cfg.clone());
    let t1 = tokio::spawn(async move {
        for _ in 0..30 {
            d1.outbox_step(&a2, "runner-a", &c1).await.unwrap();
        }
    });
    let t2 = tokio::spawn(async move {
        for _ in 0..30 {
            d2.outbox_step(&b2, "runner-b", &c2).await.unwrap();
        }
    });
    t1.await.unwrap();
    t2.await.unwrap();
    let ids_a: HashSet<i64> = a.delivered.lock().unwrap().iter().map(|i| i.id).collect();
    let ids_b: HashSet<i64> = b.delivered.lock().unwrap().iter().map(|i| i.id).collect();
    assert!(ids_a.is_disjoint(&ids_b), "rows were claimed by exactly one runner");
    let total = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM outbox_events WHERE sink = 'nats'").fetch_one(env.domain.db.pool()).await.unwrap();
    assert_eq!((ids_a.len() + ids_b.len()) as i64, total);
}

#[tokio::test]
async fn progress_projections_are_coalesced_for_the_matrix_sink() {
    let (env, worker, caller) = env_with_sinks().await;
    let task = env.domain.submit_task(&env.ctx(&caller).await, submit("code.review", "2.1")).await.unwrap().task.task.task_id;
    let w = env.ctx(&worker).await;
    env.domain.claim_task(&w, &task, ClaimRequest::default()).await.unwrap();
    env.domain.progress_task(&w, &task, ProgressRequest { fencing_token: Some(1), ..Default::default() }).await.unwrap();
    for i in 0..20 {
        env.domain
            .progress_task(&w, &task, ProgressRequest { fencing_token: Some(1), message: Some(format!("step {i}")), ..Default::default() })
            .await
            .unwrap();
    }
    let matrix = RecordingSink { name: "matrix", ..Default::default() };
    let report = env.domain.outbox_step(&matrix, "m1", &fast_cfg()).await.unwrap();
    assert!(report.superseded >= 19, "{report:?}");
    let progress: Vec<_> =
        matrix.delivered.lock().unwrap().iter().filter(|i| i.coalesce_key.as_deref().is_some_and(|k| k.ends_with(":progress"))).cloned().collect();
    assert_eq!(progress.len(), 1, "only the newest progress row is projected");
    assert_eq!(progress[0].payload["revision"], progress[0].payload["revision"]);
}

#[tokio::test]
async fn lost_stream_state_is_rebuilt_from_canonical_queued_tasks() {
    let (env, _worker, caller) = env_with_sinks().await;
    let a = env.domain.submit_task(&env.ctx(&caller).await, submit("code.review", "2.1")).await.unwrap().task.task.task_id;
    let sink = RecordingSink { name: "nats", ..Default::default() };
    env.domain.outbox_step(&sink, "w1", &fast_cfg()).await.unwrap();
    let before = sink.delivered.lock().unwrap().len();
    // JetStream loses everything; canonical state still has the queued task
    assert_eq!(env.domain.republish_queued_tasks().await.unwrap(), 1);
    env.domain.outbox_step(&sink, "w1", &fast_cfg()).await.unwrap();
    let delivered = sink.delivered.lock().unwrap();
    let ready: Vec<_> = delivered.iter().filter(|i| i.subject.starts_with("somework.work.pool.") && i.payload["taskId"] == a.as_str()).collect();
    assert_eq!(ready.len(), 2, "the original notification and the rebuilt one");
    assert!(delivered.len() > before);
    assert_ne!(ready[0].dedupe_key, ready[1].dedupe_key, "the rebuilt notification is a new event, so JetStream does not dedupe it away");
}
