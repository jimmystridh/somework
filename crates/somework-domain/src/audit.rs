//! Immutable, hash-chained audit trail (AUD-01). Bodies and secrets are never copied into audit records.

use serde::Serialize;
use serde_json::{Value, json};
use somework_core::{Error, canonical::sha256_hex, ids};
use sqlx::{Row, SqliteConnection};

use crate::{
    db::{DbResultExt, icol, jcol, scol, scol_opt},
    domain::{Ctx, Domain},
    policy::Decision,
};

#[derive(Debug, Clone)]
pub struct AuditRecord {
    pub action: String,
    pub resource: Option<String>,
    pub task_id: Option<String>,
    pub conversation_id: Option<String>,
    pub policy_decision_id: Option<String>,
    pub policy_version: Option<String>,
    pub request_digest: Option<String>,
    pub before_state_digest: Option<String>,
    pub after_state_digest: Option<String>,
    pub outcome: String,
    pub detail: Value,
}

impl AuditRecord {
    pub fn new(action: &str, resource: Option<String>, outcome: &str) -> Self {
        Self {
            action: action.into(),
            resource,
            task_id: None,
            conversation_id: None,
            policy_decision_id: None,
            policy_version: None,
            request_digest: None,
            before_state_digest: None,
            after_state_digest: None,
            outcome: outcome.into(),
            detail: json!({}),
        }
    }
    pub fn task(mut self, task_id: Option<String>) -> Self {
        self.task_id = task_id;
        self
    }
    pub fn conversation(mut self, id: Option<String>) -> Self {
        self.conversation_id = id;
        self
    }
    pub fn decision(mut self, d: &Decision) -> Self {
        self.policy_decision_id = Some(d.decision_id.clone());
        self.policy_version = Some(d.policy_version.clone());
        self
    }
    pub fn request(mut self, digest: String) -> Self {
        self.request_digest = Some(digest);
        self
    }
    pub fn states(mut self, before: Option<String>, after: Option<String>) -> Self {
        self.before_state_digest = before;
        self.after_state_digest = after;
        self
    }
    pub fn detail(mut self, detail: Value) -> Self {
        self.detail = detail;
        self
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditView {
    pub seq: i64,
    pub audit_event_id: String,
    pub occurred_at: String,
    pub authenticated_actor: String,
    pub runtime_instance_id: Option<String>,
    pub action: String,
    pub resource: Option<String>,
    pub task_id: Option<String>,
    pub conversation_id: Option<String>,
    pub authorization_grant_jti: Option<String>,
    pub policy_decision_id: Option<String>,
    pub policy_version: Option<String>,
    pub request_digest: Option<String>,
    pub before_state_digest: Option<String>,
    pub after_state_digest: Option<String>,
    pub outcome: String,
    pub trace_id: Option<String>,
    pub source_transport: Option<String>,
    pub source_transport_event_id: Option<String>,
    pub detail: Value,
    pub hash: String,
}

impl Domain {
    pub async fn audit(&self, conn: &mut SqliteConnection, ctx: &Ctx, rec: AuditRecord) -> Result<String, Error> {
        let prev: Option<String> = sqlx::query_scalar("SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1").fetch_optional(&mut *conn).await.db()?;
        let prev = prev.unwrap_or_else(|| "0".repeat(64));
        let audit_id = ids::audit_id();
        let occurred_at = self.now_ts();
        let actor = ctx.actor.label();
        let chain_input = json!([
            prev,
            audit_id,
            occurred_at,
            actor,
            rec.action,
            rec.resource,
            rec.task_id,
            rec.policy_decision_id,
            rec.request_digest,
            rec.before_state_digest,
            rec.after_state_digest,
            rec.outcome,
            ctx.trace.trace_id
        ]);
        let hash = sha256_hex(chain_input.to_string().as_bytes());
        sqlx::query(
            "INSERT INTO audit_events(audit_event_id, domain_id, occurred_at, authenticated_actor, runtime_instance_id, action, resource, task_id,
               conversation_id, authorization_grant_jti, policy_decision_id, policy_version, request_digest, before_state_digest, after_state_digest,
               outcome, trace_id, source_transport, source_transport_event_id, detail, prev_hash, hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&audit_id)
        .bind(&self.cfg.domain_id)
        .bind(&occurred_at)
        .bind(&actor)
        .bind(&ctx.actor.runtime_instance_id)
        .bind(&rec.action)
        .bind(&rec.resource)
        .bind(&rec.task_id)
        .bind(&rec.conversation_id)
        .bind(&ctx.actor.grant_jti)
        .bind(&rec.policy_decision_id)
        .bind(&rec.policy_version)
        .bind(&rec.request_digest)
        .bind(&rec.before_state_digest)
        .bind(&rec.after_state_digest)
        .bind(&rec.outcome)
        .bind(&ctx.trace.trace_id)
        .bind(&ctx.transport)
        .bind(&ctx.transport_event_id)
        .bind(rec.detail.to_string())
        .bind(&prev)
        .bind(&hash)
        .execute(conn)
        .await
        .db()?;
        Ok(audit_id)
    }

    pub async fn list_audit(&self, ctx: &Ctx, task_id: Option<&str>, after_seq: i64, limit: i64) -> Result<Vec<AuditView>, Error> {
        self.enforce_read(ctx, crate::policy::AuthzRequest::new("audit.read")).await?;
        let rows = sqlx::query("SELECT * FROM audit_events WHERE seq > ? AND (? IS NULL OR task_id = ?) ORDER BY seq ASC LIMIT ?")
            .bind(after_seq)
            .bind(task_id)
            .bind(task_id)
            .bind(limit.clamp(1, 1000))
            .fetch_all(self.db.pool())
            .await
            .db()?;
        Ok(rows
            .iter()
            .map(|r| AuditView {
                seq: icol(r, "seq"),
                audit_event_id: scol(r, "audit_event_id"),
                occurred_at: scol(r, "occurred_at"),
                authenticated_actor: scol(r, "authenticated_actor"),
                runtime_instance_id: scol_opt(r, "runtime_instance_id"),
                action: scol(r, "action"),
                resource: scol_opt(r, "resource"),
                task_id: scol_opt(r, "task_id"),
                conversation_id: scol_opt(r, "conversation_id"),
                authorization_grant_jti: scol_opt(r, "authorization_grant_jti"),
                policy_decision_id: scol_opt(r, "policy_decision_id"),
                policy_version: scol_opt(r, "policy_version"),
                request_digest: scol_opt(r, "request_digest"),
                before_state_digest: scol_opt(r, "before_state_digest"),
                after_state_digest: scol_opt(r, "after_state_digest"),
                outcome: scol(r, "outcome"),
                trace_id: scol_opt(r, "trace_id"),
                source_transport: scol_opt(r, "source_transport"),
                source_transport_event_id: scol_opt(r, "source_transport_event_id"),
                detail: jcol(r, "detail"),
                hash: scol(r, "hash"),
            })
            .collect())
    }

    /// Recomputes the hash chain; returns the first sequence number whose hash does not verify.
    pub async fn verify_audit_chain(&self) -> Result<Option<i64>, Error> {
        let rows = sqlx::query("SELECT * FROM audit_events ORDER BY seq ASC").fetch_all(self.db.pool()).await.db()?;
        let mut prev = rows.first().map(|r| scol(r, "prev_hash")).unwrap_or_else(|| "0".repeat(64));
        for r in rows {
            let chain_input = json!([
                prev,
                scol(&r, "audit_event_id"),
                scol(&r, "occurred_at"),
                scol(&r, "authenticated_actor"),
                scol(&r, "action"),
                scol_opt(&r, "resource"),
                scol_opt(&r, "task_id"),
                scol_opt(&r, "policy_decision_id"),
                scol_opt(&r, "request_digest"),
                scol_opt(&r, "before_state_digest"),
                scol_opt(&r, "after_state_digest"),
                scol(&r, "outcome"),
                scol_opt(&r, "trace_id")
            ]);
            let expected = sha256_hex(chain_input.to_string().as_bytes());
            if scol(&r, "prev_hash") != prev || scol(&r, "hash") != expected {
                return Ok(Some(r.get::<i64, _>("seq")));
            }
            prev = expected;
        }
        Ok(None)
    }
}
