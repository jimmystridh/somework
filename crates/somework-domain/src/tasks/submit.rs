use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use somework_core::{Error, ErrorCode, canonical::digest_json, clock::parse_ts, contracts::*, fsm::Event, ids, schema};
use sqlx::SqliteConnection;

use super::{
    TaskRow, TaskView, TransitionData,
    authority::{AuthorityInputs, EffectiveAuthority},
};
use crate::{
    db::{DbResultExt, scol},
    domain::{Ctx, Domain},
    idempotency::Idem,
    messages::SystemMessage,
    policy::{AuthzRequest, Decision, OBLIGATION_REQUIRE_APPROVAL},
};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SubmitTask {
    pub capability: Option<CapabilityRef>,
    pub target_agent_id: Option<String>,
    pub conversation_id: Option<String>,
    pub parent_task_id: Option<String>,
    /// Required with `parentTaskId`: proves the caller currently holds the parent task's lease.
    pub parent_fencing_token: Option<u64>,
    pub input: Option<Value>,
    pub context_refs: Vec<ContextRef>,
    pub deadline_at: Option<String>,
    pub idempotency_key: Option<String>,
    /// Task-specific narrowing, e.g. `{"sideEffectsAtMost": "read"}`.
    pub constraints: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitTaskResponse {
    #[serde(flatten)]
    pub task: TaskView,
    pub approval_id: Option<String>,
}

impl Domain {
    pub async fn submit_task(&self, ctx: &Ctx, req: SubmitTask) -> Result<SubmitTaskResponse, Error> {
        let out = self.run(ctx, "task.submit", self.submit_task_inner(ctx, req)).await?;
        // Chaos hook: the transaction is durable here; a crash now must still result in eventual delivery.
        self.failpoint("task.submit.after_commit").await?;
        Ok(out)
    }

    async fn submit_task_inner(&self, ctx: &Ctx, req: SubmitTask) -> Result<SubmitTaskResponse, Error> {
        let cap_ref = req.capability.clone().ok_or_else(|| Error::invalid("capability is required"))?;
        let input = req.input.clone().unwrap_or_else(|| json!({}));
        if !input.is_object() {
            return Err(Error::invalid("input must be a JSON object"));
        }
        self.check_inline_size(&input, "task input")?;
        if let Some(deadline) = &req.deadline_at {
            let at = parse_ts(deadline).ok_or_else(|| Error::invalid("deadlineAt must be an RFC 3339 timestamp"))?;
            if at <= self.now() {
                return Err(Error::invalid("deadlineAt is already in the past"));
            }
        }
        if let Some(c) = &req.constraints
            && let Some(se) = c.get("sideEffectsAtMost")
        {
            se.as_str()
                .and_then(SideEffects::parse)
                .ok_or_else(|| Error::invalid("constraints.sideEffectsAtMost must be none, read, write or irreversible"))?;
        }
        let request_json = serde_json::to_value(&req)?;
        let mut ctx = ctx.clone();
        if ctx.idempotency_key.is_none() {
            ctx.idempotency_key = req.idempotency_key.clone();
        }
        let this = self.clone();
        self.write(move |tx| Box::pin(async move { this.submit_prepared(tx, &ctx, req, cap_ref, input, request_json).await })).await
    }

    /// Submits within an existing transaction (used by context subtasks and the federation gateway).
    pub(crate) async fn submit_task_in_tx(&self, conn: &mut SqliteConnection, ctx: &Ctx, req: SubmitTask) -> Result<SubmitTaskResponse, Error> {
        let cap_ref = req.capability.clone().ok_or_else(|| Error::invalid("capability is required"))?;
        let input = req.input.clone().unwrap_or_else(|| json!({}));
        if !input.is_object() {
            return Err(Error::invalid("input must be a JSON object"));
        }
        self.check_inline_size(&input, "task input")?;
        let request_json = serde_json::to_value(&req)?;
        self.submit_prepared(conn, ctx, req, cap_ref, input, request_json).await
    }

    async fn submit_prepared(
        &self,
        conn: &mut SqliteConnection,
        ctx: &Ctx,
        req: SubmitTask,
        cap_ref: CapabilityRef,
        input: Value,
        request_json: Value,
    ) -> Result<SubmitTaskResponse, Error> {
        let this = self;
        let ctx = ctx.clone();
        let slot = match this.idem_begin::<SubmitTaskResponse>(conn, &ctx, "task.submit", &request_json).await? {
            Idem::Replay(v) => return Ok(v),
            Idem::Fresh(slot) => slot,
        };

        // Contract lookup: hidden capabilities are indistinguishable from nonexistent ones.
        let delegating = req.parent_task_id.is_some();
        let visible = this.caller_can_see_capability(conn, &ctx, req.target_agent_id.as_deref(), &cap_ref.id, &cap_ref.version).await?;
        let row = sqlx::query("SELECT definition FROM capabilities WHERE domain_id = ? AND capability_id = ? AND version = ?")
            .bind(&this.cfg.domain_id)
            .bind(&cap_ref.id)
            .bind(&cap_ref.version)
            .fetch_optional(&mut *conn)
            .await
            .db()?;
        let capability: Capability = match (&row, visible) {
            (Some(r), true) => serde_json::from_str(&scol(r, "definition"))?,
            _ => return Err(Error::not_found("capability")),
        };
        schema::validate_against(&capability.input_schema, &input, "task input")?;

        let mut authz =
            AuthzRequest::action(if delegating { Action::TaskDelegate } else { Action::TaskSubmit }).capability(&capability.id, capability.side_effects);
        if delegating {
            authz = authz.resource(format!("task://{}", req.parent_task_id.clone().unwrap_or_default()));
        }
        // delegation: authority comes from the parent task, not from whatever the worker could do in general
        let mut parent_row = None;
        let mut parent_authority = None;
        if let Some(parent_id) = &req.parent_task_id {
            let parent = this.load_task(conn, parent_id).await.map_err(|_| Error::not_found("parent task"))?;
            if parent.assignee_principal_id.as_deref() != Some(&ctx.actor.principal_id) {
                return Err(Error::denied("only the current assignee may delegate a task"));
            }
            this.verify_lease(&parent, &ctx, req.parent_fencing_token)?;
            let authority = parent.effective_authority.clone().ok_or_else(|| Error::denied("parent task carries no authority"))?;
            authz.delegation_remaining = Some(authority.delegation_remaining);
            authz.task_id = Some(parent.task_id.clone());
            parent_authority = Some(authority);
            parent_row = Some(parent);
        }
        let mut decision = this.enforce(conn, &ctx, authz.clone()).await?;
        if let (Some(authority), Some(parent)) = (&parent_authority, &parent_row) {
            let policy = this.active_policy(conn).await?;
            let mut reasons = vec![];
            if !authority.capability_allowed(&capability.id) {
                reasons.push(format!("task authority does not cover capability {}", capability.id));
            }
            if !authority.permits_side_effects(capability.side_effects) {
                reasons.push(format!("task authority is limited to {} side effects", authority.side_effects_at_most.as_str()));
            }
            if !authority.delegation_allowed {
                reasons.push("delegation depth exhausted".into());
            }
            if !reasons.is_empty() {
                let denied =
                    Decision { decision_id: ids::decision_id(), allow: false, reasons: reasons.clone(), obligations: vec![], policy_version: policy.version };
                let mut err = Error::denied(reasons.join("; "));
                err.details =
                    Some(json!({"decision": denied, "action": "task.delegate", "resource": format!("task://{}", parent.task_id), "taskId": parent.task_id}));
                return Err(err);
            }
        }

        // routing
        let (target_agent_id, pool_id) = match &req.target_agent_id {
            Some(agent) => {
                let offered: Option<i64> = sqlx::query_scalar("SELECT 1 FROM agent_capabilities ac JOIN catalog_entries c ON c.agent_id = ac.agent_id WHERE ac.agent_id = ? AND ac.capability_id = ? AND ac.capability_version = ? AND c.approval_status = 'approved'")
                    .bind(agent)
                    .bind(&capability.id)
                    .bind(&capability.version)
                    .fetch_optional(&mut *conn)
                    .await
                    .db()?;
                if offered.is_none() {
                    return Err(Error::not_found("agent offering that capability"));
                }
                let pool: Option<String> =
                    sqlx::query_scalar("SELECT pool_id FROM agents WHERE agent_id = ?").bind(agent).fetch_optional(&mut *conn).await.db()?;
                (Some(agent.clone()), pool)
            }
            None => (None, None),
        };
        let eligible = this.eligible_agents(conn, &capability.id, &capability.version).await?;

        // conversation
        let now = this.now_ts();
        let task_id = ids::task_id();
        let conversation_id = match &req.conversation_id {
            Some(id) => {
                if !this.is_member(conn, id, &ctx.actor.principal_id).await? {
                    return Err(Error::denied("requester is not a member of the conversation"));
                }
                Some(id.clone())
            }
            None => {
                let id = ids::conversation_id();
                sqlx::query("INSERT INTO conversations(conversation_id, domain_id, kind, title, classification, created_by, task_id, created_at) VALUES (?, ?, 'task', ?, 'internal', ?, ?, ?)")
                    .bind(&id)
                    .bind(&this.cfg.domain_id)
                    .bind(format!("{} ({})", capability.name, &task_id[task_id.len().saturating_sub(8)..]))
                    .bind(&ctx.actor.principal_id)
                    .bind(&task_id)
                    .bind(&now)
                    .execute(&mut *conn)
                    .await
                    .db()?;
                this.add_member(conn, &id, &ctx.actor.principal_id, "owner").await?;
                Some(id)
            }
        };
        if let (Some(conv), Some(agent)) = (&conversation_id, &target_agent_id)
            && let Some(p) = this.principal_by_label(conn, ActorKind::Agent, agent).await?
        {
            this.add_member(conn, conv, &p.principal_id, "member").await?;
        }
        this.check_context_refs(conn, &ctx, &req.context_refs).await?;

        let delegation_remaining = match &parent_authority {
            Some(a) => a.delegation_remaining.saturating_sub(1) as i64,
            None if ctx.actor.permissions.delegation.allowed => ctx.actor.permissions.delegation.max_depth as i64,
            None => 0,
        };
        sqlx::query(
            "INSERT INTO tasks(task_id, domain_id, conversation_id, parent_task_id, capability_id, capability_version, side_effects, capability_snapshot, requester, requester_principal_id,
               target_agent_id, pool_id, state, revision, attempt, input, context_refs, policy_decision_id, delegation_depth_remaining, idempotency_key, traceparent, created_at, updated_at, deadline_at, constraints)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&task_id)
        .bind(&this.cfg.domain_id)
        .bind(&conversation_id)
        .bind(&req.parent_task_id)
        .bind(&capability.id)
        .bind(&capability.version)
        .bind(capability.side_effects.as_str())
        .bind(serde_json::to_string(&capability)?)
        .bind(serde_json::to_string(&ctx.actor.actor_ref())?)
        .bind(&ctx.actor.principal_id)
        .bind(&target_agent_id)
        .bind(&pool_id)
        .bind(input.to_string())
        .bind(serde_json::to_string(&req.context_refs)?)
        .bind(&decision.decision_id)
        .bind(delegation_remaining)
        .bind(req.idempotency_key.clone().or_else(|| ctx.idempotency_key.clone()))
        .bind(ctx.trace.traceparent())
        .bind(&now)
        .bind(&now)
        .bind(&req.deadline_at)
        .bind(req.constraints.as_ref().map(Value::to_string))
        .execute(&mut *conn)
        .await
        .map_err(|e| match crate::db::db_error(e) {
            err if err.code == ErrorCode::Conflict => Error::new(ErrorCode::IdempotencyConflict, "idempotency key already used for another task"),
            err => err,
        })?;
        let mut row = this.load_task(conn, &task_id).await?;
        let initial = TransitionData {
            data: json!({"capability": capability.id, "version": capability.version, "targetAgentId": target_agent_id}),
            post_status_message: None,
            ..Default::default()
        };
        this.emit_task_submitted(conn, &ctx, &row, initial).await?;

        let mut approval_id = None;
        let needs_approval = decision.obligations.iter().any(|o| o == OBLIGATION_REQUIRE_APPROVAL);
        if needs_approval {
            approval_id = Some(this.request_approval(conn, &ctx, &row, &decision).await?);
        } else if eligible.is_empty() && target_agent_id.is_none() {
            let before = row.state;
            row.failure = Some(Failure {
                code: "no_eligible_agent".into(),
                message: format!("no approved agent offers {}@{}", capability.id, capability.version),
                retryable: true,
                details: None,
            });
            this.commit_transition(
                conn,
                &ctx,
                &mut row,
                Event::Reject,
                "rejected",
                TransitionData {
                    data: json!({"reason": "no_eligible_agent"}),
                    post_status_message: Some("Task rejected: no eligible agent".into()),
                    ..Default::default()
                },
            )
            .await?;
            this.audit_task(conn, &ctx, "task.submit", &row, Some(&before), Some(&decision), json!({"outcome": "rejected"})).await?;
        } else if this.is_remote_only(conn, &row).await? {
            // no local agent can serve this: the gateway forwards it and routes the task once the remote side accepts
            let agents = this.remote_targets(conn, &row).await?;
            this.emit_egress_request(conn, &ctx, &row, &agents).await?;
        } else {
            this.route_task(conn, &ctx, &mut row, "queued").await?;
        }
        decision.decision_id = row.policy_decision_id.clone().unwrap_or(decision.decision_id);
        this.audit_task(
            conn,
            &ctx,
            "task.submit",
            &row,
            None,
            Some(&decision),
            json!({"capability": capability.id, "approvalRequired": needs_approval, "inputDigest": digest_json(&input)}),
        )
        .await?;
        let view = this.task_view(conn, &row).await?;
        let response = SubmitTaskResponse { task: view, approval_id };
        this.idem_finish(conn, &ctx, slot, &response).await?;
        this.metrics.tasks_submitted.inc();
        Ok(response)
    }

    async fn emit_task_submitted(&self, conn: &mut SqliteConnection, ctx: &Ctx, row: &TaskRow, td: TransitionData) -> Result<(), Error> {
        // revision 1: the canonical row plus its first task event; nothing is published for `submitted` itself
        sqlx::query("INSERT INTO task_events(task_id, event_sequence, event_id, type, from_state, to_state, revision, actor, data, trace_id, created_at) VALUES (?, 1, ?, 'task.submitted', NULL, 'submitted', 1, ?, ?, ?, ?)")
            .bind(&row.task_id)
            .bind(ids::event_id())
            .bind(serde_json::to_string(&ctx.actor.actor_ref())?)
            .bind(td.data.to_string())
            .bind(&ctx.trace.trace_id)
            .bind(&row.created_at)
            .execute(&mut *conn)
            .await
            .db()?;
        if let Some(conversation) = &row.conversation_id {
            let mut msg = SystemMessage::new(
                MessageType::TaskRequest,
                json!({"taskId": row.task_id, "capability": {"id": row.capability_id, "version": row.capability_version}, "state": "submitted", "targetAgentId": row.target_agent_id, "inputDigest": digest_json(&row.input)}),
            );
            msg.conversation_id = Some(conversation.clone());
            msg.task_id = Some(row.task_id.clone());
            msg.trigger = Some(TriggerMode::TaskState);
            msg.recipients = vec![];
            // task.request is a projection of the task; the work queue (not this message) wakes workers
            self.post_task_request(conn, ctx, msg).await?;
        }
        Ok(())
    }

    /// Task-request projection message: delivered to the conversation without waking anyone through the inbox.
    async fn post_task_request(&self, conn: &mut SqliteConnection, ctx: &Ctx, msg: SystemMessage) -> Result<(), Error> {
        self.post_system_message(conn, ctx, msg).await?;
        Ok(())
    }

    /// `submitted` -> `queued`: routing finalized and authorized; emits the work-ready notification.
    pub(crate) async fn route_task(&self, conn: &mut SqliteConnection, ctx: &Ctx, row: &mut TaskRow, event_type: &str) -> Result<(), Error> {
        let before = row.state;
        self.commit_transition(
            conn,
            ctx,
            row,
            Event::Route,
            event_type,
            TransitionData { data: json!({"targetAgentId": row.target_agent_id}), post_status_message: Some("Task queued".into()), ..Default::default() },
        )
        .await?;
        let _ = before;
        self.metrics.tasks_queued.inc();
        Ok(())
    }

    /// Verifies that `ctx` is the holder of a live lease with the presented fencing token (TASK-02).
    pub(crate) fn verify_lease(&self, row: &TaskRow, ctx: &Ctx, fencing_token: Option<u64>) -> Result<(), Error> {
        let Some(lease) = row.lease() else {
            return Err(Error::new(ErrorCode::LeaseExpired, "the task is not leased to anyone"));
        };
        if row.assignee_principal_id.as_deref() != Some(&ctx.actor.principal_id) {
            return Err(Error::new(ErrorCode::StaleFencingToken, "the task is leased to another worker"));
        }
        let token = fencing_token.ok_or_else(|| Error::invalid("fencingToken is required"))?;
        if token != row.fencing_counter as u64 {
            return Err(Error::new(ErrorCode::StaleFencingToken, format!("fencing token {token} is stale; the current token is {}", row.fencing_counter))
                .with_details(json!({"currentFencingToken": row.fencing_counter})));
        }
        if let (Some(rt), Some(mine)) = (&row.lease_runtime_instance_id, &ctx.actor.runtime_instance_id)
            && rt != mine
        {
            return Err(Error::new(ErrorCode::StaleFencingToken, "the lease belongs to another runtime instance"));
        }
        if lease.expires_at <= self.now_ts() {
            return Err(Error::new(ErrorCode::LeaseExpired, "the lease has expired").with_details(json!({"expiredAt": lease.expires_at})));
        }
        Ok(())
    }

    pub(crate) async fn compute_authority(
        &self,
        conn: &mut SqliteConnection,
        row: &TaskRow,
        agent: &crate::policy::Permissions,
    ) -> Result<EffectiveAuthority, Error> {
        let policy = self.active_policy(conn).await?;
        let requester = self.principal_by_id(conn, &row.requester_principal_id).await?.map(|p| p.permissions).unwrap_or_default();
        let parent = match &row.parent_task_id {
            Some(pid) => self.load_task(conn, pid).await.ok().and_then(|p| p.effective_authority),
            None => None,
        };
        let constraint: Option<SideEffects> =
            row.constraints.as_ref().and_then(|c| c.get("sideEffectsAtMost")).and_then(Value::as_str).and_then(SideEffects::parse);
        // the requester's delegation budget is what remains on the task row (already decremented for children)
        Ok(EffectiveAuthority::compute(AuthorityInputs {
            agent,
            requester: &requester,
            capability_side_effects: row.side_effects,
            task_constraint: constraint,
            delegation_remaining: row.delegation_depth_remaining.max(0) as u32,
            parent: parent.as_ref(),
            policy: &policy,
        }))
    }
}
