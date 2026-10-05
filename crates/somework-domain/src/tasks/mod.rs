//! Durable tasks: submission/routing, leases and fencing, progress, completion, cancellation, reconciliation and
//! the maintenance reaper. Canonical state lives in SQLite; NATS/Matrix are projections fed by the outbox.

mod authority;
mod cancel;
mod query;
mod reaper;
mod submit;
mod worker;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use somework_core::{
    Error, ErrorCode,
    contracts::*,
    fsm::{self, Event, TaskState},
    ids, subjects,
};
use sqlx::{SqliteConnection, sqlite::SqliteRow};

pub use authority::EffectiveAuthority;
pub use cancel::{ApprovalView, CancelRequest, DecideApproval, ReconcileRequest, action_digest};
pub use query::{TaskFilter, TaskList, TaskTreeNode};
pub use reaper::MaintenanceReport;
pub use submit::{SubmitTask, SubmitTaskResponse};
pub use worker::{
    ClaimRequest, ClaimResponse, CompleteRequest, FailRequest, HeartbeatRequest, HeartbeatResponse, InputRequest, ProgressRequest, ProgressStatus,
};

use crate::{
    audit::AuditRecord,
    db::{DbResultExt, icol, jcol, jcol_opt, scol, scol_opt},
    domain::{Ctx, Domain},
    events::EventSpec,
    messages::SystemMessage,
};

/// Everything the task logic needs about a stored task. Mutated in memory, then persisted with an optimistic
/// revision check by [`Domain::commit_transition`].
#[derive(Debug, Clone)]
pub struct TaskRow {
    pub task_id: String,
    pub conversation_id: Option<String>,
    pub parent_task_id: Option<String>,
    pub capability_id: String,
    pub capability_version: String,
    pub side_effects: SideEffects,
    pub snapshot: Capability,
    pub requester: ActorRef,
    pub requester_principal_id: String,
    pub target_agent_id: Option<String>,
    pub pool_id: Option<String>,
    pub assignee_agent_id: Option<String>,
    pub assignee_principal_id: Option<String>,
    pub state: TaskState,
    pub revision: i64,
    pub attempt: i64,
    pub input: Value,
    pub context_refs: Vec<ContextRef>,
    pub lease_id: Option<String>,
    pub lease_runtime_instance_id: Option<String>,
    pub lease_expires_at: Option<String>,
    pub fencing_counter: i64,
    pub authorization_token_id: Option<String>,
    pub policy_decision_id: Option<String>,
    pub effective_authority: Option<EffectiveAuthority>,
    pub constraints: Option<Value>,
    pub delegation_depth_remaining: i64,
    pub result: Option<Value>,
    pub result_artifacts: Vec<ArtifactRef>,
    pub failure: Option<Failure>,
    pub blocker: Option<Value>,
    pub idempotency_key: Option<String>,
    pub traceparent: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deadline_at: Option<String>,
    pub completed_at: Option<String>,
}

impl TaskRow {
    pub(crate) fn from_row(r: &SqliteRow) -> Result<Self, Error> {
        let state = TaskState::parse(&scol(r, "state")).ok_or_else(|| Error::internal("stored task has an unknown state"))?;
        Ok(Self {
            task_id: scol(r, "task_id"),
            conversation_id: scol_opt(r, "conversation_id"),
            parent_task_id: scol_opt(r, "parent_task_id"),
            capability_id: scol(r, "capability_id"),
            capability_version: scol(r, "capability_version"),
            side_effects: SideEffects::parse(&scol(r, "side_effects")).unwrap_or(SideEffects::Irreversible),
            snapshot: serde_json::from_value(jcol(r, "capability_snapshot"))?,
            requester: serde_json::from_value(jcol(r, "requester"))?,
            requester_principal_id: scol(r, "requester_principal_id"),
            target_agent_id: scol_opt(r, "target_agent_id"),
            pool_id: scol_opt(r, "pool_id"),
            assignee_agent_id: scol_opt(r, "assignee_agent_id"),
            assignee_principal_id: scol_opt(r, "assignee_principal_id"),
            state,
            revision: icol(r, "revision"),
            attempt: icol(r, "attempt"),
            input: jcol(r, "input"),
            context_refs: serde_json::from_value(jcol(r, "context_refs")).unwrap_or_default(),
            lease_id: scol_opt(r, "lease_id"),
            lease_runtime_instance_id: scol_opt(r, "lease_runtime_instance_id"),
            lease_expires_at: scol_opt(r, "lease_expires_at"),
            fencing_counter: icol(r, "fencing_counter"),
            authorization_token_id: scol_opt(r, "authorization_token_id"),
            policy_decision_id: scol_opt(r, "policy_decision_id"),
            effective_authority: jcol_opt(r, "effective_authority").and_then(|v| serde_json::from_value(v).ok()),
            constraints: jcol_opt(r, "constraints"),
            delegation_depth_remaining: icol(r, "delegation_depth_remaining"),
            result: jcol_opt(r, "result"),
            result_artifacts: serde_json::from_value(jcol(r, "result_artifacts")).unwrap_or_default(),
            failure: jcol_opt(r, "failure").and_then(|v| serde_json::from_value(v).ok()),
            blocker: jcol_opt(r, "blocker"),
            idempotency_key: scol_opt(r, "idempotency_key"),
            traceparent: scol_opt(r, "traceparent"),
            created_at: scol(r, "created_at"),
            updated_at: scol(r, "updated_at"),
            deadline_at: scol_opt(r, "deadline_at"),
            completed_at: scol_opt(r, "completed_at"),
        })
    }

    pub fn lease(&self) -> Option<Lease> {
        match (&self.lease_id, &self.lease_runtime_instance_id, &self.lease_expires_at) {
            (Some(id), Some(rt), Some(exp)) => {
                Some(Lease { lease_id: id.clone(), runtime_instance_id: rt.clone(), fencing_token: self.fencing_counter as u64, expires_at: exp.clone() })
            }
            _ => None,
        }
    }

    pub fn lease_expired(&self, now: &str) -> bool {
        self.lease_expires_at.as_deref().is_some_and(|e| e <= now)
    }

    pub fn to_task(&self, domain_id: &str) -> Task {
        Task {
            task_id: self.task_id.clone(),
            domain_id: domain_id.to_string(),
            conversation_id: self.conversation_id.clone(),
            parent_task_id: self.parent_task_id.clone(),
            capability: CapabilityRef { id: self.capability_id.clone(), version: self.capability_version.clone() },
            requester: self.requester.clone(),
            target_agent_id: self.target_agent_id.clone(),
            assignee: self.assignee_agent_id.as_ref().map(|id| ActorRef {
                kind: ActorKind::Agent,
                id: id.clone(),
                domain_id: domain_id.to_string(),
                display_name: None,
            }),
            state: self.state,
            revision: self.revision as u64,
            attempt: self.attempt as u64,
            input: self.input.clone(),
            context_refs: self.context_refs.clone(),
            lease: self.lease(),
            authorization_token_id: self.authorization_token_id.clone(),
            policy_decision_id: self.policy_decision_id.clone(),
            result: self.result.clone(),
            result_artifacts: self.result_artifacts.clone(),
            failure: self.failure.clone(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            deadline_at: self.deadline_at.clone(),
            completed_at: self.completed_at.clone(),
            idempotency_key: self.idempotency_key.clone(),
        }
    }

    pub fn is_idempotent_action(&self) -> bool {
        self.snapshot.is_idempotent()
    }
}

/// Task as returned by the API: the canonical `Task` plus platform extras that are not part of the v1 contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskView {
    #[serde(flatten)]
    pub task: Task,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocker: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_approval: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancel_late: Option<bool>,
    pub side_effects: SideEffects,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_authority: Option<EffectiveAuthority>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEventView {
    pub task_id: String,
    pub event_sequence: i64,
    pub event_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub from_state: Option<String>,
    pub to_state: Option<String>,
    pub revision: i64,
    pub actor: Value,
    pub data: Value,
    pub trace_id: Option<String>,
    pub created_at: String,
}

/// Column changes applied together with a state transition.
#[derive(Default)]
pub(crate) struct TransitionData {
    pub data: Value,
    pub extra_nats: Vec<(String, Value)>,
    pub wake_assignee: bool,
    pub notify_requester_wake: bool,
    pub post_status_message: Option<String>,
    pub matrix_coalesce: bool,
    pub topics: Vec<String>,
}

impl Domain {
    pub(crate) async fn load_task(&self, conn: &mut SqliteConnection, task_id: &str) -> Result<TaskRow, Error> {
        let row =
            sqlx::query("SELECT * FROM tasks WHERE task_id = ?").bind(task_id).fetch_optional(conn).await.db()?.ok_or_else(|| Error::not_found("task"))?;
        TaskRow::from_row(&row)
    }

    pub(crate) async fn task_view(&self, conn: &mut SqliteConnection, row: &TaskRow) -> Result<TaskView, Error> {
        let pending = if row.state == TaskState::Submitted {
            sqlx::query("SELECT approval_id, task_revision, action_digest, action, expires_at, status FROM approvals WHERE task_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1")
                .bind(&row.task_id)
                .fetch_optional(&mut *conn)
                .await
                .db()?
                .map(|r| json!({"approvalId": scol(&r, "approval_id"), "taskRevision": icol(&r, "task_revision"), "actionDigest": scol(&r, "action_digest"), "action": scol(&r, "action"), "expiresAt": scol(&r, "expires_at")}))
        } else {
            None
        };
        let cancel_late = if row.state.is_terminal() && matches!(row.state, TaskState::Succeeded | TaskState::Failed) {
            let late: Option<String> = sqlx::query_scalar(
                "SELECT data FROM task_events WHERE task_id = ? AND type IN ('task.succeeded','task.failed') ORDER BY event_sequence DESC LIMIT 1",
            )
            .bind(&row.task_id)
            .fetch_optional(&mut *conn)
            .await
            .db()?;
            late.and_then(|d| serde_json::from_str::<Value>(&d).ok()).and_then(|v| v.get("cancelRequestedTooLate").and_then(Value::as_bool))
        } else {
            None
        };
        Ok(TaskView {
            task: row.to_task(&self.cfg.domain_id),
            blocker: row.blocker.clone(),
            pending_approval: pending,
            cancel_late,
            side_effects: row.side_effects,
            effective_authority: row.effective_authority.clone(),
        })
    }

    /// Applies `event` to `row`, persists the new revision (compare-and-swap on the old one), appends the task event
    /// and emits the durable event, recipients and outbox rows. `row` must already carry the field changes.
    pub(crate) async fn commit_transition(
        &self,
        conn: &mut SqliteConnection,
        ctx: &Ctx,
        row: &mut TaskRow,
        event: Event,
        event_type: &str,
        td: TransitionData,
    ) -> Result<(), Error> {
        let from = row.state;
        let to = fsm::next_state(from, event)?;
        let old_revision = row.revision;
        row.state = to;
        row.revision += 1;
        row.updated_at = self.now_ts();
        if to.is_terminal() {
            row.completed_at = Some(row.updated_at.clone());
            row.lease_id = None;
            row.lease_expires_at = None;
            row.lease_runtime_instance_id = None;
        }
        self.persist_task(conn, row, old_revision).await?;
        let sequence: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(event_sequence), 0) + 1 FROM task_events WHERE task_id = ?")
            .bind(&row.task_id)
            .fetch_one(&mut *conn)
            .await
            .db()?;
        let event_id = ids::event_id();
        sqlx::query("INSERT INTO task_events(task_id, event_sequence, event_id, type, from_state, to_state, revision, actor, data, trace_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(&row.task_id)
            .bind(sequence)
            .bind(&event_id)
            .bind(format!("task.{}", event_type.trim_start_matches("task.")))
            .bind(from.as_str())
            .bind(to.as_str())
            .bind(row.revision)
            .bind(serde_json::to_string(&ctx.actor.actor_ref())?)
            .bind(td.data.to_string())
            .bind(&ctx.trace.trace_id)
            .bind(&row.updated_at)
            .execute(&mut *conn)
            .await
            .db()?;
        self.emit_task_event(conn, ctx, row, event_type, sequence, td).await?;
        if to.is_terminal() {
            self.after_terminal(conn, ctx, row).await?;
        }
        Ok(())
    }

    /// Persists a field-only change (no state change), still revision-guarded: used for checkpoints and ownership moves.
    pub(crate) async fn commit_update(
        &self,
        conn: &mut SqliteConnection,
        ctx: &Ctx,
        row: &mut TaskRow,
        event_type: &str,
        td: TransitionData,
    ) -> Result<(), Error> {
        let old_revision = row.revision;
        row.revision += 1;
        row.updated_at = self.now_ts();
        self.persist_task(conn, row, old_revision).await?;
        let sequence: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(event_sequence), 0) + 1 FROM task_events WHERE task_id = ?")
            .bind(&row.task_id)
            .fetch_one(&mut *conn)
            .await
            .db()?;
        sqlx::query("INSERT INTO task_events(task_id, event_sequence, event_id, type, from_state, to_state, revision, actor, data, trace_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(&row.task_id)
            .bind(sequence)
            .bind(ids::event_id())
            .bind(format!("task.{}", event_type.trim_start_matches("task.")))
            .bind(row.state.as_str())
            .bind(row.state.as_str())
            .bind(row.revision)
            .bind(serde_json::to_string(&ctx.actor.actor_ref())?)
            .bind(td.data.to_string())
            .bind(&ctx.trace.trace_id)
            .bind(&row.updated_at)
            .execute(&mut *conn)
            .await
            .db()?;
        self.emit_task_event(conn, ctx, row, event_type, sequence, td).await?;
        Ok(())
    }

    async fn persist_task(&self, conn: &mut SqliteConnection, row: &TaskRow, old_revision: i64) -> Result<(), Error> {
        let res = sqlx::query(
            "UPDATE tasks SET state = ?, revision = ?, attempt = ?, assignee_agent_id = ?, assignee_principal_id = ?, lease_id = ?, lease_runtime_instance_id = ?, lease_expires_at = ?,
               fencing_counter = ?, authorization_token_id = ?, effective_authority = ?, result = ?, result_artifacts = ?, failure = ?, blocker = ?, pool_id = ?, context_refs = ?,
               updated_at = ?, completed_at = ?, policy_decision_id = ? WHERE task_id = ? AND revision = ?",
        )
        .bind(row.state.as_str())
        .bind(row.revision)
        .bind(row.attempt)
        .bind(&row.assignee_agent_id)
        .bind(&row.assignee_principal_id)
        .bind(&row.lease_id)
        .bind(&row.lease_runtime_instance_id)
        .bind(&row.lease_expires_at)
        .bind(row.fencing_counter)
        .bind(&row.authorization_token_id)
        .bind(row.effective_authority.as_ref().map(|a| serde_json::to_string(a).unwrap_or_default()))
        .bind(row.result.as_ref().map(Value::to_string))
        .bind(serde_json::to_string(&row.result_artifacts)?)
        .bind(row.failure.as_ref().map(|f| serde_json::to_string(f).unwrap_or_default()))
        .bind(row.blocker.as_ref().map(Value::to_string))
        .bind(&row.pool_id)
        .bind(serde_json::to_string(&row.context_refs)?)
        .bind(&row.updated_at)
        .bind(&row.completed_at)
        .bind(&row.policy_decision_id)
        .bind(&row.task_id)
        .bind(old_revision)
        .execute(conn)
        .await
        .db()?;
        if res.rows_affected() != 1 {
            return Err(Error::new(ErrorCode::StaleRevision, "task changed concurrently; re-read it and retry")
                .with_details(json!({"taskId": row.task_id, "expectedRevision": old_revision})));
        }
        Ok(())
    }

    async fn emit_task_event(
        &self,
        conn: &mut SqliteConnection,
        ctx: &Ctx,
        row: &TaskRow,
        event_type: &str,
        sequence: i64,
        td: TransitionData,
    ) -> Result<(), Error> {
        let base = json!({
            "taskId": row.task_id,
            "revision": row.revision,
            "state": row.state.as_str(),
            "eventSequence": sequence,
            "conversationId": row.conversation_id,
            "capabilityId": row.capability_id,
            "capabilityVersion": row.capability_version,
            "attempt": row.attempt,
        });
        let kind = format!("task.{}", event_type.trim_start_matches("task."));
        let mut spec = EventSpec::new(&kind, base.clone()).task(&row.task_id, row.revision).conversation(row.conversation_id.clone()).matrix();
        spec.capability_id = Some(row.capability_id.clone());
        spec = spec.nats(subjects::event_task(&row.task_id), base.clone());
        spec = spec.recipient(row.requester_principal_id.clone(), td.notify_requester_wake);
        if let Some(assignee) = &row.assignee_principal_id {
            spec = spec.recipient(assignee.clone(), td.wake_assignee);
        }
        if td.matrix_coalesce {
            spec = spec.coalesce(format!("task:{}:{}", row.task_id, event_type));
        }
        spec.topics = td.topics.clone();
        // work-ready notifications contain only what is needed to claim the canonical task
        if row.state == TaskState::Queued && (event_type == "queued" || event_type == "requeued" || event_type == "reconciled_retry") {
            for (subject, pool) in self.work_subjects(conn, row).await? {
                spec = spec.nats(
                    subject,
                    json!({
                        "taskId": row.task_id,
                        "revision": row.revision,
                        "capabilityId": row.capability_id,
                        "capabilityVersion": row.capability_version,
                        "poolId": pool,
                    }),
                );
            }
        }
        if row.state == TaskState::Queued && (event_type == "queued" || event_type == "requeued" || event_type == "reconciled_retry") {
            let remote = self.remote_targets(conn, row).await?;
            spec.gateway.extend(self.egress_routes(row, &remote));
        }
        if let (Some(agent), true) = (&row.assignee_agent_id, td.wake_assignee) {
            spec =
                spec.nats(subjects::inbox(agent), json!({"kind": "task", "taskId": row.task_id, "revision": row.revision, "event": event_type, "wake": true}));
        }
        for (subject, payload) in td.extra_nats {
            spec = spec.nats(subject, payload);
        }
        self.emit(conn, ctx, spec).await?;
        if let Some(text) = td.post_status_message
            && let Some(conversation) = &row.conversation_id
        {
            let mut msg = SystemMessage::new(
                somework_core::contracts::MessageType::TaskStatus,
                json!({"text": text, "state": row.state.as_str(), "revision": row.revision, "event": event_type}),
            );
            msg.conversation_id = Some(conversation.clone());
            msg.task_id = Some(row.task_id.clone());
            msg.recipients = vec![(row.requester.clone(), "requester".into())];
            self.post_system_message(conn, ctx, msg).await?;
        }
        Ok(())
    }

    /// Subjects (and pool ids) a work-ready notification is published to.
    pub(crate) async fn work_subjects_pub(&self, conn: &mut SqliteConnection, row: &TaskRow) -> Result<Vec<(String, String)>, Error> {
        self.work_subjects(conn, row).await
    }

    async fn work_subjects(&self, conn: &mut SqliteConnection, row: &TaskRow) -> Result<Vec<(String, String)>, Error> {
        let mut pools: Vec<String> = Vec::new();
        if let Some(target) = &row.target_agent_id {
            let pool: Option<String> =
                sqlx::query_scalar("SELECT pool_id FROM agents WHERE agent_id = ?").bind(target).fetch_optional(&mut *conn).await.db()?;
            pools.push(pool.unwrap_or_else(|| target.clone()));
        } else {
            for (_, pool) in self.eligible_agents(conn, &row.capability_id, &row.capability_version).await? {
                if !pools.contains(&pool) {
                    pools.push(pool);
                }
            }
        }
        Ok(pools.into_iter().map(|p| (subjects::work_pool(&p), p)).collect())
    }

    /// Hook run inside the transaction that moves a task to a terminal state.
    async fn after_terminal(&self, conn: &mut SqliteConnection, ctx: &Ctx, row: &TaskRow) -> Result<(), Error> {
        self.metrics.tasks_terminal.with_label_values(&[row.state.as_str()]).inc();
        if let (Some(created), Some(done)) =
            (somework_core::clock::parse_ts(&row.created_at), row.completed_at.as_deref().and_then(somework_core::clock::parse_ts))
        {
            self.metrics
                .task_duration
                .with_label_values(&[row.capability_id.as_str(), row.state.as_str()])
                .observe((done - created).num_milliseconds().max(0) as f64 / 1000.0);
        }
        if let Some(jti) = &row.authorization_token_id {
            self.revoke_grant(conn, jti).await?;
        }
        sqlx::query("UPDATE approvals SET status = 'superseded' WHERE task_id = ? AND status = 'pending'").bind(&row.task_id).execute(&mut *conn).await.db()?;
        // result projection for the requester; never wakes anyone (task.result is non-triggering)
        if let Some(conversation) = &row.conversation_id
            && matches!(row.state, TaskState::Succeeded | TaskState::Failed)
        {
            let mut msg = SystemMessage::new(
                MessageType::TaskResult,
                json!({
                    "taskId": row.task_id,
                    "state": row.state.as_str(),
                    "revision": row.revision,
                    "resultDigest": row.result.as_ref().map(somework_core::canonical::digest_json),
                    "failure": row.failure,
                    "artifacts": row.result_artifacts.iter().map(|a| a.uri.clone()).collect::<Vec<_>>(),
                }),
            );
            msg.conversation_id = Some(conversation.clone());
            msg.task_id = Some(row.task_id.clone());
            msg.recipients = vec![(row.requester.clone(), "requester".into())];
            msg.artifacts = row.result_artifacts.clone();
            self.post_system_message(conn, ctx, msg).await?;
        }
        // a delegating worker waiting on this child learns about it through its inbox (wake: task-state trigger)
        if let Some(parent_id) = &row.parent_task_id
            && let Ok(parent) = self.load_task(conn, parent_id).await
            && let (Some(agent), false) = (&parent.assignee_agent_id, parent.state.is_terminal())
        {
            let payload =
                json!({"kind": "child_finished", "taskId": parent.task_id, "childTaskId": row.task_id, "childState": row.state.as_str(), "wake": true});
            let spec = EventSpec::new("task.child_finished", payload.clone())
                .task(&parent.task_id, parent.revision)
                .conversation(parent.conversation_id.clone())
                .recipient(parent.assignee_principal_id.clone().unwrap_or_default(), true)
                .nats(subjects::inbox(agent), payload);
            self.emit(conn, ctx, spec).await?;
        }
        Ok(())
    }

    pub(crate) async fn require_task_participant(&self, conn: &mut SqliteConnection, ctx: &Ctx, task_id: &str) -> Result<TaskRow, Error> {
        let row = self.load_task(conn, task_id).await?;
        if self.is_task_participant(conn, ctx, &row).await? { Ok(row) } else { Err(Error::not_found("task")) }
    }

    pub(crate) async fn is_task_participant(&self, conn: &mut SqliteConnection, ctx: &Ctx, row: &TaskRow) -> Result<bool, Error> {
        if ctx.actor.permissions.allows_action("task.read.any") {
            return Ok(true);
        }
        if let Some(scope) = &ctx.actor.task_scope
            && scope != &row.task_id
            && row.parent_task_id.as_deref() != Some(scope)
        {
            return Ok(false);
        }
        if row.requester_principal_id == ctx.actor.principal_id || row.assignee_principal_id.as_deref() == Some(&ctx.actor.principal_id) {
            return Ok(true);
        }
        if ctx.actor.kind == ActorKind::Agent && row.target_agent_id.as_deref() == Some(&ctx.actor.id) {
            return Ok(true);
        }
        if let Some(conv) = &row.conversation_id
            && ctx.actor.kind == ActorKind::Human
            && self.is_member(conn, conv, &ctx.actor.principal_id).await?
        {
            return Ok(true);
        }
        // the requester of a parent task may see delegated children (supervision)
        if let Some(parent) = &row.parent_task_id {
            let pr: Option<String> =
                sqlx::query_scalar("SELECT requester_principal_id FROM tasks WHERE task_id = ?").bind(parent).fetch_optional(&mut *conn).await.db()?;
            if pr.as_deref() == Some(&ctx.actor.principal_id) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub async fn get_task(&self, ctx: &Ctx, task_id: &str) -> Result<TaskView, Error> {
        self.enforce_read(ctx, crate::policy::AuthzRequest::action(Action::TaskRead).resource(format!("task://{task_id}"))).await?;
        let mut conn = self.db.pool().acquire().await.db()?;
        let row = self.require_task_participant(&mut conn, ctx, task_id).await?;
        self.task_view(&mut conn, &row).await
    }

    pub async fn list_task_events(&self, ctx: &Ctx, task_id: &str, after: i64, limit: i64) -> Result<Vec<TaskEventView>, Error> {
        self.enforce_read(ctx, crate::policy::AuthzRequest::action(Action::TaskRead).resource(format!("task://{task_id}"))).await?;
        let mut conn = self.db.pool().acquire().await.db()?;
        self.require_task_participant(&mut conn, ctx, task_id).await?;
        let rows = sqlx::query("SELECT * FROM task_events WHERE task_id = ? AND event_sequence > ? ORDER BY event_sequence ASC LIMIT ?")
            .bind(task_id)
            .bind(after)
            .bind(limit.clamp(1, 1000))
            .fetch_all(&mut *conn)
            .await
            .db()?;
        Ok(rows
            .iter()
            .map(|r| TaskEventView {
                task_id: scol(r, "task_id"),
                event_sequence: icol(r, "event_sequence"),
                event_id: scol(r, "event_id"),
                kind: scol(r, "type"),
                from_state: scol_opt(r, "from_state"),
                to_state: scol_opt(r, "to_state"),
                revision: icol(r, "revision"),
                actor: jcol(r, "actor"),
                data: jcol(r, "data"),
                trace_id: scol_opt(r, "trace_id"),
                created_at: scol(r, "created_at"),
            })
            .collect())
    }

    pub(crate) fn check_expected_revision(&self, ctx: &Ctx, explicit: Option<u64>, row: &TaskRow) -> Result<(), Error> {
        if let Some(expected) = explicit.or(ctx.if_match)
            && expected as i64 != row.revision
        {
            return Err(Error::new(ErrorCode::StaleRevision, format!("expected revision {expected} but the task is at revision {}", row.revision))
                .with_details(json!({"currentRevision": row.revision, "state": row.state.as_str()})));
        }
        Ok(())
    }

    pub(crate) async fn audit_task(
        &self,
        conn: &mut SqliteConnection,
        ctx: &Ctx,
        action: &str,
        row: &TaskRow,
        before: Option<&TaskState>,
        decision: Option<&crate::policy::Decision>,
        detail: Value,
    ) -> Result<(), Error> {
        let mut rec = AuditRecord::new(action, Some(format!("task://{}", row.task_id)), "success")
            .task(Some(row.task_id.clone()))
            .conversation(row.conversation_id.clone())
            .states(
                before.map(|s| somework_core::canonical::sha256_hex(format!("{}:{}", row.task_id, s.as_str()).as_bytes())),
                Some(somework_core::canonical::sha256_hex(format!("{}:{}:{}", row.task_id, row.state.as_str(), row.revision).as_bytes())),
            )
            .detail(detail);
        if let Some(d) = decision {
            rec = rec.decision(d);
        }
        self.audit(conn, ctx, rec).await?;
        Ok(())
    }
}
