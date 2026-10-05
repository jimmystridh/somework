//! Maintenance: lease expiry (TASK-05/06), deadline expiry, approval expiry and retention.

use serde::Serialize;
use serde_json::json;
use somework_core::{
    Error,
    contracts::SideEffects,
    fsm::{Event, TaskState},
};
use sqlx::SqliteConnection;

use super::{TaskRow, TransitionData};
use crate::{
    db::{DbResultExt, scol},
    domain::{Ctx, Domain},
};

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MaintenanceReport {
    pub leases_requeued: u64,
    pub leases_reconciliation: u64,
    pub leases_canceled: u64,
    pub deadlines_expired: u64,
    pub deadlines_cancel_requested: u64,
    pub approvals_expired: u64,
    pub idempotency_purged: u64,
}

impl Domain {
    /// Moves a task whose lease lapsed out of the leased states. Runs inside the caller's transaction so that a
    /// racing `claim` resolves the stale owner atomically before taking the task.
    pub(crate) async fn expire_lease_tx(&self, conn: &mut SqliteConnection, ctx: &Ctx, row: &mut TaskRow) -> Result<ExpiryOutcome, Error> {
        self.metrics.task_lease_expiry_count.inc();
        let previous = json!({"runtimeInstanceId": row.lease_runtime_instance_id, "fencingToken": row.fencing_counter, "assignee": row.assignee_agent_id, "expiredAt": row.lease_expires_at});
        if let Some(jti) = row.authorization_token_id.clone() {
            self.revoke_grant(conn, &jti).await?;
        }
        if row.state == TaskState::CancelRequested {
            self.commit_transition(
                conn,
                ctx,
                row,
                Event::LeaseExpired { retry_safe: true },
                "canceled",
                TransitionData {
                    data: json!({"reason": "lease_expired_while_cancel_requested", "previous": previous}),
                    post_status_message: Some("Task canceled (worker lost)".into()),
                    ..Default::default()
                },
            )
            .await?;
            return Ok(ExpiryOutcome::Canceled);
        }
        let retry_safe = row.side_effects != SideEffects::Irreversible || row.is_idempotent_action();
        let exhausted = retry_safe && row.attempt as u64 >= self.cfg.max_task_attempts;
        if retry_safe && !exhausted {
            row.attempt += 1;
            row.lease_id = None;
            row.lease_runtime_instance_id = None;
            row.lease_expires_at = None;
            row.assignee_agent_id = None;
            row.assignee_principal_id = None;
            row.effective_authority = None;
            row.authorization_token_id = None;
            self.commit_transition(
                conn,
                ctx,
                row,
                Event::LeaseExpired { retry_safe: true },
                "requeued",
                TransitionData {
                    data: json!({"reason": "lease_expired", "previous": previous, "attempt": row.attempt}),
                    post_status_message: Some("Worker lost; task re-queued".into()),
                    ..Default::default()
                },
            )
            .await?;
            self.metrics.task_retry_count.inc();
            return Ok(ExpiryOutcome::Requeued);
        }
        let reason = if exhausted { "max_attempts_exhausted" } else { "irreversible_action_interrupted" };
        row.blocker = Some(json!({"kind": "reconciliation", "reason": reason, "since": self.now_ts(), "previous": previous}));
        row.lease_id = None;
        row.lease_runtime_instance_id = None;
        row.lease_expires_at = None;
        row.authorization_token_id = None;
        self.commit_transition(
            conn,
            ctx,
            row,
            Event::LeaseExpired { retry_safe: false },
            "reconciliation_required",
            TransitionData {
                data: json!({"reason": reason, "previous": previous}),
                post_status_message: Some("Worker lost during a non-repeatable action; reconciliation required".into()),
                ..Default::default()
            },
        )
        .await?;
        self.metrics.task_reconciliation_count.inc();
        Ok(ExpiryOutcome::Reconciliation)
    }

    pub async fn run_maintenance(&self) -> Result<MaintenanceReport, Error> {
        let mut report = MaintenanceReport::default();
        let ctx = self.system_ctx();
        let now = self.now_ts();

        let ids: Vec<String> = sqlx::query_scalar("SELECT task_id FROM tasks WHERE state IN ('claimed','running','input_required','blocked','cancel_requested') AND lease_id IS NOT NULL AND lease_expires_at <= ?").bind(&now).fetch_all(self.db.pool()).await.db()?;
        for id in ids {
            let this = self.clone();
            let ctx = ctx.clone();
            let outcome = self
                .write(move |tx| {
                    Box::pin(async move {
                        let conn: &mut SqliteConnection = tx;
                        let mut row = this.load_task(conn, &id).await?;
                        // re-check under the write lock: the worker may have heartbeated or finished meanwhile
                        if !row.state.is_leased() || row.lease_id.is_none() || !row.lease_expired(&this.now_ts()) {
                            return Ok(None);
                        }
                        let outcome = this.expire_lease_tx(conn, &ctx, &mut row).await?;
                        this.audit_task(conn, &ctx, "task.lease_expired", &row, None, None, json!({"outcome": format!("{outcome:?}")})).await?;
                        Ok(Some(outcome))
                    })
                })
                .await?;
            match outcome {
                Some(ExpiryOutcome::Requeued) => report.leases_requeued += 1,
                Some(ExpiryOutcome::Reconciliation) => report.leases_reconciliation += 1,
                Some(ExpiryOutcome::Canceled) => report.leases_canceled += 1,
                None => {}
            }
        }

        let due: Vec<(String, String)> = sqlx::query("SELECT task_id, state FROM tasks WHERE deadline_at IS NOT NULL AND deadline_at <= ? AND state IN ('submitted','queued','claimed','running','input_required','blocked')")
            .bind(&now)
            .fetch_all(self.db.pool())
            .await
            .db()?
            .iter()
            .map(|r| (scol(r, "task_id"), scol(r, "state")))
            .collect();
        for (id, _) in due {
            let this = self.clone();
            let ctx = ctx.clone();
            let kind = self
                .write(move |tx| {
                    Box::pin(async move {
                        let conn: &mut SqliteConnection = tx;
                        let mut row = this.load_task(conn, &id).await?;
                        if row.deadline_at.as_deref().is_none_or(|d| d > this.now_ts().as_str()) {
                            return Ok(0u8);
                        }
                        match row.state {
                            TaskState::Submitted | TaskState::Queued => {
                                this.commit_transition(
                                    conn,
                                    &ctx,
                                    &mut row,
                                    Event::Expire,
                                    "expired",
                                    TransitionData {
                                        data: json!({"reason": "deadline_exceeded"}),
                                        post_status_message: Some("Task expired before it was started".into()),
                                        ..Default::default()
                                    },
                                )
                                .await?;
                                Ok(1)
                            }
                            s if s.is_leased() && s != TaskState::CancelRequested => {
                                this.commit_transition(
                                    conn,
                                    &ctx,
                                    &mut row,
                                    Event::Cancel,
                                    "cancel_requested",
                                    TransitionData {
                                        data: json!({"reason": "deadline_exceeded"}),
                                        wake_assignee: true,
                                        post_status_message: Some("Deadline exceeded; cancellation requested".into()),
                                        ..Default::default()
                                    },
                                )
                                .await?;
                                Ok(2)
                            }
                            _ => Ok(0),
                        }
                    })
                })
                .await?;
            match kind {
                1 => report.deadlines_expired += 1,
                2 => report.deadlines_cancel_requested += 1,
                _ => {}
            }
        }

        let approvals: Vec<(String, String)> = sqlx::query("SELECT approval_id, task_id FROM approvals WHERE status = 'pending' AND expires_at <= ?")
            .bind(&now)
            .fetch_all(self.db.pool())
            .await
            .db()?
            .iter()
            .map(|r| (scol(r, "approval_id"), scol(r, "task_id")))
            .collect();
        for (approval_id, task_id) in approvals {
            let this = self.clone();
            let ctx = ctx.clone();
            self.write(move |tx| {
                Box::pin(async move {
                    let conn: &mut SqliteConnection = tx;
                    sqlx::query("UPDATE approvals SET status = 'expired' WHERE approval_id = ? AND status = 'pending'")
                        .bind(&approval_id)
                        .execute(&mut *conn)
                        .await
                        .db()?;
                    let mut row = this.load_task(conn, &task_id).await?;
                    if row.state == TaskState::Submitted {
                        row.failure = Some(somework_core::contracts::Failure {
                            code: "approval_expired".into(),
                            message: "no approval was granted before it expired".into(),
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
                                data: json!({"code": "approval_expired"}),
                                post_status_message: Some("Approval expired".into()),
                                ..Default::default()
                            },
                        )
                        .await?;
                    }
                    Ok(())
                })
            })
            .await?;
            report.approvals_expired += 1;
        }
        report.idempotency_purged = self.purge_expired_idempotency().await?;
        Ok(report)
    }

    /// Applies message/audit retention windows. Audit and task history deletions go through the guarded purge flag.
    pub async fn purge_retention(&self) -> Result<u64, Error> {
        let msg_cutoff = somework_core::clock::ts(self.now() - chrono::Duration::days(self.cfg.message_retention_days));
        let audit_cutoff = somework_core::clock::ts(self.now() - chrono::Duration::days(self.cfg.audit_retention_days));
        self.write(move |tx| {
            Box::pin(async move {
                sqlx::query("UPDATE maintenance_flags SET enabled = 1 WHERE name = 'retention_purge'").execute(&mut **tx).await.db()?;
                let d1 = sqlx::query("DELETE FROM message_deliveries WHERE message_id IN (SELECT message_id FROM messages WHERE created_at < ?)")
                    .bind(&msg_cutoff)
                    .execute(&mut **tx)
                    .await
                    .db()?
                    .rows_affected();
                let d2 = sqlx::query("DELETE FROM messages WHERE created_at < ?").bind(&msg_cutoff).execute(&mut **tx).await.db()?.rows_affected();
                let d3 = sqlx::query("DELETE FROM audit_events WHERE occurred_at < ?").bind(&audit_cutoff).execute(&mut **tx).await.db()?.rows_affected();
                sqlx::query("UPDATE maintenance_flags SET enabled = 0 WHERE name = 'retention_purge'").execute(&mut **tx).await.db()?;
                Ok(d1 + d2 + d3)
            })
        })
        .await
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExpiryOutcome {
    Requeued,
    Reconciliation,
    Canceled,
}
