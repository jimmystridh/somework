//! Operator read models for the introspection UI. Every query is gated by an operator action (`ops.read`,
//! `audit.read`), so ordinary agents and humans never see platform-wide evidence.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use somework_core::Error;

use crate::{
    db::{DbResultExt, icol, jcol, scol, scol_opt},
    domain::{Ctx, Domain},
    policy::AuthzRequest,
};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PolicyDecisionFilter {
    pub actor: Option<String>,
    /// `allow` or `deny`.
    pub decision: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyDecisionView {
    pub decision_id: String,
    pub occurred_at: String,
    pub actor: String,
    pub action: String,
    pub resource: Option<String>,
    pub decision: String,
    pub reasons: Value,
    pub policy_version: String,
    pub trace_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub conversation_id: String,
    pub kind: String,
    pub title: Option<String>,
    pub classification: String,
    pub members: i64,
    pub messages: i64,
    pub created_at: String,
    pub matrix_room_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactSummary {
    pub artifact_id: String,
    pub version: i64,
    pub status: String,
    pub filename: Option<String>,
    pub media_type: String,
    pub size_bytes: Option<i64>,
    pub digest: Option<String>,
    pub classification: String,
    pub created_at: String,
}

impl Domain {
    pub async fn list_policy_decisions(&self, ctx: &Ctx, f: PolicyDecisionFilter) -> Result<Vec<PolicyDecisionView>, Error> {
        self.enforce_read(ctx, AuthzRequest::new("audit.read")).await?;
        let rows = sqlx::query(
            "SELECT * FROM policy_decisions WHERE (? IS NULL OR actor LIKE ?) AND (? IS NULL OR decision = ?)
             ORDER BY occurred_at DESC, rowid DESC LIMIT ?",
        )
        .bind(&f.actor)
        .bind(f.actor.as_ref().map(|a| format!("%{a}%")))
        .bind(&f.decision)
        .bind(&f.decision)
        .bind(f.limit.unwrap_or(200).clamp(1, 1000))
        .fetch_all(self.db.pool())
        .await
        .db()?;
        Ok(rows
            .iter()
            .map(|r| PolicyDecisionView {
                decision_id: scol(r, "decision_id"),
                occurred_at: scol(r, "occurred_at"),
                actor: scol(r, "actor"),
                action: scol(r, "action"),
                resource: scol_opt(r, "resource"),
                decision: scol(r, "decision"),
                reasons: jcol(r, "reasons"),
                policy_version: scol(r, "policy_version"),
                trace_id: scol_opt(r, "trace_id"),
            })
            .collect())
    }

    pub async fn list_conversations_admin(&self, ctx: &Ctx, limit: i64) -> Result<Vec<ConversationSummary>, Error> {
        self.enforce_read(ctx, AuthzRequest::new("ops.read")).await?;
        let rows = sqlx::query(
            "SELECT c.*, (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id = c.conversation_id) AS members,
                    (SELECT COUNT(*) FROM messages x WHERE x.conversation_id = c.conversation_id) AS messages,
                    (SELECT t.external_id FROM transport_mappings t WHERE t.transport = 'matrix' AND t.object_kind = 'conversation' AND t.object_id = c.conversation_id LIMIT 1) AS matrix_room_id
             FROM conversations c ORDER BY c.created_at DESC LIMIT ?",
        )
        .bind(limit.clamp(1, 500))
        .fetch_all(self.db.pool())
        .await
        .db()?;
        Ok(rows
            .iter()
            .map(|r| ConversationSummary {
                conversation_id: scol(r, "conversation_id"),
                kind: scol(r, "kind"),
                title: scol_opt(r, "title"),
                classification: scol(r, "classification"),
                members: icol(r, "members"),
                messages: icol(r, "messages"),
                created_at: scol(r, "created_at"),
                matrix_room_id: scol_opt(r, "matrix_room_id"),
            })
            .collect())
    }

    pub async fn list_artifacts_admin(&self, ctx: &Ctx, limit: i64) -> Result<Vec<ArtifactSummary>, Error> {
        self.enforce_read(ctx, AuthzRequest::new("ops.read")).await?;
        let rows = sqlx::query("SELECT * FROM artifacts ORDER BY created_at DESC LIMIT ?").bind(limit.clamp(1, 500)).fetch_all(self.db.pool()).await.db()?;
        Ok(rows
            .iter()
            .map(|r| ArtifactSummary {
                artifact_id: scol(r, "artifact_id"),
                version: icol(r, "version"),
                status: scol(r, "status"),
                filename: scol_opt(r, "filename"),
                media_type: scol(r, "media_type"),
                size_bytes: crate::db::icol_opt(r, "size_bytes"),
                digest: scol_opt(r, "actual_digest"),
                classification: scol(r, "classification"),
                created_at: scol(r, "created_at"),
            })
            .collect())
    }
}
