//! Policy management and operator overview.

use serde_json::{Value, json};
use somework_core::{Error, ErrorCode};

use crate::{
    audit::AuditRecord,
    db::{DbResultExt, icol, scol},
    domain::{Ctx, Domain},
    policy::{AuthzRequest, PolicyDocument},
};

impl Domain {
    pub async fn db_healthy(&self) -> bool {
        sqlx::query_scalar::<_, i64>("SELECT 1").fetch_one(self.db.pool()).await.is_ok()
    }

    pub async fn get_policy(&self, ctx: &Ctx) -> Result<PolicyDocument, Error> {
        if ctx.actor.permissions.allows_action("policy.manage") || ctx.actor.permissions.allows_action("ops.read") {
            let mut conn = self.db.pool().acquire().await.db()?;
            return self.active_policy(&mut conn).await;
        }
        self.enforce_read(ctx, AuthzRequest::new("policy.manage")).await?;
        Err(Error::denied("policy.manage is required"))
    }

    /// Activates a new policy version. Previous versions stay in the table so decisions remain explainable.
    pub async fn put_policy(&self, ctx: &Ctx, mut doc: PolicyDocument) -> Result<PolicyDocument, Error> {
        self.run(ctx, "policy.put", async {
            if doc.classification_levels.is_empty() {
                return Err(Error::invalid("classificationLevels must not be empty"));
            }
            if doc.version.trim().is_empty() || doc.version == "builtin-1" {
                doc.version = format!("policy-{}", self.now_ts());
            }
            let this = self.clone();
            let ctx = ctx.clone();
            self.write(move |tx| {
                Box::pin(async move {
                    let conn = &mut **tx;
                    let decision = this.enforce(conn, &ctx, AuthzRequest::new("policy.manage")).await?;
                    let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM policies WHERE domain_id = ? AND version = ?")
                        .bind(&this.cfg.domain_id)
                        .bind(&doc.version)
                        .fetch_optional(&mut *conn)
                        .await
                        .db()?;
                    if exists.is_some() {
                        return Err(Error::new(ErrorCode::Conflict, format!("policy version {} already exists", doc.version)));
                    }
                    sqlx::query("UPDATE policies SET active = 0 WHERE domain_id = ? AND active = 1")
                        .bind(&this.cfg.domain_id)
                        .execute(&mut *conn)
                        .await
                        .db()?;
                    sqlx::query("INSERT INTO policies(version, domain_id, document, active, created_by, created_at) VALUES (?, ?, ?, 1, ?, ?)")
                        .bind(&doc.version)
                        .bind(&this.cfg.domain_id)
                        .bind(serde_json::to_string(&doc)?)
                        .bind(ctx.actor.label())
                        .bind(this.now_ts())
                        .execute(&mut *conn)
                        .await
                        .db()?;
                    this.audit(conn, &ctx, AuditRecord::new("policy.put", Some(format!("policy://{}", doc.version)), "success").decision(&decision)).await?;
                    Ok(doc)
                })
            })
            .await
        })
        .await
    }

    pub async fn overview(&self, ctx: &Ctx) -> Result<Value, Error> {
        self.enforce_read(ctx, AuthzRequest::new("ops.read")).await?;
        let pool = self.db.pool();
        let mut states = serde_json::Map::new();
        for r in sqlx::query("SELECT state, COUNT(*) AS n FROM tasks GROUP BY state").fetch_all(pool).await.db()? {
            states.insert(scol(&r, "state"), json!(icol(&r, "n")));
        }
        let agents: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agents").fetch_one(pool).await.db()?;
        let drafts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM catalog_entries WHERE approval_status = 'draft'").fetch_one(pool).await.db()?;
        let cutoff = somework_core::clock::ts(self.now() - chrono::Duration::seconds(self.cfg.runtime_ttl_seconds));
        let online: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM runtime_instances WHERE status = 'active' AND last_seen_at >= ?")
            .bind(&cutoff)
            .fetch_one(pool)
            .await
            .db()?;
        let approvals: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM approvals WHERE status = 'pending'").fetch_one(pool).await.db()?;
        let denials: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM policy_decisions WHERE decision = 'deny' AND occurred_at >= ?")
            .bind(somework_core::clock::ts(self.now() - chrono::Duration::hours(24)))
            .fetch_one(pool)
            .await
            .db()?;
        let reconciliation: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM tasks WHERE state = 'blocked' AND json_extract(blocker, '$.kind') = 'reconciliation'")
                .fetch_one(pool)
                .await
                .db()?;
        let policy = {
            let mut conn = pool.acquire().await.db()?;
            self.active_policy(&mut conn).await?
        };
        Ok(json!({
            "domainId": self.cfg.domain_id,
            "tasksByState": states,
            "agents": agents,
            "draftCatalogEntries": drafts,
            "onlineRuntimes": online,
            "pendingApprovals": approvals,
            "denialsLast24h": denials,
            "reconciliationQueue": reconciliation,
            "outbox": self.outbox_stats().await?,
            "policyVersion": policy.version,
            "matrixProfile": self.cfg.matrix_profile,
            "objectStore": self.object_store().map(|s| s.kind()).unwrap_or("none"),
        }))
    }
}
