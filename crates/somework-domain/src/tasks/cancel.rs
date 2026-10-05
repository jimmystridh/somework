use chrono::Duration;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use somework_core::{
    Error, ErrorCode,
    canonical::digest_json,
    clock::ts,
    contracts::*,
    fsm::{Event, TaskState},
    ids,
};
use sqlx::SqliteConnection;

use super::{TaskRow, TaskView, TransitionData};
use crate::{
    db::{DbResultExt, icol, scol},
    domain::{Ctx, Domain},
    messages::SystemMessage,
    policy::{AuthzRequest, Decision},
};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CancelRequest {
    pub expected_revision: Option<u64>,
    pub reason: Option<String>,
    /// Assignee acknowledgement of a cooperative cancellation (requires the fencing token).
    pub acknowledge: bool,
    pub fencing_token: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DecideApproval {
    /// `approved` or `denied`.
    pub decision: String,
    pub action_digest: String,
    pub task_revision: u64,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalView {
    pub approval_id: String,
    pub task_id: String,
    pub task_revision: i64,
    pub action_digest: String,
    pub action: String,
    pub requested_by: String,
    pub approved_by: Option<String>,
    pub decision: Option<String>,
    pub status: String,
    pub expires_at: String,
    pub policy_decision_id: Option<String>,
    pub created_at: String,
    pub decided_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ReconcileRequest {
    /// `retry`, `succeeded`, `failed` or `canceled`.
    pub resolution: String,
    pub result: Option<Value>,
    pub failure: Option<Failure>,
    pub note: Option<String>,
}

fn approval_from_row(r: &sqlx::sqlite::SqliteRow) -> ApprovalView {
    ApprovalView {
        approval_id: scol(r, "approval_id"),
        task_id: scol(r, "task_id"),
        task_revision: icol(r, "task_revision"),
        action_digest: scol(r, "action_digest"),
        action: scol(r, "action"),
        requested_by: scol(r, "requested_by"),
        approved_by: crate::db::scol_opt(r, "approved_by"),
        decision: crate::db::scol_opt(r, "decision"),
        status: scol(r, "status"),
        expires_at: scol(r, "expires_at"),
        policy_decision_id: crate::db::scol_opt(r, "policy_decision_id"),
        created_at: scol(r, "created_at"),
        decided_at: crate::db::scol_opt(r, "decided_at"),
    }
}

/// The digest an approval is bound to: what will be executed, by whom, and at which task revision (POL-03).
pub fn action_digest(row: &TaskRow, revision: i64) -> String {
    digest_json(&json!({
        "taskId": row.task_id,
        "revision": revision,
        "capability": {"id": row.capability_id, "version": row.capability_version},
        "input": row.input,
        "requester": row.requester.id,
        "targetAgentId": row.target_agent_id,
        "deadlineAt": row.deadline_at,
    }))
}

impl Domain {
    pub async fn cancel_task(&self, ctx: &Ctx, task_id: &str, req: CancelRequest) -> Result<TaskView, Error> {
        self.run(ctx, "task.cancel", async {
            let this = self.clone();
            let ctx = ctx.clone();
            let task_id = task_id.to_string();
            self.write(move |tx| {
                Box::pin(async move {
                    let conn: &mut SqliteConnection = tx;
                    let mut row = this.require_task_participant(conn, &ctx, &task_id).await?;
                    if req.acknowledge {
                        this.require_runtime(conn, &ctx).await?;
                        this.verify_lease(&row, &ctx, req.fencing_token)?;
                        let decision = this
                            .enforce(conn, &ctx, AuthzRequest::action(Action::TaskUpdate).resource(format!("task://{}", row.task_id)).task(&row.task_id))
                            .await?;
                        let before = row.state;
                        this.commit_transition(
                            conn,
                            &ctx,
                            &mut row,
                            Event::AckCancel,
                            "canceled",
                            TransitionData {
                                data: json!({"acknowledgedBy": ctx.actor.id}),
                                post_status_message: Some("Cancellation acknowledged".into()),
                                ..Default::default()
                            },
                        )
                        .await?;
                        this.audit_task(conn, &ctx, "task.cancel_ack", &row, Some(&before), Some(&decision), json!({})).await?;
                        return this.task_view(conn, &row).await;
                    }
                    let decision = this
                        .enforce(conn, &ctx, AuthzRequest::action(Action::TaskCancel).resource(format!("task://{}", row.task_id)).task(&row.task_id))
                        .await?;
                    let is_requester = row.requester_principal_id == ctx.actor.principal_id;
                    if !is_requester && !ctx.actor.is_admin() && !ctx.actor.permissions.allows_action("task.reconcile") {
                        return Err(Error::denied("only the requester may cancel a task"));
                    }
                    this.check_expected_revision(&ctx, req.expected_revision, &row)?;
                    let before = row.state;
                    if row.state == TaskState::CancelRequested {
                        return this.task_view(conn, &row).await; // idempotent
                    }
                    let reason = req.reason.clone().unwrap_or_else(|| "requested".into());
                    // a task parked for reconciliation has no live worker to acknowledge: only an operator may cancel it,
                    // and the cancellation completes immediately (the interrupted action's effects are theirs to judge)
                    let parked =
                        row.state == TaskState::Blocked && row.blocker.as_ref().and_then(|b| b.get("kind")).and_then(Value::as_str) == Some("reconciliation");
                    if parked {
                        if !ctx.actor.permissions.allows_action("task.reconcile") {
                            return Err(Error::new(
                                ErrorCode::InvalidTransition,
                                "the task awaits operator reconciliation and can only be canceled by an operator",
                            ));
                        }
                        row.blocker = None;
                        this.commit_transition(
                            conn,
                            &ctx,
                            &mut row,
                            Event::Cancel,
                            "cancel_requested",
                            TransitionData { data: json!({"reason": reason, "while": "reconciliation"}), ..Default::default() },
                        )
                        .await?;
                        this.commit_transition(
                            conn,
                            &ctx,
                            &mut row,
                            Event::AckCancel,
                            "canceled",
                            TransitionData {
                                data: json!({"reason": reason, "while": "reconciliation"}),
                                post_status_message: Some("Canceled by an operator during reconciliation".into()),
                                ..Default::default()
                            },
                        )
                        .await?;
                        this.audit_task(conn, &ctx, "task.cancel", &row, Some(&before), Some(&decision), json!({"reason": reason, "while": "reconciliation"}))
                            .await?;
                        return this.task_view(conn, &row).await;
                    }
                    // cooperative when a runtime owns the task, immediate otherwise
                    let outcome = somework_core::fsm::next_state(row.state, Event::Cancel)?;
                    let td = if outcome == TaskState::CancelRequested {
                        TransitionData {
                            data: json!({"reason": reason}),
                            wake_assignee: true,
                            post_status_message: Some("Cancellation requested".into()),
                            ..Default::default()
                        }
                    } else {
                        TransitionData { data: json!({"reason": reason}), post_status_message: Some("Task canceled".into()), ..Default::default() }
                    };
                    let event_type = if outcome == TaskState::CancelRequested { "cancel_requested" } else { "canceled" };
                    this.commit_transition(conn, &ctx, &mut row, Event::Cancel, event_type, td).await?;
                    this.audit_task(conn, &ctx, "task.cancel", &row, Some(&before), Some(&decision), json!({"reason": reason})).await?;
                    this.task_view(conn, &row).await
                })
            })
            .await
        })
        .await
    }

    /// `submitted` -> `rejected` (routing refused, approval denied, federation refusal). Operators and the system only.
    pub async fn reject_task(&self, ctx: &Ctx, task_id: &str, code: &str, message: &str) -> Result<TaskView, Error> {
        self.run(ctx, "task.reject", async {
            let this = self.clone();
            let ctx = ctx.clone();
            let (task_id, code, message) = (task_id.to_string(), code.to_string(), message.to_string());
            self.write(move |tx| {
                Box::pin(async move {
                    let conn: &mut SqliteConnection = tx;
                    let decision = this.enforce(conn, &ctx, AuthzRequest::new("task.reconcile").resource(format!("task://{task_id}")).task(&task_id)).await?;
                    let mut row = this.load_task(conn, &task_id).await?;
                    let before = row.state;
                    row.failure = Some(Failure { code: code.clone(), message: message.clone(), retryable: false, details: None });
                    this.commit_transition(
                        conn,
                        &ctx,
                        &mut row,
                        Event::Reject,
                        "rejected",
                        TransitionData {
                            data: json!({"code": code, "message": message}),
                            post_status_message: Some(format!("Task rejected: {message}")),
                            ..Default::default()
                        },
                    )
                    .await?;
                    this.audit_task(conn, &ctx, "task.reject", &row, Some(&before), Some(&decision), json!({"code": code})).await?;
                    this.task_view(conn, &row).await
                })
            })
            .await
        })
        .await
    }

    pub(crate) async fn request_approval(&self, conn: &mut SqliteConnection, ctx: &Ctx, row: &TaskRow, decision: &Decision) -> Result<String, Error> {
        let policy = self.active_policy(conn).await?;
        let approval_id = ids::approval_id();
        let digest = action_digest(row, row.revision);
        let expires = ts(self.now() + Duration::seconds(policy.approvals.ttl_seconds.max(60)));
        sqlx::query("INSERT INTO approvals(approval_id, domain_id, task_id, task_revision, action_digest, action, requested_by, required_approver_policy, status, expires_at, policy_decision_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)")
            .bind(&approval_id)
            .bind(&self.cfg.domain_id)
            .bind(&row.task_id)
            .bind(row.revision)
            .bind(&digest)
            .bind(format!("{}@{}", row.capability_id, row.capability_version))
            .bind(&ctx.actor.principal_id)
            .bind(json!({"requiresRole": "approver", "capability": row.capability_id, "sideEffects": row.side_effects.as_str()}).to_string())
            .bind(&expires)
            .bind(&decision.decision_id)
            .bind(self.now_ts())
            .execute(&mut *conn)
            .await
            .db()?;
        // approvers: humans permitted to grant approvals for this capability
        let approvers =
            sqlx::query("SELECT principal_id, kind, external_id, permissions FROM principals WHERE domain_id = ? AND kind = 'human' AND status = 'active'")
                .bind(&self.cfg.domain_id)
                .fetch_all(&mut *conn)
                .await
                .db()?;
        let mut recipients = Vec::new();
        for r in approvers {
            let perms: crate::policy::Permissions = serde_json::from_str(&scol(&r, "permissions")).unwrap_or_default();
            if perms.allows_action("approval.grant") && perms.may_approve(&row.capability_id) && scol(&r, "principal_id") != ctx.actor.principal_id {
                recipients.push(ActorRef::new(ActorKind::Human, scol(&r, "external_id"), self.cfg.domain_id.clone()));
                if let Some(conversation) = &row.conversation_id {
                    self.add_member(conn, conversation, &scol(&r, "principal_id"), "approver").await?;
                }
            }
        }
        let mut msg = SystemMessage::new(
            MessageType::ApprovalRequest,
            json!({"approvalId": approval_id, "taskId": row.task_id, "taskRevision": row.revision, "actionDigest": digest, "action": format!("{}@{}", row.capability_id, row.capability_version), "sideEffects": row.side_effects.as_str(), "expiresAt": expires, "requestedBy": ctx.actor.id}),
        );
        msg.conversation_id = row.conversation_id.clone();
        msg.task_id = Some(row.task_id.clone());
        msg.trigger = Some(TriggerMode::Directed);
        msg.recipients = recipients.into_iter().map(|a| (a, "approver".to_string())).collect();
        self.post_system_message(conn, ctx, msg).await?;
        sqlx::query("INSERT INTO task_events(task_id, event_sequence, event_id, type, from_state, to_state, revision, actor, data, trace_id, created_at) VALUES (?, (SELECT COALESCE(MAX(event_sequence),0)+1 FROM task_events WHERE task_id = ?), ?, 'task.approval_requested', 'submitted', 'submitted', ?, ?, ?, ?, ?)")
            .bind(&row.task_id)
            .bind(&row.task_id)
            .bind(ids::event_id())
            .bind(row.revision)
            .bind(serde_json::to_string(&ctx.actor.actor_ref())?)
            .bind(json!({"approvalId": approval_id, "actionDigest": digest, "expiresAt": expires}).to_string())
            .bind(&ctx.trace.trace_id)
            .bind(self.now_ts())
            .execute(&mut *conn)
            .await
            .db()?;
        Ok(approval_id)
    }

    /// Structured human approval: valid only for the exact action digest and task revision it was requested for,
    /// before it expires, and never by the requester themself.
    pub async fn decide_approval(&self, ctx: &Ctx, approval_id: &str, req: DecideApproval) -> Result<TaskView, Error> {
        self.run(ctx, "approval.decide", async {
            if !matches!(req.decision.as_str(), "approved" | "denied") {
                return Err(Error::invalid("decision must be approved or denied"));
            }
            let this = self.clone();
            let ctx = ctx.clone();
            let approval_id = approval_id.to_string();
            self.write(move |tx| {
                Box::pin(async move {
                    let conn: &mut SqliteConnection = tx;
                    let a = sqlx::query("SELECT * FROM approvals WHERE approval_id = ?")
                        .bind(&approval_id)
                        .fetch_optional(&mut *conn)
                        .await
                        .db()?
                        .ok_or_else(|| Error::not_found("approval"))?;
                    let approval = approval_from_row(&a);
                    let mut row = this.load_task(conn, &approval.task_id).await?;
                    let decision = this
                        .enforce(conn, &ctx, AuthzRequest::action(Action::ApprovalGrant).resource(format!("task://{}", row.task_id)).task(&row.task_id))
                        .await?;
                    if !ctx.actor.permissions.may_approve(&row.capability_id) {
                        let policy = this.active_policy(conn).await?;
                        let denied = Decision {
                            decision_id: ids::decision_id(),
                            allow: false,
                            reasons: vec![format!("caller may not approve {}", row.capability_id)],
                            obligations: vec![],
                            policy_version: policy.version,
                        };
                        let mut err = Error::denied(format!("caller may not approve {}", row.capability_id));
                        err.details =
                            Some(json!({"decision": denied, "action": "approval.grant", "resource": format!("task://{}", row.task_id), "taskId": row.task_id}));
                        return Err(err);
                    }
                    if row.requester_principal_id == ctx.actor.principal_id {
                        return Err(Error::denied("the requester may not approve their own request"));
                    }
                    if approval.status != "pending" {
                        return Err(Error::new(ErrorCode::InvalidTransition, format!("approval is already {}", approval.status)));
                    }
                    if approval.expires_at <= this.now_ts() {
                        return Err(Error::new(ErrorCode::Expired, "the approval request has expired"));
                    }
                    if row.state != TaskState::Submitted {
                        return Err(Error::new(ErrorCode::StaleRevision, format!("task is {}; the approval no longer applies", row.state)));
                    }
                    let current_digest = action_digest(&row, approval.task_revision);
                    if req.task_revision as i64 != row.revision || approval.task_revision != row.revision {
                        return Err(Error::new(ErrorCode::StaleRevision, "the task changed after this approval was requested")
                            .with_details(json!({"currentRevision": row.revision})));
                    }
                    if req.action_digest != approval.action_digest || approval.action_digest != current_digest {
                        return Err(Error::new(ErrorCode::StaleRevision, "the approval does not match the action that would be executed"));
                    }
                    let approved = req.decision == "approved";
                    sqlx::query("UPDATE approvals SET status = ?, decision = ?, approved_by = ?, decided_at = ? WHERE approval_id = ?")
                        .bind(&req.decision)
                        .bind(&req.decision)
                        .bind(ctx.actor.label())
                        .bind(this.now_ts())
                        .bind(&approval_id)
                        .execute(&mut *conn)
                        .await
                        .db()?;
                    let mut msg = SystemMessage::new(
                        MessageType::ApprovalDecision,
                        json!({"approvalId": approval_id, "taskId": row.task_id, "decision": req.decision, "decidedBy": ctx.actor.id, "comment": req.comment}),
                    );
                    msg.conversation_id = row.conversation_id.clone();
                    msg.task_id = Some(row.task_id.clone());
                    msg.trigger = Some(TriggerMode::TaskState);
                    msg.recipients = vec![(row.requester.clone(), "requester".into())];
                    this.post_system_message(conn, &ctx, msg).await?;
                    let before = row.state;
                    if approved {
                        row.policy_decision_id = Some(decision.decision_id.clone());
                        this.route_task(conn, &ctx, &mut row, "queued").await?;
                    } else {
                        row.failure = Some(Failure {
                            code: "approval_denied".into(),
                            message: req.comment.clone().unwrap_or_else(|| "approval was denied".into()),
                            retryable: false,
                            details: None,
                        });
                        this.commit_transition(
                            conn,
                            &ctx,
                            &mut row,
                            Event::Reject,
                            "rejected",
                            TransitionData {
                                data: json!({"code": "approval_denied"}),
                                post_status_message: Some("Approval denied".into()),
                                ..Default::default()
                            },
                        )
                        .await?;
                    }
                    this.audit_task(
                        conn,
                        &ctx,
                        "approval.decide",
                        &row,
                        Some(&before),
                        Some(&decision),
                        json!({"approvalId": approval_id, "decision": req.decision, "actionDigest": req.action_digest}),
                    )
                    .await?;
                    this.task_view(conn, &row).await
                })
            })
            .await
        })
        .await
    }

    pub async fn list_approvals(&self, ctx: &Ctx, status: Option<&str>) -> Result<Vec<ApprovalView>, Error> {
        self.enforce_read(ctx, AuthzRequest::action(Action::ApprovalGrant)).await?;
        let rows = sqlx::query("SELECT * FROM approvals WHERE (? IS NULL OR status = ?) ORDER BY created_at DESC LIMIT 200")
            .bind(status)
            .bind(status)
            .fetch_all(self.db.pool())
            .await
            .db()?;
        Ok(rows.iter().map(approval_from_row).collect())
    }

    pub async fn get_approval(&self, ctx: &Ctx, approval_id: &str) -> Result<ApprovalView, Error> {
        self.enforce_read(ctx, AuthzRequest::action(Action::ApprovalGrant)).await?;
        let r = sqlx::query("SELECT * FROM approvals WHERE approval_id = ?")
            .bind(approval_id)
            .fetch_optional(self.db.pool())
            .await
            .db()?
            .ok_or_else(|| Error::not_found("approval"))?;
        Ok(approval_from_row(&r))
    }

    /// Operator resolution of a task parked for reconciliation (TASK-06).
    pub async fn reconcile_task(&self, ctx: &Ctx, task_id: &str, req: ReconcileRequest) -> Result<TaskView, Error> {
        self.run(ctx, "task.reconcile", async {
            let this = self.clone();
            let ctx = ctx.clone();
            let task_id = task_id.to_string();
            self.write(move |tx| {
                Box::pin(async move {
                    let conn: &mut SqliteConnection = tx;
                    let decision = this.enforce(conn, &ctx, AuthzRequest::new("task.reconcile").resource(format!("task://{task_id}")).task(&task_id)).await?;
                    let mut row = this.load_task(conn, &task_id).await?;
                    let parked =
                        row.state == TaskState::Blocked && row.blocker.as_ref().and_then(|b| b.get("kind")).and_then(Value::as_str) == Some("reconciliation");
                    if !parked {
                        return Err(Error::new(ErrorCode::InvalidTransition, "the task is not awaiting reconciliation"));
                    }
                    let before = row.state;
                    let note = json!({"resolution": req.resolution, "note": req.note, "by": ctx.actor.id});
                    row.blocker = None;
                    match req.resolution.as_str() {
                        "retry" => {
                            row.attempt += 1;
                            row.assignee_agent_id = None;
                            row.assignee_principal_id = None;
                            this.commit_transition(
                                conn,
                                &ctx,
                                &mut row,
                                Event::LeaseExpired { retry_safe: true },
                                "reconciled_retry",
                                TransitionData {
                                    data: note.clone(),
                                    post_status_message: Some("Operator re-queued the task after reconciliation".into()),
                                    ..Default::default()
                                },
                            )
                            .await?;
                        }
                        "succeeded" | "failed" | "canceled" => {
                            this.commit_transition(
                                conn,
                                &ctx,
                                &mut row,
                                Event::Resume,
                                "reconciling",
                                TransitionData { data: note.clone(), ..Default::default() },
                            )
                            .await?;
                            match req.resolution.as_str() {
                                "succeeded" => {
                                    let result = req.result.clone().ok_or_else(|| Error::invalid("result is required to resolve as succeeded"))?;
                                    somework_core::schema::validate_against(&row.snapshot.output_schema, &result, "task result")?;
                                    row.result = Some(result);
                                    this.commit_transition(
                                        conn,
                                        &ctx,
                                        &mut row,
                                        Event::Complete,
                                        "succeeded",
                                        TransitionData {
                                            data: note.clone(),
                                            post_status_message: Some("Resolved as succeeded by an operator".into()),
                                            ..Default::default()
                                        },
                                    )
                                    .await?;
                                }
                                "failed" => {
                                    row.failure = Some(req.failure.clone().unwrap_or(Failure {
                                        code: "reconciled_failed".into(),
                                        message: "resolved as failed by an operator".into(),
                                        retryable: false,
                                        details: None,
                                    }));
                                    this.commit_transition(
                                        conn,
                                        &ctx,
                                        &mut row,
                                        Event::Fail,
                                        "failed",
                                        TransitionData {
                                            data: note.clone(),
                                            post_status_message: Some("Resolved as failed by an operator".into()),
                                            ..Default::default()
                                        },
                                    )
                                    .await?;
                                }
                                _ => {
                                    this.commit_transition(
                                        conn,
                                        &ctx,
                                        &mut row,
                                        Event::Cancel,
                                        "cancel_requested",
                                        TransitionData { data: note.clone(), ..Default::default() },
                                    )
                                    .await?;
                                    this.commit_transition(
                                        conn,
                                        &ctx,
                                        &mut row,
                                        Event::AckCancel,
                                        "canceled",
                                        TransitionData {
                                            data: note.clone(),
                                            post_status_message: Some("Canceled by an operator".into()),
                                            ..Default::default()
                                        },
                                    )
                                    .await?;
                                }
                            }
                        }
                        other => return Err(Error::invalid(format!("unknown resolution {other}"))),
                    }
                    this.audit_task(conn, &ctx, "task.reconcile", &row, Some(&before), Some(&decision), note).await?;
                    this.task_view(conn, &row).await
                })
            })
            .await
        })
        .await
    }
}
