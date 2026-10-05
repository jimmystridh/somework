//! Transport mappings (`transport_mappings`): the link between canonical objects and their projections in
//! Matrix/NATS (MSG-03: canonical ids are independent of transport ids), plus a few lookups bridges need.

use serde_json::{Value, json};
use somework_core::{Error, contracts::ActorKind};

use crate::{
    audit::AuditRecord,
    db::{DbResultExt, jcol, scol},
    domain::{Ctx, Domain},
};

#[derive(Debug, Clone)]
pub struct Mapping {
    pub transport: String,
    pub external_id: String,
    pub object_kind: String,
    pub object_id: String,
    pub data: Value,
}

impl Mapping {
    pub fn new(transport: &str, external_id: impl Into<String>, object_kind: &str, object_id: impl Into<String>, data: Value) -> Self {
        Self { transport: transport.into(), external_id: external_id.into(), object_kind: object_kind.into(), object_id: object_id.into(), data }
    }
}

fn mapping_from_row(r: &sqlx::sqlite::SqliteRow) -> Mapping {
    Mapping {
        transport: scol(r, "transport"),
        external_id: scol(r, "external_id"),
        object_kind: scol(r, "object_kind"),
        object_id: scol(r, "object_id"),
        data: jcol(r, "data"),
    }
}

impl Domain {
    /// Inserts a mapping; returns `false` when `(transport, external_id)` already exists (replay/duplicate).
    pub async fn put_mapping(&self, m: &Mapping) -> Result<bool, Error> {
        let res = sqlx::query("INSERT OR IGNORE INTO transport_mappings(transport, external_id, object_kind, object_id, domain_id, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(&m.transport)
            .bind(&m.external_id)
            .bind(&m.object_kind)
            .bind(&m.object_id)
            .bind(&self.cfg.domain_id)
            .bind(m.data.to_string())
            .bind(self.now_ts())
            .execute(self.db.writer())
            .await
            .db()?;
        Ok(res.rows_affected() == 1)
    }

    pub async fn update_mapping_data(&self, transport: &str, external_id: &str, data: &Value) -> Result<(), Error> {
        sqlx::query("UPDATE transport_mappings SET data = ? WHERE transport = ? AND external_id = ?")
            .bind(data.to_string())
            .bind(transport)
            .bind(external_id)
            .execute(self.db.writer())
            .await
            .db()?;
        Ok(())
    }

    pub async fn mapping_by_external(&self, transport: &str, external_id: &str) -> Result<Option<Mapping>, Error> {
        let row = sqlx::query("SELECT * FROM transport_mappings WHERE transport = ? AND external_id = ?")
            .bind(transport)
            .bind(external_id)
            .fetch_optional(self.db.pool())
            .await
            .db()?;
        Ok(row.as_ref().map(mapping_from_row))
    }

    pub async fn mapping_by_object(&self, transport: &str, object_kind: &str, object_id: &str) -> Result<Option<Mapping>, Error> {
        let row = sqlx::query("SELECT * FROM transport_mappings WHERE transport = ? AND object_kind = ? AND object_id = ? ORDER BY created_at ASC LIMIT 1")
            .bind(transport)
            .bind(object_kind)
            .bind(object_id)
            .fetch_optional(self.db.pool())
            .await
            .db()?;
        Ok(row.as_ref().map(mapping_from_row))
    }

    pub async fn matrix_user_for_principal(&self, kind: ActorKind, external_id: &str) -> Result<Option<String>, Error> {
        let v: Option<Option<String>> = sqlx::query_scalar("SELECT h.matrix_user_id FROM human_identities h JOIN principals p ON p.principal_id = h.principal_id WHERE p.domain_id = ? AND p.kind = ? AND p.external_id = ?")
            .bind(&self.cfg.domain_id)
            .bind(crate::domain::kind_str(kind))
            .bind(external_id)
            .fetch_optional(self.db.pool())
            .await
            .db()?;
        Ok(v.flatten())
    }

    pub async fn agent_exists(&self, agent_id: &str) -> Result<bool, Error> {
        let v: Option<i64> = sqlx::query_scalar("SELECT 1 FROM agents WHERE agent_id = ?").bind(agent_id).fetch_optional(self.db.pool()).await.db()?;
        Ok(v.is_some())
    }

    pub async fn principal_display_name(&self, kind: ActorKind, external_id: &str) -> Result<Option<String>, Error> {
        let v: Option<Option<String>> = sqlx::query_scalar("SELECT display_name FROM principals WHERE domain_id = ? AND kind = ? AND external_id = ?")
            .bind(&self.cfg.domain_id)
            .bind(crate::domain::kind_str(kind))
            .bind(external_id)
            .fetch_optional(self.db.pool())
            .await
            .db()?;
        Ok(v.flatten())
    }

    /// Audit entry outside a domain mutation (bridge observations such as unmapped Matrix senders).
    pub async fn record_audit(&self, ctx: &Ctx, rec: AuditRecord) -> Result<(), Error> {
        let this = self.clone();
        let ctx = ctx.clone();
        self.write(move |tx| Box::pin(async move { this.audit(tx, &ctx, rec).await.map(|_| ()) })).await
    }

    pub fn observation(action: &str, resource: Option<String>, detail: Value) -> AuditRecord {
        AuditRecord::new(action, resource, "observed").detail(detail)
    }

    pub fn empty_detail() -> Value {
        json!({})
    }
}
