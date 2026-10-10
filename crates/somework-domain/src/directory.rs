//! Read-only directory queries used by transport planes to provision per-agent resources.

use serde::Serialize;
use somework_core::Error;

use crate::{
    db::{DbResultExt, icol, scol},
    domain::Domain,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDirectoryEntry {
    pub agent_id: String,
    pub pool_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSubscription {
    pub subscription_id: String,
    pub agent_id: String,
    pub wake: bool,
}

impl Domain {
    /// Every enrolled agent that has a registered card (draft or approved), with its worker pool.
    pub async fn agent_directory(&self) -> Result<Vec<AgentDirectoryEntry>, Error> {
        let rows = sqlx::query("SELECT agent_id, pool_id FROM agents WHERE domain_id = ? AND status <> 'disabled' ORDER BY agent_id")
            .bind(&self.cfg.domain_id)
            .fetch_all(self.db.pool())
            .await
            .db()?;
        Ok(rows.iter().map(|r| AgentDirectoryEntry { agent_id: scol(r, "agent_id"), pool_id: scol(r, "pool_id") }).collect())
    }

    /// Agent ids that hold an agent principal even without a registered card (pure requesters).
    pub async fn agent_principals(&self) -> Result<Vec<String>, Error> {
        let rows = sqlx::query("SELECT external_id FROM principals WHERE domain_id = ? AND kind = 'agent' AND status = 'active' ORDER BY external_id")
            .bind(&self.cfg.domain_id)
            .fetch_all(self.db.pool())
            .await
            .db()?;
        Ok(rows.iter().map(|r| scol(r, "external_id")).collect())
    }

    pub async fn agent_subscriptions(&self) -> Result<Vec<AgentSubscription>, Error> {
        let rows = sqlx::query("SELECT s.subscription_id, p.external_id, s.wake FROM subscriptions s JOIN principals p ON p.principal_id = s.principal_id WHERE s.domain_id = ? AND s.status = 'active' AND p.kind = 'agent'")
            .bind(&self.cfg.domain_id)
            .fetch_all(self.db.pool())
            .await
            .db()?;
        Ok(rows
            .iter()
            .map(|r| AgentSubscription { subscription_id: scol(r, "subscription_id"), agent_id: scol(r, "external_id"), wake: icol(r, "wake") != 0 })
            .collect())
    }
}
