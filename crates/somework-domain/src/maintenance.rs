//! Maintenance: idempotency expiry and message/audit retention.

use serde::Serialize;
use somework_core::Error;

use crate::{db::DbResultExt, domain::Domain};

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MaintenanceReport {
    pub idempotency_purged: u64,
}

impl Domain {
    pub async fn run_maintenance(&self) -> Result<MaintenanceReport, Error> {
        Ok(MaintenanceReport { idempotency_purged: self.purge_expired_idempotency().await? })
    }

    /// Applies message/audit retention windows. Audit and task history deletions go through the guarded purge flag.
    pub async fn purge_retention(&self) -> Result<u64, Error> {
        let msg_cutoff = somework_core::clock::ts(self.now() - chrono::Duration::days(self.cfg.message_retention_days));
        let audit_cutoff = somework_core::clock::ts(self.now() - chrono::Duration::days(self.cfg.audit_retention_days));
        let purged = self
            .write(move |tx| {
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
            .await?;
        Ok(purged + self.purge_published_events().await?)
    }
}
