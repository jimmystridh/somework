//! Model-based state-machine test: random operation sequences (including stale fencing tokens, expired leases,
//! cancel races and time jumps) must never violate the task invariants (TASK-02/04/05/06, tests "State-machine testing").

mod common;

use common::*;
use proptest::prelude::*;
use serde_json::json;
use somework_core::{
    contracts::{ActorKind, SideEffects},
    fsm::TaskState,
};
use somework_domain::tasks::{CancelRequest, ClaimRequest, CompleteRequest, FailRequest, HeartbeatRequest, ProgressRequest};

#[derive(Debug, Clone)]
enum Op {
    Claim { worker: usize },
    Progress { worker: usize, stale: bool },
    Heartbeat { worker: usize, stale: bool },
    Complete { worker: usize, stale: bool },
    Fail { worker: usize, stale: bool },
    Cancel,
    AckCancel { worker: usize },
    Advance { seconds: i64 },
    Maintenance,
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        3 => (0..2usize).prop_map(|worker| Op::Claim { worker }),
        3 => ((0..2usize), any::<bool>()).prop_map(|(worker, stale)| Op::Progress { worker, stale }),
        2 => ((0..2usize), any::<bool>()).prop_map(|(worker, stale)| Op::Heartbeat { worker, stale }),
        2 => ((0..2usize), any::<bool>()).prop_map(|(worker, stale)| Op::Complete { worker, stale }),
        1 => ((0..2usize), any::<bool>()).prop_map(|(worker, stale)| Op::Fail { worker, stale }),
        1 => Just(Op::Cancel),
        1 => (0..2usize).prop_map(|worker| Op::AckCancel { worker }),
        2 => (1..90i64).prop_map(|seconds| Op::Advance { seconds }),
        2 => Just(Op::Maintenance),
    ]
}

async fn run(ops: Vec<Op>, irreversible: bool) -> Result<(), String> {
    let env = Env::with_config(|c| c.max_task_attempts = 4).await;
    let side = if irreversible { "irreversible" } else { "write" };
    let cap = capability("model.work", "1", side, "model");
    let max = if irreversible { SideEffects::Irreversible } else { SideEffects::Write };
    let w0 = env.worker("agent/w0", vec![cap.clone()], worker_permissions(max)).await;
    let w1 = env.worker("agent/w1", vec![cap], worker_permissions(max)).await;
    let workers = [w0, w1];
    let mut perms = caller_permissions(&["model.work"], max);
    perms.approves = vec![];
    let requester = env.create_principal(ActorKind::Agent, "agent/req", Some(perms)).await;
    if irreversible {
        let mut policy = env.domain.get_policy(&env.admin_ctx().await).await.unwrap();
        policy.version = "no-approval".into();
        policy.approvals.require_side_effects_at_least = None;
        env.domain.put_policy(&env.admin_ctx().await, policy).await.unwrap();
    }
    let rc = env.ctx(&requester).await;
    let task_id = env.domain.submit_task(&rc, submit("model.work", "1")).await.unwrap().task.task.task_id;

    let mut fences: [Option<u64>; 2] = [None, None];
    let mut last_revision = 2u64;
    let mut max_fence_seen = 0u64;
    let mut terminal: Option<TaskState> = None;

    for step in ops {
        match &step {
            Op::Claim { worker } => {
                let ctx = env.ctx(&workers[*worker]).await;
                if let Ok(c) = env.domain.claim_task(&ctx, &task_id, ClaimRequest { lease_seconds: Some(30), ..Default::default() }).await {
                    fences[*worker] = Some(c.fencing_token);
                }
            }
            Op::Progress { worker, stale } => {
                let ctx = env.ctx(&workers[*worker]).await;
                let fence = fences[*worker].map(|f| if *stale { f.saturating_sub(1) } else { f });
                let _ =
                    env.domain.progress_task(&ctx, &task_id, ProgressRequest { fencing_token: fence, message: Some("p".into()), ..Default::default() }).await;
            }
            Op::Heartbeat { worker, stale } => {
                let ctx = env.ctx(&workers[*worker]).await;
                let fence = fences[*worker].map(|f| if *stale { f + 5 } else { f });
                let _ = env.domain.heartbeat_task(&ctx, &task_id, HeartbeatRequest { fencing_token: fence, lease_seconds: Some(30) }).await;
            }
            Op::Complete { worker, stale } => {
                let ctx = env.ctx(&workers[*worker]).await;
                let fence = fences[*worker].map(|f| if *stale { f.saturating_sub(1) } else { f });
                let _ = env
                    .domain
                    .complete_task(&ctx, &task_id, CompleteRequest { fencing_token: fence, result: Some(json!({"verdict": "approve"})), ..Default::default() })
                    .await;
            }
            Op::Fail { worker, stale } => {
                let ctx = env.ctx(&workers[*worker]).await;
                let fence = fences[*worker].map(|f| if *stale { f + 7 } else { f });
                let failure = somework_core::contracts::Failure { code: "boom".into(), message: "boom".into(), retryable: false, details: None };
                let _ = env.domain.fail_task(&ctx, &task_id, FailRequest { fencing_token: fence, failure: Some(failure), ..Default::default() }).await;
            }
            Op::Cancel => {
                let _ = env.domain.cancel_task(&rc, &task_id, CancelRequest::default()).await;
            }
            Op::AckCancel { worker } => {
                let ctx = env.ctx(&workers[*worker]).await;
                let _ = env.domain.cancel_task(&ctx, &task_id, CancelRequest { acknowledge: true, fencing_token: fences[*worker], ..Default::default() }).await;
            }
            Op::Advance { seconds } => env.advance(*seconds),
            Op::Maintenance => {
                let _ = env.domain.run_maintenance().await;
            }
        }

        // ---- invariants -------------------------------------------------------------------------------------------
        let view = env.domain.get_task(&rc, &task_id).await.map_err(|e| format!("get failed after {step:?}: {e}"))?;
        let t = &view.task;
        if t.revision < last_revision {
            return Err(format!("revision went backwards after {step:?}: {} < {last_revision}", t.revision));
        }
        last_revision = t.revision;
        if let Some(done) = terminal
            && t.state != done
        {
            return Err(format!("terminal state {done} changed to {} after {step:?}", t.state));
        }
        if t.state.is_terminal() {
            terminal = Some(t.state);
            if t.lease.is_some() {
                return Err(format!("terminal task still holds a lease after {step:?}"));
            }
            if t.state == TaskState::Succeeded && t.result.is_none() {
                return Err("succeeded without a result".into());
            }
            if t.state == TaskState::Failed && t.failure.is_none() {
                return Err("failed without a failure".into());
            }
        }
        if t.state.is_leased() && t.state != TaskState::Blocked && t.lease.is_none() {
            return Err(format!("{} without a lease after {step:?}", t.state));
        }
        if t.state == TaskState::Queued && (t.lease.is_some() || t.assignee.is_some()) {
            return Err(format!("queued task still has an owner after {step:?}"));
        }
        if let Some(lease) = &t.lease {
            if lease.fencing_token < max_fence_seen {
                return Err(format!("fencing token decreased after {step:?}"));
            }
            max_fence_seen = lease.fencing_token;
            let assignee = t.assignee.as_ref().map(|a| a.id.clone()).unwrap_or_default();
            let holders = fences.iter().enumerate().filter(|(i, f)| **f == Some(lease.fencing_token) && workers[*i].id == assignee).count();
            if holders != 1 {
                return Err(format!("lease owner mismatch after {step:?}: assignee {assignee}, fence {}", lease.fencing_token));
            }
        }
        if irreversible && t.attempt > 1 && t.state != TaskState::Succeeded {
            // an irreversible, non-idempotent action is never re-queued by lease expiry
            let events = env.domain.list_task_events(&rc, &task_id, 0, 1000).await.unwrap();
            if events.iter().any(|e| e.kind == "task.requeued") {
                return Err("irreversible task was auto-retried".into());
            }
        }
        if t.attempt > 4 {
            return Err(format!("attempt {} exceeds the configured maximum", t.attempt));
        }
        let events = env.domain.list_task_events(&rc, &task_id, 0, 1000).await.unwrap();
        for pair in events.windows(2) {
            if pair[1].event_sequence != pair[0].event_sequence + 1 || pair[1].revision < pair[0].revision {
                return Err("task events are not densely ordered".into());
            }
        }
    }
    if env.domain.verify_audit_chain().await.unwrap().is_some() {
        return Err("audit chain broken".into());
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig { cases: std::env::var("PROPTEST_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(40), max_shrink_iters: 200, ..ProptestConfig::default() })]

    #[test]
    fn retry_safe_tasks_never_violate_invariants(ops in proptest::collection::vec(op(), 1..40)) {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        let outcome = rt.block_on(run(ops, false));
        prop_assert!(outcome.is_ok(), "{}", outcome.unwrap_err());
    }

    #[test]
    fn irreversible_tasks_never_violate_invariants_or_auto_retry(ops in proptest::collection::vec(op(), 1..40)) {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        let outcome = rt.block_on(run(ops, true));
        prop_assert!(outcome.is_ok(), "{}", outcome.unwrap_err());
    }
}
