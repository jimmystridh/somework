use chrono::Duration;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use somework_core::{
    Error, ErrorCode,
    canonical::digest_json,
    clock::{parse_ts, ts},
    contracts::*,
    fsm::{Event, TaskState},
    ids, jws, schema,
};
use sqlx::SqliteConnection;

use super::{TaskRow, TaskView, TransitionData, authority::EffectiveAuthority};
use crate::{
    db::{DbResultExt, scol},
    domain::{Ctx, Domain},
    messages::SystemMessage,
    policy::AuthzRequest,
};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ClaimRequest {
    pub lease_seconds: Option<i64>,
    pub expected_revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimResponse {
    pub task: TaskView,
    pub lease: Lease,
    pub fencing_token: u64,
    /// Task-bound grant narrowed to the effective task authority; presented by sidecars when acting for the task.
    pub authorization_token: String,
    pub capability: Capability,
    pub authority: EffectiveAuthority,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct HeartbeatRequest {
    pub fencing_token: Option<u64>,
    pub lease_seconds: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatResponse {
    pub lease: Lease,
    pub state: TaskState,
    pub revision: u64,
    pub cancel_requested: bool,
    pub authorization_token: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProgressStatus {
    Running,
    InputRequired,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProgressRequest {
    pub fencing_token: Option<u64>,
    pub expected_revision: Option<u64>,
    pub status: Option<ProgressStatus>,
    pub message: Option<String>,
    pub checkpoint: Option<Value>,
    pub percent: Option<f64>,
    /// For `input_required`: what the worker needs from the requester.
    pub question: Option<Value>,
    /// For `blocked`: ids of tasks (or other known dependencies) being waited on.
    pub blocked_on: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct InputRequest {
    pub data: Value,
    pub expected_revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CompleteRequest {
    pub fencing_token: Option<u64>,
    pub expected_revision: Option<u64>,
    pub result: Option<Value>,
    pub artifacts: Vec<ArtifactRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FailRequest {
    pub fencing_token: Option<u64>,
    pub expected_revision: Option<u64>,
    pub failure: Option<Failure>,
}

impl Domain {
    /// Requires a registered, active runtime instance for the calling agent and refreshes its liveness.
    pub(crate) async fn require_runtime(&self, conn: &mut SqliteConnection, ctx: &Ctx) -> Result<String, Error> {
        if ctx.actor.kind != ActorKind::Agent {
            return Err(Error::denied("only agent runtimes may act on tasks as workers"));
        }
        let rt = ctx.actor.runtime_instance_id.clone().ok_or_else(|| Error::denied("worker credentials must carry a runtimeInstanceId"))?;
        let res = sqlx::query("UPDATE runtime_instances SET last_seen_at = ? WHERE runtime_instance_id = ? AND agent_id = ? AND status = 'active'")
            .bind(self.now_ts())
            .bind(&rt)
            .bind(&ctx.actor.id)
            .execute(conn)
            .await
            .db()?;
        if res.rows_affected() == 0 {
            return Err(Error::denied("runtime instance is not registered or has ended; register it first"));
        }
        Ok(rt)
    }

    fn clamp_lease(&self, requested: Option<i64>) -> i64 {
        requested.unwrap_or(self.cfg.default_lease_seconds).clamp(1, self.cfg.max_lease_seconds)
    }

    async fn mint_task_grant(
        &self,
        conn: &mut SqliteConnection,
        ctx: &Ctx,
        row: &TaskRow,
        authority: &EffectiveAuthority,
        ttl: Duration,
        parent_jti: Option<String>,
    ) -> Result<String, Error> {
        let mut claims = self.grant_claims(ctx.actor.actor_ref(), Some(row.task_id.clone()), ttl, &authority.policy_version);
        claims.actions = authority.actions.iter().filter_map(|a| Action::parse(a)).collect();
        claims.capabilities = vec![row.capability_id.clone()];
        claims.resources = vec![format!("task://{}", row.task_id)];
        claims.constraints = Some(json!({"sideEffectsAtMost": authority.side_effects_at_most.as_str()}));
        claims.classification_max = Some(authority.classification_max.clone());
        claims.delegation = Some(DelegationClaim { allowed: authority.delegation_allowed, remaining_depth: authority.delegation_remaining });
        claims.parent_jti = parent_jti;
        self.issue_grant(conn, claims).await
    }

    pub async fn claim_task(&self, ctx: &Ctx, task_id: &str, req: ClaimRequest) -> Result<ClaimResponse, Error> {
        self.run(ctx, "task.claim", async {
            let this = self.clone();
            let ctx = ctx.clone();
            let task_id = task_id.to_string();
            self.write(move |tx| {
                Box::pin(async move {
                    let conn: &mut SqliteConnection = tx;
                    let runtime = this.require_runtime(conn, &ctx).await?;
                    let mut row = this.load_task(conn, &task_id).await?;
                    let now = this.now_ts();

                    // idempotent re-claim by the same runtime (the first response may have been lost)
                    if row.state.is_leased() && row.lease_runtime_instance_id.as_deref() == Some(&runtime) && row.assignee_principal_id.as_deref() == Some(&ctx.actor.principal_id) && !row.lease_expired(&now) {
                        let authority = row.effective_authority.clone().ok_or_else(|| Error::internal("leased task has no authority"))?;
                        let token = this.mint_task_grant(conn, &ctx, &row, &authority, Duration::seconds(this.cfg.max_lease_seconds), row.authorization_token_id.clone()).await?;
                        sqlx::query("UPDATE tasks SET authorization_token_id = ? WHERE task_id = ?").bind(
                            this.authorization_jti(&token)
                        ).bind(&row.task_id).execute(&mut *conn).await.db()?;
                        let view = this.task_view(conn, &row).await?;
                        return Ok(ClaimResponse { lease: row.lease().ok_or_else(|| Error::internal("lease missing"))?, fencing_token: row.fencing_counter as u64, authorization_token: token, capability: row.snapshot.clone(), authority, task: view });
                    }
                    // a lapsed lease is resolved first, so a racing claim never sees a stale owner
                    if row.state.is_leased() && row.lease_expired(&now) {
                        this.expire_lease_tx(conn, &ctx, &mut row).await?;
                    }
                    if row.state.is_leased() {
                        return Err(Error::new(ErrorCode::AlreadyClaimed, "task is already claimed").with_details(json!({"state": row.state.as_str()})));
                    }
                    this.check_expected_revision(&ctx, req.expected_revision, &row)?;
                    somework_core::fsm::next_state(row.state, Event::Claim)?;

                    let decision = this
                        .enforce(conn, &ctx, AuthzRequest::action(Action::TaskClaim).capability(&row.capability_id, row.side_effects).resource(format!("task://{}", row.task_id)).task(&row.task_id))
                        .await?;
                    let offered: Option<i64> = sqlx::query_scalar("SELECT 1 FROM agent_capabilities ac JOIN catalog_entries c ON c.agent_id = ac.agent_id JOIN agents a ON a.agent_id = ac.agent_id WHERE ac.agent_id = ? AND ac.capability_id = ? AND ac.capability_version = ? AND c.approval_status = 'approved' AND a.status <> 'disabled'")
                        .bind(&ctx.actor.id)
                        .bind(&row.capability_id)
                        .bind(&row.capability_version)
                        .fetch_optional(&mut *conn)
                        .await
                        .db()?;
                    if offered.is_none() || row.target_agent_id.as_deref().is_some_and(|t| t != ctx.actor.id) {
                        let policy = this.active_policy(conn).await?;
                        let denied = crate::policy::Decision { decision_id: ids::decision_id(), allow: false, reasons: vec!["agent is not eligible to claim this task".into()], obligations: vec![], policy_version: policy.version };
                        let mut err = Error::denied("agent is not eligible to claim this task");
                        err.details = Some(json!({"decision": denied, "action": "task.claim", "resource": format!("task://{}", row.task_id), "taskId": row.task_id}));
                        return Err(err);
                    }
                    let authority = this.compute_authority(conn, &row, &ctx.actor.permissions).await?;
                    if !authority.permits_side_effects(row.side_effects) {
                        return Err(Error::denied("the agent's authority does not cover the capability's side-effect class"));
                    }

                    let queued_at: Option<String> = sqlx::query_scalar("SELECT created_at FROM task_events WHERE task_id = ? AND to_state = 'queued' ORDER BY event_sequence DESC LIMIT 1").bind(&row.task_id).fetch_optional(&mut *conn).await.db()?;
                    let lease_seconds = this.clamp_lease(req.lease_seconds);
                    row.fencing_counter += 1;
                    row.lease_id = Some(ids::lease_id());
                    row.lease_runtime_instance_id = Some(runtime.clone());
                    row.lease_expires_at = Some(ts(this.now() + Duration::seconds(lease_seconds)));
                    row.assignee_agent_id = Some(ctx.actor.id.clone());
                    row.assignee_principal_id = Some(ctx.actor.principal_id.clone());
                    row.effective_authority = Some(authority.clone());
                    row.policy_decision_id = Some(decision.decision_id.clone());
                    let token = this.mint_task_grant(conn, &ctx, &row, &authority, Duration::seconds(this.cfg.max_lease_seconds), None).await?;
                    row.authorization_token_id = Some(this.authorization_jti(&token));
                    if let Some(conversation) = &row.conversation_id {
                        this.add_member(conn, conversation, &ctx.actor.principal_id, "member").await?;
                    }
                    let before = row.state;
                    let claim_data = json!({"runtimeInstanceId": runtime, "fencingToken": row.fencing_counter, "leaseExpiresAt": row.lease_expires_at, "attempt": row.attempt});
                    this.commit_transition(conn, &ctx, &mut row, Event::Claim, "claimed", TransitionData {
                        data: claim_data,
                        post_status_message: Some(format!("Claimed by {}", ctx.actor.id)),
                        ..Default::default()
                    })
                    .await?;
                    this.audit_task(conn, &ctx, "task.claim", &row, Some(&before), Some(&decision), json!({"fencingToken": row.fencing_counter, "runtimeInstanceId": runtime})).await?;
                    if let Some(q) = queued_at.as_deref().and_then(parse_ts) {
                        this.metrics.task_claim_latency.observe((this.now() - q).num_milliseconds().max(0) as f64 / 1000.0);
                    }
                    let view = this.task_view(conn, &row).await?;
                    Ok(ClaimResponse { lease: row.lease().ok_or_else(|| Error::internal("lease missing"))?, fencing_token: row.fencing_counter as u64, authorization_token: token, capability: row.snapshot.clone(), authority, task: view })
                })
            })
            .await
        })
        .await
    }

    pub(crate) fn authorization_jti(&self, token: &str) -> String {
        jws::parse(token).ok().and_then(|t| t.claims.get("jti").and_then(Value::as_str).map(String::from)).unwrap_or_default()
    }

    pub async fn heartbeat_task(&self, ctx: &Ctx, task_id: &str, req: HeartbeatRequest) -> Result<HeartbeatResponse, Error> {
        self.run(ctx, "task.heartbeat", async {
            let this = self.clone();
            let ctx = ctx.clone();
            let task_id = task_id.to_string();
            self.write(move |tx| {
                Box::pin(async move {
                    let conn: &mut SqliteConnection = tx;
                    this.require_runtime(conn, &ctx).await?;
                    let mut row = this.load_task(conn, &task_id).await?;
                    this.verify_lease(&row, &ctx, req.fencing_token)?;
                    let lease_seconds = this.clamp_lease(req.lease_seconds);
                    let new_expiry = ts(this.now() + Duration::seconds(lease_seconds));
                    let extended = row.lease_expires_at.clone().filter(|e| *e > new_expiry).unwrap_or(new_expiry);
                    // not a state change: no revision bump, so requesters' revision checks are unaffected
                    sqlx::query("UPDATE tasks SET lease_expires_at = ? WHERE task_id = ? AND lease_id = ? AND fencing_counter = ?")
                        .bind(&extended)
                        .bind(&row.task_id)
                        .bind(&row.lease_id)
                        .bind(row.fencing_counter)
                        .execute(&mut *conn)
                        .await
                        .db()?;
                    row.lease_expires_at = Some(extended.clone());
                    let mut token = None;
                    if let (Some(authority), Some(jti)) = (row.effective_authority.clone(), row.authorization_token_id.clone()) {
                        let grant_expiry: Option<String> =
                            sqlx::query_scalar("SELECT expires_at FROM auth_grants WHERE jti = ?").bind(&jti).fetch_optional(&mut *conn).await.db()?;
                        if grant_expiry.is_none_or(|e| e <= extended) {
                            let fresh =
                                this.mint_task_grant(conn, &ctx, &row, &authority, Duration::seconds(this.cfg.max_lease_seconds), Some(jti.clone())).await?;
                            let new_jti = this.authorization_jti(&fresh);
                            sqlx::query("UPDATE tasks SET authorization_token_id = ? WHERE task_id = ?")
                                .bind(&new_jti)
                                .bind(&row.task_id)
                                .execute(&mut *conn)
                                .await
                                .db()?;
                            this.revoke_grant(conn, &jti).await?;
                            token = Some(fresh);
                        }
                    }
                    Ok(HeartbeatResponse {
                        lease: row.lease().ok_or_else(|| Error::internal("lease missing"))?,
                        state: row.state,
                        revision: row.revision as u64,
                        cancel_requested: row.state == TaskState::CancelRequested,
                        authorization_token: token,
                    })
                })
            })
            .await
        })
        .await
    }

    pub async fn progress_task(&self, ctx: &Ctx, task_id: &str, req: ProgressRequest) -> Result<TaskView, Error> {
        self.run(ctx, "task.progress", async {
            if let Some(cp) = &req.checkpoint {
                self.check_inline_size(cp, "checkpoint")?;
            }
            let this = self.clone();
            let ctx = ctx.clone();
            let task_id = task_id.to_string();
            self.write(move |tx| {
                Box::pin(async move {
                    let conn: &mut SqliteConnection = tx;
                    this.require_runtime(conn, &ctx).await?;
                    let mut row = this.load_task(conn, &task_id).await?;
                    this.verify_lease(&row, &ctx, req.fencing_token)?;
                    this.check_expected_revision(&ctx, req.expected_revision, &row)?;
                    let decision = this
                        .enforce(conn, &ctx, AuthzRequest::action(Action::TaskUpdate).resource(format!("task://{}", row.task_id)).task(&row.task_id))
                        .await?;
                    let status = req.status.unwrap_or(ProgressStatus::Running);
                    let mut data = json!({"message": req.message, "checkpoint": req.checkpoint, "percent": req.percent});
                    let before = row.state;
                    let message = req.message.clone();
                    match (row.state, status) {
                        (TaskState::Claimed, ProgressStatus::Running) => {
                            this.commit_transition(
                                conn,
                                &ctx,
                                &mut row,
                                Event::Start,
                                "running",
                                TransitionData { data, post_status_message: message.or(Some("Started".into())), ..Default::default() },
                            )
                            .await?;
                        }
                        (TaskState::Claimed, _) => {
                            this.commit_transition(
                                conn,
                                &ctx,
                                &mut row,
                                Event::Start,
                                "running",
                                TransitionData { data: json!({"implicit": true}), ..Default::default() },
                            )
                            .await?;
                            this.progress_state_change(conn, &ctx, &mut row, status, &req, &mut data).await?;
                        }
                        (TaskState::Running, ProgressStatus::Running) => {
                            this.commit_update(
                                conn,
                                &ctx,
                                &mut row,
                                "progress",
                                TransitionData { data, post_status_message: message, matrix_coalesce: true, ..Default::default() },
                            )
                            .await?;
                        }
                        (TaskState::Running, _) => {
                            this.progress_state_change(conn, &ctx, &mut row, status, &req, &mut data).await?;
                        }
                        (TaskState::Blocked, ProgressStatus::Running) => {
                            if row.blocker.as_ref().and_then(|b| b.get("kind")).and_then(Value::as_str) == Some("reconciliation") {
                                return Err(Error::new(ErrorCode::InvalidTransition, "the task awaits operator reconciliation"));
                            }
                            row.blocker = None;
                            this.commit_transition(
                                conn,
                                &ctx,
                                &mut row,
                                Event::Resume,
                                "resumed",
                                TransitionData { data, post_status_message: message.or(Some("Resumed".into())), ..Default::default() },
                            )
                            .await?;
                        }
                        (TaskState::InputRequired, ProgressStatus::Running) => {
                            return Err(Error::new(ErrorCode::InvalidTransition, "the task is waiting for input from the requester"));
                        }
                        (TaskState::CancelRequested, _) => {
                            this.commit_update(conn, &ctx, &mut row, "progress", TransitionData { data, matrix_coalesce: true, ..Default::default() }).await?;
                        }
                        (state, _) => {
                            return Err(Error::new(ErrorCode::InvalidTransition, format!("progress cannot be reported in state {state}")));
                        }
                    }
                    this.audit_task(
                        conn,
                        &ctx,
                        "task.progress",
                        &row,
                        Some(&before),
                        Some(&decision),
                        json!({"status": status, "hasCheckpoint": req.checkpoint.is_some()}),
                    )
                    .await?;
                    this.task_view(conn, &row).await
                })
            })
            .await
        })
        .await
    }

    async fn progress_state_change(
        &self,
        conn: &mut SqliteConnection,
        ctx: &Ctx,
        row: &mut TaskRow,
        status: ProgressStatus,
        req: &ProgressRequest,
        data: &mut Value,
    ) -> Result<(), Error> {
        match status {
            ProgressStatus::InputRequired => {
                row.blocker = Some(json!({"kind": "input_required", "question": req.question}));
                data["question"] = req.question.clone().unwrap_or(Value::Null);
                self.commit_transition(
                    conn,
                    ctx,
                    row,
                    Event::RequireInput,
                    "input_required",
                    TransitionData {
                        data: data.clone(),
                        post_status_message: Some(req.message.clone().unwrap_or_else(|| "Input required".into())),
                        notify_requester_wake: false,
                        ..Default::default()
                    },
                )
                .await
            }
            ProgressStatus::Blocked => {
                row.blocker = Some(json!({"kind": "dependency", "waitingOn": req.blocked_on}));
                data["blockedOn"] = json!(req.blocked_on);
                self.commit_transition(
                    conn,
                    ctx,
                    row,
                    Event::Block,
                    "blocked",
                    TransitionData {
                        data: data.clone(),
                        post_status_message: Some(req.message.clone().unwrap_or_else(|| "Blocked on a dependency".into())),
                        ..Default::default()
                    },
                )
                .await
            }
            ProgressStatus::Running => Ok(()),
        }
    }

    /// Requester (or a supervising human in the task conversation) supplies the requested input.
    pub async fn provide_input(&self, ctx: &Ctx, task_id: &str, req: InputRequest) -> Result<TaskView, Error> {
        self.run(ctx, "task.input", async {
            self.check_inline_size(&req.data, "input")?;
            let this = self.clone();
            let ctx = ctx.clone();
            let task_id = task_id.to_string();
            self.write(move |tx| {
                Box::pin(async move {
                    let conn: &mut SqliteConnection = tx;
                    let mut row = this.require_task_participant(conn, &ctx, &task_id).await?;
                    let decision = this
                        .enforce(conn, &ctx, AuthzRequest::action(Action::TaskUpdate).resource(format!("task://{}", row.task_id)).task(&row.task_id))
                        .await?;
                    let is_requester = row.requester_principal_id == ctx.actor.principal_id;
                    let supervising_human = ctx.actor.kind == ActorKind::Human;
                    if !is_requester && !supervising_human && !ctx.actor.is_admin() {
                        return Err(Error::denied("only the requester or a supervising human may provide input"));
                    }
                    this.check_expected_revision(&ctx, req.expected_revision, &row)?;
                    if row.state != TaskState::InputRequired {
                        return Err(Error::new(ErrorCode::InvalidTransition, format!("task is {}, not input_required", row.state)));
                    }
                    let before = row.state;
                    row.blocker = None;
                    // the input travels as a `task.input` message (triggerMode task-state): it wakes the assignee's runtime
                    if let Some(conversation) = &row.conversation_id {
                        let assignee = row.assignee_agent_id.clone().map(|id| ActorRef::new(ActorKind::Agent, id, this.cfg.domain_id.clone()));
                        let mut msg = SystemMessage::new(MessageType::TaskInput, json!({"taskId": row.task_id, "data": req.data}));
                        msg.conversation_id = Some(conversation.clone());
                        msg.task_id = Some(row.task_id.clone());
                        msg.trigger = Some(TriggerMode::TaskState);
                        msg.recipients = assignee.into_iter().map(|a| (a, "assignee".to_string())).collect();
                        this.post_system_message(conn, &ctx, msg).await?;
                    }
                    this.commit_transition(
                        conn,
                        &ctx,
                        &mut row,
                        Event::Resume,
                        "input_provided",
                        TransitionData {
                            data: json!({"inputDigest": digest_json(&req.data)}),
                            wake_assignee: true,
                            post_status_message: Some("Input provided".into()),
                            ..Default::default()
                        },
                    )
                    .await?;
                    this.audit_task(conn, &ctx, "task.input", &row, Some(&before), Some(&decision), json!({"inputDigest": digest_json(&req.data)})).await?;
                    this.task_view(conn, &row).await
                })
            })
            .await
        })
        .await
    }

    pub async fn complete_task(&self, ctx: &Ctx, task_id: &str, req: CompleteRequest) -> Result<TaskView, Error> {
        self.run(ctx, "task.complete", async {
            let result = req.result.clone().ok_or_else(|| Error::invalid("result is required"))?;
            self.check_inline_size(&result, "task result")?;
            if !req.artifacts.is_empty() {
                self.require_object_store_healthy().await?;
            }
            let this = self.clone();
            let ctx = ctx.clone();
            let task_id = task_id.to_string();
            self.write(move |tx| {
                Box::pin(async move {
                    let conn: &mut SqliteConnection = tx;
                    this.require_runtime(conn, &ctx).await?;
                    let mut row = this.load_task(conn, &task_id).await?;
                    this.verify_lease(&row, &ctx, req.fencing_token)?;
                    this.check_expected_revision(&ctx, req.expected_revision, &row)?;
                    let decision = this
                        .enforce(conn, &ctx, AuthzRequest::action(Action::TaskUpdate).resource(format!("task://{}", row.task_id)).task(&row.task_id))
                        .await?;
                    somework_core::fsm::next_state(row.state, Event::Complete)?;
                    // TASK-03: the result must satisfy the capability's output schema
                    schema::validate_against(&row.snapshot.output_schema, &result, "task result")?;
                    // ART-03: every referenced artifact must be fully uploaded and digest-verified
                    let artifacts = this.verify_result_artifacts(conn, &ctx, &row, &req.artifacts).await?;
                    let cancel_late = row.state == TaskState::CancelRequested;
                    let before = row.state;
                    row.result = Some(result.clone());
                    let artifact_uris: Vec<String> = artifacts.iter().map(|a| a.uri.clone()).collect();
                    row.result_artifacts = artifacts;
                    this.commit_transition(
                        conn,
                        &ctx,
                        &mut row,
                        Event::Complete,
                        "succeeded",
                        TransitionData {
                            data: json!({"resultDigest": digest_json(&result), "cancelRequestedTooLate": cancel_late, "artifacts": artifact_uris}),
                            post_status_message: Some("Task succeeded".into()),
                            ..Default::default()
                        },
                    )
                    .await?;
                    this.audit_task(
                        conn,
                        &ctx,
                        "task.complete",
                        &row,
                        Some(&before),
                        Some(&decision),
                        json!({"resultDigest": digest_json(&result), "cancelRequestedTooLate": cancel_late}),
                    )
                    .await?;
                    this.task_view(conn, &row).await
                })
            })
            .await
        })
        .await
    }

    pub async fn fail_task(&self, ctx: &Ctx, task_id: &str, req: FailRequest) -> Result<TaskView, Error> {
        self.run(ctx, "task.fail", async {
            let failure = req.failure.clone().ok_or_else(|| Error::invalid("failure is required"))?;
            if failure.code.trim().is_empty() {
                return Err(Error::invalid("failure.code is required"));
            }
            if let Some(d) = &failure.details {
                self.check_inline_size(d, "failure details")?;
            }
            let this = self.clone();
            let ctx = ctx.clone();
            let task_id = task_id.to_string();
            self.write(move |tx| {
                Box::pin(async move {
                    let conn: &mut SqliteConnection = tx;
                    this.require_runtime(conn, &ctx).await?;
                    let mut row = this.load_task(conn, &task_id).await?;
                    this.verify_lease(&row, &ctx, req.fencing_token)?;
                    this.check_expected_revision(&ctx, req.expected_revision, &row)?;
                    let decision = this
                        .enforce(conn, &ctx, AuthzRequest::action(Action::TaskUpdate).resource(format!("task://{}", row.task_id)).task(&row.task_id))
                        .await?;
                    somework_core::fsm::next_state(row.state, Event::Fail)?;
                    let cancel_late = row.state == TaskState::CancelRequested;
                    let before = row.state;
                    row.failure = Some(failure.clone());
                    this.commit_transition(
                        conn,
                        &ctx,
                        &mut row,
                        Event::Fail,
                        "failed",
                        TransitionData {
                            data: json!({"code": failure.code, "retryable": failure.retryable, "cancelRequestedTooLate": cancel_late}),
                            post_status_message: Some(format!("Task failed: {}", failure.code)),
                            ..Default::default()
                        },
                    )
                    .await?;
                    this.audit_task(conn, &ctx, "task.fail", &row, Some(&before), Some(&decision), json!({"code": failure.code})).await?;
                    this.task_view(conn, &row).await
                })
            })
            .await
        })
        .await
    }

    /// `GET /v1/tasks/next`: queued tasks this worker could claim, oldest first (poll fallback when NATS is absent).
    pub async fn next_tasks(&self, ctx: &Ctx, limit: i64, wait: std::time::Duration) -> Result<Vec<Value>, Error> {
        if ctx.actor.kind != ActorKind::Agent {
            return Err(Error::denied("only agents poll for work"));
        }
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let notified = self.event_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let rows = sqlx::query(
                "SELECT t.task_id, t.revision, t.capability_id, t.capability_version, t.attempt FROM tasks t
                 JOIN agent_capabilities ac ON ac.agent_id = ? AND ac.capability_id = t.capability_id AND ac.capability_version = t.capability_version
                 JOIN catalog_entries c ON c.agent_id = ac.agent_id AND c.approval_status = 'approved'
                 WHERE t.state = 'queued' AND (t.target_agent_id IS NULL OR t.target_agent_id = ?) ORDER BY t.created_at ASC LIMIT ?",
            )
            .bind(&ctx.actor.id)
            .bind(&ctx.actor.id)
            .bind(limit.clamp(1, 50))
            .fetch_all(self.db.pool())
            .await
            .db()?;
            if !rows.is_empty() || tokio::time::Instant::now() >= deadline {
                return Ok(rows.iter().map(|r| json!({"taskId": scol(r, "task_id"), "revision": crate::db::icol(r, "revision"), "capabilityId": scol(r, "capability_id"), "capabilityVersion": scol(r, "capability_version"), "attempt": crate::db::icol(r, "attempt")})).collect());
            }
            let remaining = deadline - tokio::time::Instant::now();
            let _ = tokio::time::timeout(remaining.min(std::time::Duration::from_millis(250)), notified).await;
        }
    }
}
