//! Domain-side hooks for federation: remote agents, egress routing and system routing. The gateway crate owns
//! the protocol; the domain only decides *when* a task needs to leave the domain.

use serde_json::json;
use somework_core::Error;
use sqlx::SqliteConnection;

use crate::{
    config::SINK_GATEWAY,
    db::DbResultExt,
    domain::{Ctx, Domain},
    events::{EventSpec, NatsRoute},
    policy::AuthzRequest,
    tasks::TaskRow,
};

/// Catalog agents that stand for a capability served by another trust domain or an external A2A agent.
pub const REMOTE_AGENT_PREFIX: &str = "remote:";
pub const A2A_AGENT_PREFIX: &str = "a2a:";

pub fn is_remote_agent(agent_id: &str) -> bool {
    agent_id.starts_with(REMOTE_AGENT_PREFIX) || agent_id.starts_with(A2A_AGENT_PREFIX)
}

pub const EGRESS_SUBJECT_PREFIX: &str = "egress.";

impl Domain {
    /// Remote agents that would serve this task (the explicit target, or every eligible agent when all are remote).
    pub(crate) async fn remote_targets(&self, conn: &mut SqliteConnection, row: &TaskRow) -> Result<Vec<String>, Error> {
        if let Some(target) = &row.target_agent_id {
            return Ok(if is_remote_agent(target) { vec![target.clone()] } else { vec![] });
        }
        let eligible = self.eligible_agents(conn, &row.capability_id, &row.capability_version).await?;
        Ok(eligible.into_iter().map(|(a, _)| a).filter(|a| is_remote_agent(a)).collect())
    }

    /// `true` when no local agent could serve the task, so the gateway must forward it before it can be queued.
    pub(crate) async fn is_remote_only(&self, conn: &mut SqliteConnection, row: &TaskRow) -> Result<bool, Error> {
        if let Some(target) = &row.target_agent_id {
            return Ok(is_remote_agent(target));
        }
        let eligible = self.eligible_agents(conn, &row.capability_id, &row.capability_version).await?;
        Ok(!eligible.is_empty() && eligible.iter().all(|(a, _)| is_remote_agent(a)))
    }

    pub(crate) fn egress_routes(&self, row: &TaskRow, agents: &[String]) -> Vec<NatsRoute> {
        if !self.cfg.sink_enabled(SINK_GATEWAY) {
            return vec![];
        }
        agents
            .iter()
            .map(|agent| NatsRoute {
                subject: format!("{EGRESS_SUBJECT_PREFIX}{agent}"),
                payload: json!({"taskId": row.task_id, "revision": row.revision, "agentId": agent, "capabilityId": row.capability_id, "state": row.state.as_str()}),
            })
            .collect()
    }

    /// Announces a `submitted` task that must be forwarded through the gateway.
    pub(crate) async fn emit_egress_request(&self, conn: &mut SqliteConnection, ctx: &Ctx, row: &TaskRow, agents: &[String]) -> Result<(), Error> {
        let mut spec = EventSpec::new("task.federating", json!({"taskId": row.task_id, "revision": row.revision, "state": row.state.as_str()}))
            .task(&row.task_id, row.revision);
        spec.gateway = self.egress_routes(row, agents);
        spec = spec.recipient(row.requester_principal_id.clone(), false);
        self.emit(conn, ctx, spec).await?;
        Ok(())
    }

    /// System operation for the gateway: `submitted` -> `queued` once the remote domain accepted the request.
    pub async fn system_route_task(&self, ctx: &Ctx, task_id: &str) -> Result<(), Error> {
        let this = self.clone();
        let ctx = ctx.clone();
        let task_id = task_id.to_string();
        self.write(move |tx| {
            Box::pin(async move {
                let conn = &mut **tx;
                this.enforce(conn, &ctx, AuthzRequest::new("task.reconcile").resource(format!("task://{task_id}")).task(&task_id)).await?;
                let mut row = this.load_task(conn, &task_id).await?;
                if row.state == somework_core::fsm::TaskState::Submitted {
                    this.route_task(conn, &ctx, &mut row, "queued").await?;
                }
                Ok(())
            })
        })
        .await
    }

    /// Open (non-terminal) egress mappings, used by the gateway to resume monitoring after a restart.
    pub async fn open_egress_task_ids(&self) -> Result<Vec<String>, Error> {
        sqlx::query_scalar("SELECT internal_task_id FROM federated_tasks WHERE direction IN ('egress','a2a_out') AND status = 'open'")
            .fetch_all(self.db.pool())
            .await
            .db()
    }
}
