mod common;

use common::*;
use serde_json::json;
use somework_core::{
    ErrorCode,
    contracts::{ActorKind, SideEffects},
    fsm::TaskState,
};
use somework_domain::tasks::{ClaimRequest, CompleteRequest, ProgressRequest};

#[tokio::test]
async fn happy_path_submit_claim_progress_complete() {
    let env = Env::new().await;
    let worker = env
        .worker(
            "agent/reviewer",
            vec![capability("code.review", "2.1", "read", "Review pull requests for correctness and security")],
            worker_permissions(SideEffects::Read),
        )
        .await;
    let caller = env.create_principal(ActorKind::Agent, "agent/author", Some(caller_permissions(&["code.review"], SideEffects::Read))).await;

    let c = env.ctx(&caller).await;
    let submitted = env.domain.submit_task(&c, submit("code.review", "2.1")).await.unwrap();
    assert_eq!(submitted.task.task.state, TaskState::Queued);
    assert_eq!(submitted.task.task.revision, 2, "submitted(1) -> queued(2)");
    let task_id = submitted.task.task.task_id.clone();

    let w = env.ctx(&worker).await;
    let claim = env.domain.claim_task(&w, &task_id, ClaimRequest::default()).await.unwrap();
    assert_eq!(claim.fencing_token, 1);
    assert_eq!(claim.task.task.state, TaskState::Claimed);

    let running = env
        .domain
        .progress_task(&w, &task_id, ProgressRequest { fencing_token: Some(1), message: Some("reading diff".into()), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(running.task.state, TaskState::Running);

    let bad = env
        .domain
        .complete_task(&w, &task_id, CompleteRequest { fencing_token: Some(1), result: Some(json!({"verdict": "maybe"})), ..Default::default() })
        .await
        .unwrap_err();
    assert_eq!(bad.code, ErrorCode::SchemaViolation);

    let done = env
        .domain
        .complete_task(&w, &task_id, CompleteRequest { fencing_token: Some(1), result: Some(json!({"verdict": "approve"})), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(done.task.state, TaskState::Succeeded);
    assert!(done.task.lease.is_none());

    let events = env.domain.list_task_events(&c, &task_id, 0, 100).await.unwrap();
    let kinds: Vec<&str> = events.iter().map(|e| e.kind.as_str()).collect();
    assert_eq!(kinds, ["task.submitted", "task.queued", "task.claimed", "task.running", "task.succeeded"]);
    assert_eq!(env.domain.verify_audit_chain().await.unwrap(), None);
}

async fn setup() -> (Env, Principal, Principal) {
    let env = Env::new().await;
    let worker = env
        .worker(
            "agent/reviewer",
            vec![capability("code.review", "2.1", "read", "Review pull requests for correctness and security")],
            worker_permissions(SideEffects::Read),
        )
        .await;
    let caller = env.create_principal(ActorKind::Agent, "agent/author", Some(caller_permissions(&["code.review"], SideEffects::Read))).await;
    (env, worker, caller)
}

async fn queued(env: &Env, caller: &Principal) -> String {
    let c = env.ctx(caller).await;
    env.domain.submit_task(&c, submit("code.review", "2.1")).await.unwrap().task.task.task_id
}

#[tokio::test]
async fn idempotent_submit_returns_the_same_task_and_conflicts_on_different_payload() {
    let (env, _worker, caller) = setup().await;
    let c = env.ctx(&caller).await.with_idempotency("review-pr-729-at-61a8d52");
    let first = env.domain.submit_task(&c, submit("code.review", "2.1")).await.unwrap();
    let again = env.domain.submit_task(&c, submit("code.review", "2.1")).await.unwrap();
    assert_eq!(first.task.task.task_id, again.task.task.task_id);
    let mut different = submit("code.review", "2.1");
    different.input = Some(json!({"repository": "other/repo"}));
    let err = env.domain.submit_task(&c, different).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::IdempotencyConflict);
    let all = env.domain.list_tasks(&env.ctx(&caller).await, Default::default()).await.unwrap();
    assert_eq!(all.tasks.len(), 1, "no duplicate canonical task");
}

#[tokio::test]
async fn racing_claims_produce_exactly_one_lease_owner() {
    let (env, worker, caller) = setup().await;
    let task_id = queued(&env, &caller).await;
    let second = env
        .worker(
            "agent/reviewer-2",
            vec![capability("code.review", "2.1", "read", "Review pull requests for correctness and security")],
            worker_permissions(SideEffects::Read),
        )
        .await;
    let a = env.ctx(&worker).await;
    let b = env.ctx(&second).await;
    let (ra, rb) = tokio::join!(env.domain.claim_task(&a, &task_id, ClaimRequest::default()), env.domain.claim_task(&b, &task_id, ClaimRequest::default()));
    let outcomes = [ra, rb];
    let winners = outcomes.iter().filter(|r| r.is_ok()).count();
    assert_eq!(winners, 1, "exactly one claim wins: {outcomes:?}");
    let loser = outcomes.iter().find_map(|r| r.as_ref().err()).unwrap();
    assert_eq!(loser.code, ErrorCode::AlreadyClaimed);
}

#[tokio::test]
async fn expired_lease_requeues_and_fencing_blocks_the_old_worker() {
    let (env, worker, caller) = setup().await;
    let task_id = queued(&env, &caller).await;
    let w = env.ctx(&worker).await;
    let claim = env.domain.claim_task(&w, &task_id, ClaimRequest { lease_seconds: Some(10), ..Default::default() }).await.unwrap();
    assert_eq!(claim.fencing_token, 1);
    env.domain.progress_task(&w, &task_id, ProgressRequest { fencing_token: Some(1), ..Default::default() }).await.unwrap();

    env.advance(30);
    let report = env.domain.run_maintenance().await.unwrap();
    assert_eq!(report.leases_requeued, 1);
    let view = env.domain.get_task(&env.ctx(&caller).await, &task_id).await.unwrap();
    assert_eq!(view.task.state, TaskState::Queued);
    assert_eq!(view.task.attempt, 2);

    // the stale worker can neither report progress nor complete
    let stale = env
        .domain
        .complete_task(&w, &task_id, CompleteRequest { fencing_token: Some(1), result: Some(json!({"verdict": "approve"})), ..Default::default() })
        .await
        .unwrap_err();
    assert!(matches!(stale.code, ErrorCode::LeaseExpired | ErrorCode::StaleFencingToken), "{stale:?}");

    // a new worker reclaims under fence 2; the old fence 1 stays useless afterwards
    let second = env.new_runtime(&worker).await;
    let w2 = env.ctx(&second).await;
    let claim2 = env.domain.claim_task(&w2, &task_id, ClaimRequest::default()).await.unwrap();
    assert_eq!(claim2.fencing_token, 2);
    env.domain.progress_task(&w2, &task_id, ProgressRequest { fencing_token: Some(2), ..Default::default() }).await.unwrap();
    let stale = env
        .domain
        .complete_task(&w, &task_id, CompleteRequest { fencing_token: Some(1), result: Some(json!({"verdict": "reject"})), ..Default::default() })
        .await
        .unwrap_err();
    assert_eq!(stale.code, ErrorCode::StaleFencingToken);
    let done = env
        .domain
        .complete_task(&w2, &task_id, CompleteRequest { fencing_token: Some(2), result: Some(json!({"verdict": "approve"})), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(done.task.state, TaskState::Succeeded);
}

#[tokio::test]
async fn heartbeat_extends_the_lease_so_it_survives_maintenance() {
    let (env, worker, caller) = setup().await;
    let task_id = queued(&env, &caller).await;
    let w = env.ctx(&worker).await;
    env.domain.claim_task(&w, &task_id, ClaimRequest { lease_seconds: Some(10), ..Default::default() }).await.unwrap();
    for _ in 0..3 {
        env.advance(8);
        env.domain.heartbeat_task(&w, &task_id, somework_domain::tasks::HeartbeatRequest { fencing_token: Some(1), lease_seconds: Some(10) }).await.unwrap();
        assert_eq!(env.domain.run_maintenance().await.unwrap().leases_requeued, 0);
    }
    let view = env.domain.get_task(&env.ctx(&caller).await, &task_id).await.unwrap();
    assert_eq!(view.task.state, TaskState::Claimed);
}

#[tokio::test]
async fn irreversible_tasks_are_never_auto_retried_they_wait_for_reconciliation() {
    let env = Env::new().await;
    let worker = env
        .worker(
            "agent/deployer",
            vec![capability("deployment.execute", "1", "irreversible", "Execute a production deployment")],
            worker_permissions(SideEffects::Irreversible),
        )
        .await;
    let caller = env.create_principal(ActorKind::Agent, "agent/pm", Some(caller_permissions(&["deployment.*"], SideEffects::Irreversible))).await;
    let approver = env
        .create_principal(
            ActorKind::Human,
            "human/alice",
            Some({
                let mut p = somework_domain::policy::Permissions::default_human();
                p.approves = vec!["deployment.*".into()];
                p
            }),
        )
        .await;
    let c = env.ctx(&caller).await;
    let submitted = env.domain.submit_task(&c, submit("deployment.execute", "1")).await.unwrap();
    assert_eq!(submitted.task.task.state, TaskState::Submitted, "irreversible work needs structured human approval first");
    let approval = env.domain.get_approval(&env.ctx(&approver).await, submitted.approval_id.as_deref().unwrap()).await.unwrap();
    let task_id = submitted.task.task.task_id.clone();
    let approved = env
        .domain
        .decide_approval(
            &env.ctx(&approver).await,
            &approval.approval_id,
            somework_domain::tasks::DecideApproval {
                decision: "approved".into(),
                action_digest: approval.action_digest.clone(),
                task_revision: approval.task_revision as u64,
                comment: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(approved.task.state, TaskState::Queued);

    let w = env.ctx(&worker).await;
    env.domain.claim_task(&w, &task_id, ClaimRequest { lease_seconds: Some(10), ..Default::default() }).await.unwrap();
    env.domain.progress_task(&w, &task_id, ProgressRequest { fencing_token: Some(1), ..Default::default() }).await.unwrap();
    env.advance(60);
    let report = env.domain.run_maintenance().await.unwrap();
    assert_eq!((report.leases_requeued, report.leases_reconciliation), (0, 1));
    let view = env.domain.get_task(&c, &task_id).await.unwrap();
    assert_eq!(view.task.state, TaskState::Blocked);
    assert_eq!(view.blocker.as_ref().unwrap()["kind"], "reconciliation");

    // nobody can claim it and the stale worker cannot write
    let other = env.new_runtime(&worker).await;
    let claim = env.domain.claim_task(&env.ctx(&other).await, &task_id, ClaimRequest::default()).await.unwrap_err();
    assert_eq!(claim.code, ErrorCode::AlreadyClaimed);
    let stale = env
        .domain
        .complete_task(&w, &task_id, CompleteRequest { fencing_token: Some(1), result: Some(json!({"verdict": "approve"})), ..Default::default() })
        .await
        .unwrap_err();
    assert!(matches!(stale.code, ErrorCode::LeaseExpired | ErrorCode::InvalidTransition), "{stale:?}");

    // an operator resolves it
    let resolved = env
        .domain
        .reconcile_task(
            &env.admin_ctx().await,
            &task_id,
            somework_domain::tasks::ReconcileRequest {
                resolution: "succeeded".into(),
                result: Some(json!({"verdict": "approve"})),
                note: Some("verified manually".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(resolved.task.state, TaskState::Succeeded);
}

#[tokio::test]
async fn idempotent_irreversible_actions_may_be_retried() {
    let env = Env::new().await;
    let mut cap = capability("config.apply", "1", "irreversible", "Apply a configuration idempotently");
    cap["tags"] = json!(["contract:idempotent"]);
    let worker = env.worker("agent/applier", vec![cap], worker_permissions(SideEffects::Irreversible)).await;
    let mut perms = caller_permissions(&["config.apply"], SideEffects::Irreversible);
    perms.approves = vec![];
    let caller = env.create_principal(ActorKind::Agent, "agent/pm", Some(perms)).await;
    let mut policy = env.domain.get_policy(&env.admin_ctx().await).await.unwrap();
    policy.version = "no-approval".into();
    policy.approvals.require_side_effects_at_least = None;
    env.domain.put_policy(&env.admin_ctx().await, policy).await.unwrap();
    let task = env.domain.submit_task(&env.ctx(&caller).await, submit("config.apply", "1")).await.unwrap();
    let id = task.task.task.task_id;
    let w = env.ctx(&worker).await;
    env.domain.claim_task(&w, &id, ClaimRequest { lease_seconds: Some(5), ..Default::default() }).await.unwrap();
    env.advance(30);
    assert_eq!(env.domain.run_maintenance().await.unwrap().leases_requeued, 1);
}

#[tokio::test]
async fn cancellation_is_immediate_before_claim_and_cooperative_after() {
    let (env, worker, caller) = setup().await;
    let c = env.ctx(&caller).await;
    let queued_id = queued(&env, &caller).await;
    let canceled = env.domain.cancel_task(&c, &queued_id, Default::default()).await.unwrap();
    assert_eq!(canceled.task.state, TaskState::Canceled);
    let again = env.domain.cancel_task(&c, &queued_id, Default::default()).await.unwrap_err();
    assert_eq!(again.code, ErrorCode::TaskTerminal);

    let running_id = queued(&env, &caller).await;
    let w = env.ctx(&worker).await;
    env.domain.claim_task(&w, &running_id, ClaimRequest::default()).await.unwrap();
    env.domain.progress_task(&w, &running_id, ProgressRequest { fencing_token: Some(1), ..Default::default() }).await.unwrap();
    let requested = env.domain.cancel_task(&c, &running_id, Default::default()).await.unwrap();
    assert_eq!(requested.task.state, TaskState::CancelRequested);
    let hb =
        env.domain.heartbeat_task(&w, &running_id, somework_domain::tasks::HeartbeatRequest { fencing_token: Some(1), lease_seconds: None }).await.unwrap();
    assert!(hb.cancel_requested);
    let acked = env
        .domain
        .cancel_task(&w, &running_id, somework_domain::tasks::CancelRequest { acknowledge: true, fencing_token: Some(1), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(acked.task.state, TaskState::Canceled);
}

#[tokio::test]
async fn cancellation_race_can_legitimately_resolve_to_completed() {
    let (env, worker, caller) = setup().await;
    let c = env.ctx(&caller).await;
    let id = queued(&env, &caller).await;
    let w = env.ctx(&worker).await;
    env.domain.claim_task(&w, &id, ClaimRequest::default()).await.unwrap();
    env.domain.progress_task(&w, &id, ProgressRequest { fencing_token: Some(1), ..Default::default() }).await.unwrap();
    env.domain.cancel_task(&c, &id, Default::default()).await.unwrap();
    let done = env
        .domain
        .complete_task(&w, &id, CompleteRequest { fencing_token: Some(1), result: Some(json!({"verdict": "approve"})), ..Default::default() })
        .await
        .unwrap();
    assert_eq!(done.task.state, TaskState::Succeeded);
    assert_eq!(done.cancel_late, Some(true), "the result records that cancellation arrived too late");
}

#[tokio::test]
async fn terminal_tasks_are_immutable_even_at_the_database_level() {
    let (env, worker, caller) = setup().await;
    let id = queued(&env, &caller).await;
    let w = env.ctx(&worker).await;
    env.domain.claim_task(&w, &id, ClaimRequest::default()).await.unwrap();
    env.domain.progress_task(&w, &id, ProgressRequest { fencing_token: Some(1), ..Default::default() }).await.unwrap();
    env.domain
        .complete_task(&w, &id, CompleteRequest { fencing_token: Some(1), result: Some(json!({"verdict": "approve"})), ..Default::default() })
        .await
        .unwrap();
    for sql in ["UPDATE tasks SET state = 'running' WHERE task_id = ?", "UPDATE tasks SET result = '{}' WHERE task_id = ?"] {
        let err = sqlx::query(sql).bind(&id).execute(env.domain.db.pool()).await.unwrap_err();
        assert!(err.to_string().contains("immutable"), "{err}");
    }
    for sql in ["DELETE FROM task_events WHERE task_id = ?", "UPDATE task_events SET type = 'x' WHERE task_id = ?"] {
        assert!(sqlx::query(sql).bind(&id).execute(env.domain.db.pool()).await.is_err());
    }
    assert!(sqlx::query("DELETE FROM audit_events").execute(env.domain.db.pool()).await.is_err());
    assert!(sqlx::query("UPDATE audit_events SET outcome = 'x'").execute(env.domain.db.pool()).await.is_err());
}

#[tokio::test]
async fn stale_expected_revision_is_rejected() {
    let (env, _worker, caller) = setup().await;
    let c = env.ctx(&caller).await;
    let id = queued(&env, &caller).await;
    let err = env.domain.cancel_task(&c, &id, somework_domain::tasks::CancelRequest { expected_revision: Some(1), ..Default::default() }).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::StaleRevision);
    let ok = env.domain.cancel_task(&c, &id, somework_domain::tasks::CancelRequest { expected_revision: Some(2), ..Default::default() }).await.unwrap();
    assert_eq!(ok.task.state, TaskState::Canceled);
}

#[tokio::test]
async fn deadline_expiry_moves_queued_tasks_to_expired() {
    let (env, _worker, caller) = setup().await;
    let c = env.ctx(&caller).await;
    let mut req = submit("code.review", "2.1");
    req.deadline_at = Some(somework_core::clock::ts(env.domain.now() + chrono::Duration::seconds(60)));
    let id = env.domain.submit_task(&c, req).await.unwrap().task.task.task_id;
    env.advance(120);
    assert_eq!(env.domain.run_maintenance().await.unwrap().deadlines_expired, 1);
    assert_eq!(env.domain.get_task(&c, &id).await.unwrap().task.state, TaskState::Expired);
}

#[tokio::test]
async fn input_required_round_trip_wakes_only_the_assignee() {
    let (env, worker, caller) = setup().await;
    let c = env.ctx(&caller).await;
    let id = queued(&env, &caller).await;
    let w = env.ctx(&worker).await;
    env.domain.claim_task(&w, &id, ClaimRequest::default()).await.unwrap();
    let asked = env
        .domain
        .progress_task(
            &w,
            &id,
            ProgressRequest {
                fencing_token: Some(1),
                status: Some(somework_domain::tasks::ProgressStatus::InputRequired),
                question: Some(json!({"need": "branch name"})),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(asked.task.state, TaskState::InputRequired);
    let resumed_by_worker = env.domain.progress_task(&w, &id, ProgressRequest { fencing_token: Some(1), ..Default::default() }).await.unwrap_err();
    assert_eq!(resumed_by_worker.code, ErrorCode::InvalidTransition);
    let provided =
        env.domain.provide_input(&c, &id, somework_domain::tasks::InputRequest { data: json!({"branch": "main"}), expected_revision: None }).await.unwrap();
    assert_eq!(provided.task.state, TaskState::Running);
    let events = env.domain.list_events(&w, 0, 100).await.unwrap();
    assert!(events.iter().any(|e| e.kind == "message.created" && e.payload["messageType"] == "task.input" && e.wake), "task.input wakes the assignee");
}

#[tokio::test]
async fn hidden_capabilities_look_nonexistent_to_unauthorized_callers() {
    let (env, _worker, _caller) = setup().await;
    let outsider = env.create_principal(ActorKind::Agent, "agent/outsider", Some(caller_permissions(&["something.else"], SideEffects::Read))).await;
    let c = env.ctx(&outsider).await;
    let hidden = env.domain.submit_task(&c, submit("code.review", "2.1")).await.unwrap_err();
    let missing = env.domain.submit_task(&c, submit("no.such.capability", "9")).await.unwrap_err();
    assert_eq!(hidden.code, ErrorCode::NotFound);
    assert_eq!(hidden.code, missing.code);
    assert_eq!(hidden.message.replace("code.review", "x"), missing.message.replace("no.such.capability", "x"));
}

#[tokio::test]
async fn confused_deputy_read_only_task_cannot_delegate_write_work() {
    let env = Env::new().await;
    let broad = {
        let mut p = worker_permissions(SideEffects::Irreversible);
        p.capabilities = vec!["*".into()];
        p.delegation = somework_domain::policy::DelegationPerm { allowed: true, max_depth: 3 };
        p.actions.push("task.delegate".into());
        p
    };
    let inspector = env
        .worker(
            "agent/deployer",
            vec![
                capability("deployment.inspect", "1", "read", "Inspect deployments"),
                capability("deployment.execute", "1", "irreversible", "Execute deployments"),
            ],
            broad,
        )
        .await;
    let mut caller_perms = caller_permissions(&["deployment.inspect"], SideEffects::Read);
    caller_perms.delegation = somework_domain::policy::DelegationPerm { allowed: true, max_depth: 2 };
    let caller = env.create_principal(ActorKind::Agent, "agent/dev", Some(caller_perms)).await;
    let c = env.ctx(&caller).await;

    // the caller may not invoke execute directly
    let direct = env.domain.submit_task(&c, submit("deployment.execute", "1")).await.unwrap_err();
    assert_eq!(direct.code, ErrorCode::NotFound, "not even discoverable for this caller");

    let task = env.domain.submit_task(&c, submit("deployment.inspect", "1")).await.unwrap().task.task.task_id;
    let w = env.ctx(&inspector).await;
    let claim = env.domain.claim_task(&w, &task, ClaimRequest::default()).await.unwrap();
    assert_eq!(
        claim.authority.side_effects_at_most,
        SideEffects::Read,
        "effective authority is capped by the capability and the requester, not the worker's own maximum"
    );
    env.domain.progress_task(&w, &task, ProgressRequest { fencing_token: Some(1), ..Default::default() }).await.unwrap();

    // the worker, acting under the task, tries to delegate the irreversible capability to itself
    let mut child = submit("deployment.execute", "1");
    child.parent_task_id = Some(task.clone());
    child.parent_fencing_token = Some(1);
    child.target_agent_id = Some("agent/deployer".into());
    let err = env.domain.submit_task(&w, child).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::PolicyDenied, "{err:?}");
    // delegating a read-only child within authority works
    let mut ok_child = submit("deployment.inspect", "1");
    ok_child.parent_task_id = Some(task.clone());
    ok_child.parent_fencing_token = Some(1);
    let child = env.domain.submit_task(&w, ok_child).await.unwrap();
    assert_eq!(child.task.task.parent_task_id.as_deref(), Some(task.as_str()));
    assert_eq!(env.domain.task_tree(&c, &task).await.unwrap().children.len(), 1);
}

#[tokio::test]
async fn delegation_depth_is_bounded() {
    let env = Env::new().await;
    let broad = {
        let mut p = worker_permissions(SideEffects::Read);
        p.capabilities = vec!["*".into()];
        p.delegation = somework_domain::policy::DelegationPerm { allowed: true, max_depth: 3 };
        p.actions.push("task.delegate".into());
        p
    };
    let worker = env.worker("agent/w", vec![capability("code.review", "2.1", "read", "Review")], broad).await;
    let mut caller_perms = caller_permissions(&["code.review"], SideEffects::Read);
    caller_perms.delegation = somework_domain::policy::DelegationPerm { allowed: true, max_depth: 1 };
    let caller = env.create_principal(ActorKind::Agent, "agent/c", Some(caller_perms)).await;
    let root = env.domain.submit_task(&env.ctx(&caller).await, submit("code.review", "2.1")).await.unwrap().task.task.task_id;
    let w = env.ctx(&worker).await;
    env.domain.claim_task(&w, &root, ClaimRequest::default()).await.unwrap();
    env.domain.progress_task(&w, &root, ProgressRequest { fencing_token: Some(1), ..Default::default() }).await.unwrap();
    let mut level1 = submit("code.review", "2.1");
    level1.parent_task_id = Some(root.clone());
    level1.parent_fencing_token = Some(1);
    let child = env.domain.submit_task(&w, level1).await.unwrap().task.task.task_id;
    // depth budget (1) is spent: the child's worker may not delegate again
    env.domain.claim_task(&w, &child, ClaimRequest::default()).await.unwrap();
    env.domain.progress_task(&w, &child, ProgressRequest { fencing_token: Some(1), ..Default::default() }).await.unwrap();
    let mut level2 = submit("code.review", "2.1");
    level2.parent_task_id = Some(child.clone());
    level2.parent_fencing_token = Some(1);
    let err = env.domain.submit_task(&w, level2).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::PolicyDenied);
}
