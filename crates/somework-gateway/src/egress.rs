//! Egress: forwards local tasks whose capability is served by another trust domain (or an external A2A agent) and
//! drives them as the local *pseudo-worker* of the remote agent: claim with a fencing token, mirror remote progress,
//! validate and commit the result — or reject/fail the local task when the remote side refuses.

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value, json};
use somework_core::{
    Error, ErrorCode,
    canonical::sha256_hex,
    contracts::{AgentCard, ArtifactRef, Failure},
    fsm::TaskState,
};
use somework_domain::{
    Ctx, Domain,
    artifacts::{BeginUpload, CompleteUpload},
    auth::CreatePrincipal,
    db::{DbResultExt, icol, jcol, scol, scol_opt},
    federation::is_remote_agent,
    outbox::{OutboxItem, OutboxSink, SinkError},
    policy::Permissions,
    runtimes::RegisterRuntime,
    tasks::{CancelRequest, ClaimRequest, CompleteRequest, FailRequest, HeartbeatRequest, ProgressRequest, ProgressStatus, TaskView},
};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum RemoteState {
    Queued,
    Running,
    InputRequired,
    Succeeded,
    Failed,
    Canceled,
    Rejected,
}

#[derive(Debug, Clone)]
pub struct RemoteArtifact {
    pub artifact_id: String,
    pub version: u64,
    pub filename: Option<String>,
    pub media_type: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub classification: String,
    /// Backend specific location (federation path or A2A file URL).
    pub location: String,
}

#[derive(Debug, Clone, Default)]
pub struct RemoteSnapshot {
    pub state: Option<RemoteState>,
    pub result: Option<Value>,
    pub failure_code: Option<String>,
    pub failure_message: Option<String>,
    pub progress: Vec<String>,
    pub artifacts: Vec<RemoteArtifact>,
    pub cursor: i64,
}

#[derive(Debug, Clone)]
pub struct RemoteRef {
    pub external_task_id: String,
    pub external_context_id: Option<String>,
    pub peer_domain_id: Option<String>,
    pub remote_interface: String,
    pub protocol_version: String,
    pub card_digest: Option<String>,
    pub remote_principal: Option<String>,
}

pub enum SubmitOutcome {
    Accepted(RemoteRef),
    Rejected { code: String, message: String },
}

#[derive(Debug)]
pub enum BackendError {
    Transient(String),
    /// The remote task no longer exists or the request is refused for good.
    Gone(String),
}

#[derive(Debug, Clone)]
pub struct AgentInfo {
    pub agent_id: String,
    pub source_type: String,
    pub source_uri: Option<String>,
    pub source_digest: Option<String>,
    pub card: AgentCard,
    pub trust_tier: String,
}

#[async_trait]
pub trait RemoteBackend: Send + Sync + 'static {
    async fn submit(&self, task: &TaskView, agent: &AgentInfo) -> Result<SubmitOutcome, BackendError>;
    async fn poll(&self, remote: &RemoteRef, cursor: i64) -> Result<RemoteSnapshot, BackendError>;
    async fn cancel(&self, remote: &RemoteRef) -> Result<(), BackendError>;
    async fn fetch_artifact(&self, remote: &RemoteRef, artifact: &RemoteArtifact) -> Result<Vec<u8>, BackendError>;
}

pub struct Egress {
    domain: Domain,
    federation: Arc<dyn RemoteBackend>,
    a2a: Arc<dyn RemoteBackend>,
    poll: Duration,
    lease_seconds: i64,
    workers: Mutex<HashMap<String, Ctx>>,
    active: Mutex<HashSet<String>>,
    shutdown: CancellationToken,
    http: reqwest::Client,
}

fn code_of(e: &Error) -> ErrorCode {
    e.code
}

impl Egress {
    pub fn new(
        domain: Domain,
        federation: Arc<dyn RemoteBackend>,
        a2a: Arc<dyn RemoteBackend>,
        poll: Duration,
        lease_seconds: i64,
        shutdown: CancellationToken,
    ) -> Arc<Self> {
        Arc::new(Self {
            domain,
            federation,
            a2a,
            poll,
            lease_seconds,
            workers: Default::default(),
            active: Default::default(),
            shutdown,
            http: reqwest::Client::new(),
        })
    }

    async fn agent_info(&self, agent_id: &str) -> Result<AgentInfo, Error> {
        let row = sqlx::query("SELECT a.card, c.source_type, c.source_uri, c.source_digest, c.trust_tier FROM agents a JOIN catalog_entries c ON c.agent_id = a.agent_id WHERE a.agent_id = ?").bind(agent_id).fetch_optional(self.domain.db.pool()).await.db()?.ok_or_else(|| Error::not_found("remote agent"))?;
        Ok(AgentInfo {
            agent_id: agent_id.into(),
            source_type: scol(&row, "source_type"),
            source_uri: scol_opt(&row, "source_uri"),
            source_digest: scol_opt(&row, "source_digest"),
            card: serde_json::from_value(jcol(&row, "card"))?,
            trust_tier: scol_opt(&row, "trust_tier").unwrap_or_else(|| "partner".into()),
        })
    }

    fn backend_for(&self, agent: &AgentInfo) -> Arc<dyn RemoteBackend> {
        if agent.source_type == "a2a" || agent.agent_id.starts_with(somework_domain::federation::A2A_AGENT_PREFIX) {
            self.a2a.clone()
        } else {
            self.federation.clone()
        }
    }

    /// Ensures the remote agent has a principal and a live runtime instance so it can claim like any worker.
    pub async fn worker_ctx(&self, agent: &AgentInfo) -> Result<Ctx, Error> {
        if let Some(ctx) = self.workers.lock().get(&agent.agent_id) {
            return Ok(ctx.clone());
        }
        let sys = self.domain.system_ctx();
        let mut conn = self.domain.db.pool().acquire().await.db()?;
        let principal = match self.domain.principal_by_label(&mut conn, somework_core::contracts::ActorKind::Agent, &agent.agent_id).await? {
            Some(p) => p,
            None => {
                let mut perms = Permissions::default_agent();
                perms.side_effects_at_most = Some(somework_core::contracts::SideEffects::Irreversible);
                perms.classification_max = Some(if matches!(agent.trust_tier.as_str(), "external" | "untrusted") { "public" } else { "internal" }.into());
                self.domain
                    .create_principal(
                        &sys,
                        CreatePrincipal {
                            kind: somework_core::contracts::ActorKind::Agent,
                            id: agent.agent_id.clone(),
                            display_name: Some(agent.card.display_name.clone()),
                            permissions: Some(perms),
                            public_key: None,
                            matrix_user_id: None,
                            oidc_issuer: None,
                            oidc_subject: None,
                        },
                    )
                    .await?
            }
        };
        drop(conn);
        let mut actor = self.domain.actor_for_principal(&principal, None).await;
        actor.runtime_instance_id = Some(format!("rt_gateway_{}", somework_core::ids::jti()));
        let ctx = Ctx::new(actor).with_transport("gateway");
        self.domain
            .register_runtime(
                &ctx,
                RegisterRuntime { runtime_instance_id: ctx.actor.runtime_instance_id.clone(), meta: Some(json!({"kind": "gateway-egress"})) },
            )
            .await?;
        self.workers.lock().insert(agent.agent_id.clone(), ctx.clone());
        Ok(ctx)
    }

    /// Keeps remote agents "alive" in the catalog (availability) while the gateway runs.
    pub async fn refresh_workers(&self) -> Result<(), Error> {
        let ids: Vec<String> = sqlx::query_scalar("SELECT agent_id FROM agents WHERE agent_id LIKE 'remote:%' OR agent_id LIKE 'a2a:%'")
            .fetch_all(self.domain.db.pool())
            .await
            .db()?;
        for id in ids.into_iter().filter(|i| is_remote_agent(i)) {
            let agent = self.agent_info(&id).await?;
            let ctx = self.worker_ctx(&agent).await?;
            if self.domain.runtime_heartbeat(&ctx).await.is_err() {
                self.workers.lock().remove(&id);
            }
        }
        Ok(())
    }

    async fn mapping(&self, task_id: &str) -> Result<Option<(RemoteRef, i64)>, Error> {
        let row = sqlx::query("SELECT * FROM federated_tasks WHERE internal_task_id = ? AND direction IN ('egress','a2a_out')")
            .bind(task_id)
            .fetch_optional(self.domain.db.pool())
            .await
            .db()?;
        Ok(row.map(|r| {
            (
                RemoteRef {
                    external_task_id: scol_opt(&r, "external_task_id").unwrap_or_default(),
                    external_context_id: scol_opt(&r, "external_context_id"),
                    peer_domain_id: scol_opt(&r, "peer_domain_id"),
                    remote_interface: scol_opt(&r, "remote_interface").unwrap_or_default(),
                    protocol_version: scol_opt(&r, "protocol_version").unwrap_or_default(),
                    card_digest: scol_opt(&r, "remote_agent_card_digest"),
                    remote_principal: scol_opt(&r, "remote_principal"),
                },
                icol(&r, "last_remote_event"),
            )
        }))
    }

    async fn store_mapping(&self, task_id: &str, direction: &str, r: &RemoteRef) -> Result<(), Error> {
        sqlx::query("INSERT OR IGNORE INTO federated_tasks(internal_task_id, direction, peer_domain_id, external_task_id, external_context_id, remote_agent_card_digest, remote_interface, remote_principal, protocol_version, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)")
            .bind(task_id)
            .bind(direction)
            .bind(&r.peer_domain_id)
            .bind(&r.external_task_id)
            .bind(&r.external_context_id)
            .bind(&r.card_digest)
            .bind(&r.remote_interface)
            .bind(&r.remote_principal)
            .bind(&r.protocol_version)
            .bind(self.domain.now_ts())
            .bind(self.domain.now_ts())
            .execute(self.domain.db.writer())
            .await
            .db()?;
        Ok(())
    }

    async fn set_cursor(&self, task_id: &str, cursor: i64) {
        let _ = sqlx::query("UPDATE federated_tasks SET last_remote_event = ?, updated_at = ? WHERE internal_task_id = ?")
            .bind(cursor)
            .bind(self.domain.now_ts())
            .bind(task_id)
            .execute(self.domain.db.writer())
            .await;
    }

    async fn mark_done(&self, task_id: &str) {
        let _ = sqlx::query("UPDATE federated_tasks SET status = 'done', updated_at = ? WHERE internal_task_id = ?")
            .bind(self.domain.now_ts())
            .bind(task_id)
            .execute(self.domain.db.writer())
            .await;
    }

    /// Entry point for one outbox row (or a resume after restart). Idempotent: safe to call repeatedly per task.
    pub async fn handle(self: &Arc<Self>, task_id: &str, agent_id: &str) -> Result<(), SinkError> {
        let sys = self.domain.system_ctx();
        let task = self.domain.get_task(&sys, task_id).await.map_err(|e| SinkError::permanent(e.to_string()))?;
        if task.task.state.is_terminal() {
            self.mark_done(task_id).await;
            return Ok(());
        }
        let agent = self.agent_info(agent_id).await.map_err(|e| SinkError::permanent(e.to_string()))?;
        let backend = self.backend_for(&agent);
        let direction = if backend_is_a2a(&agent) { "a2a_out" } else { "egress" };
        let wctx = self.worker_ctx(&agent).await.map_err(|e| SinkError::transient(e.to_string()))?;

        let remote = match self.mapping(task_id).await.map_err(|e| SinkError::transient(e.to_string()))? {
            Some((r, _)) => r,
            None => match backend.submit(&task, &agent).await {
                Ok(SubmitOutcome::Accepted(r)) => {
                    self.store_mapping(task_id, direction, &r).await.map_err(|e| SinkError::transient(e.to_string()))?;
                    r
                }
                Ok(SubmitOutcome::Rejected { code, message }) => return self.reject_locally(&task, &wctx, &code, &message).await,
                Err(BackendError::Transient(m)) => return Err(SinkError::transient(m)),
                Err(BackendError::Gone(m)) => return self.reject_locally(&task, &wctx, "remote_refused", &m).await,
            },
        };
        if task.task.state == TaskState::Submitted {
            self.domain.system_route_task(&sys, task_id).await.map_err(|e| SinkError::transient(e.to_string()))?;
        }
        let claim = match self.domain.claim_task(&wctx, task_id, ClaimRequest { lease_seconds: Some(self.lease_seconds), ..Default::default() }).await {
            Ok(c) => c,
            Err(e) if matches!(code_of(&e), ErrorCode::AlreadyClaimed | ErrorCode::TaskTerminal | ErrorCode::InvalidTransition | ErrorCode::PolicyDenied) => {
                return Ok(());
            }
            Err(e) => return Err(SinkError::transient(e.to_string())),
        };
        if self.active.lock().insert(task_id.to_string()) {
            let this = self.clone();
            let (tid, fence) = (task_id.to_string(), claim.fencing_token);
            tokio::spawn(async move {
                this.monitor(&tid, wctx, backend, remote, fence).await;
                this.active.lock().remove(&tid);
            });
        }
        Ok(())
    }

    async fn reject_locally(&self, task: &TaskView, wctx: &Ctx, code: &str, message: &str) -> Result<(), SinkError> {
        let sys = self.domain.system_ctx();
        let id = &task.task.task_id;
        if task.task.state == TaskState::Submitted {
            self.domain.reject_task(&sys, id, code, message).await.map_err(|e| SinkError::transient(e.to_string()))?;
        } else if let Ok(claim) = self.domain.claim_task(wctx, id, ClaimRequest::default()).await {
            let _ = self.domain.progress_task(wctx, id, ProgressRequest { fencing_token: Some(claim.fencing_token), ..Default::default() }).await;
            let _ = self
                .domain
                .fail_task(
                    wctx,
                    id,
                    FailRequest {
                        fencing_token: Some(claim.fencing_token),
                        failure: Some(Failure { code: code.into(), message: message.into(), retryable: false, details: None }),
                        ..Default::default()
                    },
                )
                .await;
        }
        self.mark_done(id).await;
        Ok(())
    }

    pub async fn resume_open(self: &Arc<Self>) {
        let Ok(ids) = self.domain.open_egress_task_ids().await else { return };
        for id in ids {
            let target: Option<String> = sqlx::query_scalar("SELECT COALESCE(assignee_agent_id, target_agent_id) FROM tasks WHERE task_id = ?")
                .bind(&id)
                .fetch_optional(self.domain.db.pool())
                .await
                .ok()
                .flatten()
                .flatten();
            if let Some(agent) = target {
                let _ = self.handle(&id, &agent).await;
            }
        }
    }

    async fn monitor(&self, task_id: &str, wctx: Ctx, backend: Arc<dyn RemoteBackend>, remote: RemoteRef, fence: u64) {
        let mut cursor = self.mapping(task_id).await.ok().flatten().map(|m| m.1).unwrap_or(0);
        let mut last_heartbeat = tokio::time::Instant::now();
        let mut started = false;
        let mut blocked = false;
        let sys = self.domain.system_ctx();
        loop {
            tokio::select! {
                _ = self.shutdown.cancelled() => return,
                _ = tokio::time::sleep(self.poll) => {},
            }
            let Ok(local) = self.domain.get_task(&sys, task_id).await else { return };
            if local.task.state.is_terminal() {
                if local.task.state == TaskState::Canceled {
                    let _ = backend.cancel(&remote).await;
                }
                self.mark_done(task_id).await;
                return;
            }
            if local.task.state == TaskState::CancelRequested {
                let _ = backend.cancel(&remote).await;
                let _ = self.domain.cancel_task(&wctx, task_id, CancelRequest { acknowledge: true, fencing_token: Some(fence), ..Default::default() }).await;
                self.mark_done(task_id).await;
                return;
            }
            if last_heartbeat.elapsed() >= Duration::from_secs((self.lease_seconds / 3).max(1) as u64) {
                if self
                    .domain
                    .heartbeat_task(&wctx, task_id, HeartbeatRequest { fencing_token: Some(fence), lease_seconds: Some(self.lease_seconds) })
                    .await
                    .is_err()
                {
                    return; // lease lost: the requeue event will bring this task back through `handle`
                }
                last_heartbeat = tokio::time::Instant::now();
            }
            let snapshot = match backend.poll(&remote, cursor).await {
                Ok(s) => s,
                Err(BackendError::Transient(m)) => {
                    if !blocked && started {
                        blocked = true;
                        let _ = self
                            .domain
                            .progress_task(
                                &wctx,
                                task_id,
                                ProgressRequest {
                                    fencing_token: Some(fence),
                                    status: Some(ProgressStatus::Blocked),
                                    message: Some(format!("remote unreachable: {m}")),
                                    blocked_on: Some(vec![remote.remote_interface.clone()]),
                                    ..Default::default()
                                },
                            )
                            .await;
                    }
                    continue;
                }
                Err(BackendError::Gone(m)) => {
                    self.fail(&wctx, task_id, fence, "remote_gone", &m).await;
                    self.mark_done(task_id).await;
                    return;
                }
            };
            if blocked {
                blocked = false;
                let _ = self
                    .domain
                    .progress_task(
                        &wctx,
                        task_id,
                        ProgressRequest {
                            fencing_token: Some(fence),
                            status: Some(ProgressStatus::Running),
                            message: Some("remote reachable again".into()),
                            ..Default::default()
                        },
                    )
                    .await;
            }
            if snapshot.cursor > cursor {
                cursor = snapshot.cursor;
                self.set_cursor(task_id, cursor).await;
            }
            match snapshot.state {
                Some(RemoteState::Queued) | None => {
                    for m in &snapshot.progress {
                        let _ = self
                            .domain
                            .progress_task(&wctx, task_id, ProgressRequest { fencing_token: Some(fence), message: Some(m.clone()), ..Default::default() })
                            .await;
                        started = true;
                    }
                }
                Some(RemoteState::Running) => {
                    if !started || !snapshot.progress.is_empty() {
                        let message = snapshot.progress.last().cloned().or_else(|| (!started).then(|| "running remotely".to_string()));
                        let _ = self.domain.progress_task(&wctx, task_id, ProgressRequest { fencing_token: Some(fence), message, ..Default::default() }).await;
                        started = true;
                    }
                }
                Some(RemoteState::InputRequired) => {
                    self.fail(&wctx, task_id, fence, "remote_input_required", "the remote agent asked for input; interactive federation is not supported")
                        .await;
                    let _ = backend.cancel(&remote).await;
                    self.mark_done(task_id).await;
                    return;
                }
                Some(RemoteState::Succeeded) => {
                    self.finish_success(&wctx, task_id, fence, &remote, &backend, snapshot, started).await;
                    self.mark_done(task_id).await;
                    return;
                }
                Some(state @ (RemoteState::Failed | RemoteState::Canceled | RemoteState::Rejected)) => {
                    let code = snapshot.failure_code.clone().unwrap_or_else(|| format!("remote_{}", format!("{state:?}").to_lowercase()));
                    self.ensure_running(&wctx, task_id, fence, started).await;
                    self.fail(&wctx, task_id, fence, &code, snapshot.failure_message.as_deref().unwrap_or("the remote task did not succeed")).await;
                    self.mark_done(task_id).await;
                    return;
                }
            }
        }
    }

    async fn ensure_running(&self, wctx: &Ctx, task_id: &str, fence: u64, started: bool) {
        if !started {
            let _ = self.domain.progress_task(wctx, task_id, ProgressRequest { fencing_token: Some(fence), ..Default::default() }).await;
        }
    }

    async fn fail(&self, wctx: &Ctx, task_id: &str, fence: u64, code: &str, message: &str) {
        let _ = self
            .domain
            .fail_task(
                wctx,
                task_id,
                FailRequest {
                    fencing_token: Some(fence),
                    failure: Some(Failure { code: code.into(), message: message.into(), retryable: false, details: None }),
                    ..Default::default()
                },
            )
            .await;
    }

    #[allow(clippy::too_many_arguments)]
    async fn finish_success(
        &self,
        wctx: &Ctx,
        task_id: &str,
        fence: u64,
        remote: &RemoteRef,
        backend: &Arc<dyn RemoteBackend>,
        snapshot: RemoteSnapshot,
        started: bool,
    ) {
        self.ensure_running(wctx, task_id, fence, started).await;
        let mut artifacts: Vec<ArtifactRef> = vec![];
        for a in &snapshot.artifacts {
            match self.import_artifact(wctx, task_id, remote, backend, a).await {
                Ok(r) => artifacts.push(r),
                Err(e) => {
                    self.fail(wctx, task_id, fence, "remote_artifact_rejected", &e.to_string()).await;
                    return;
                }
            }
        }
        let result = snapshot.result.unwrap_or_else(|| json!({}));
        if let Err(e) = self
            .domain
            .complete_task(wctx, task_id, CompleteRequest { fencing_token: Some(fence), result: Some(result), artifacts, ..Default::default() })
            .await
        {
            let code = if e.code == ErrorCode::SchemaViolation { "invalid_remote_result" } else { "result_rejected" };
            self.fail(wctx, task_id, fence, code, &e.message).await;
        }
    }

    /// Artifacts are accepted only after the remote gateway disclosed them *and* the bytes hash to the disclosed digest.
    async fn import_artifact(
        &self,
        wctx: &Ctx,
        task_id: &str,
        remote: &RemoteRef,
        backend: &Arc<dyn RemoteBackend>,
        a: &RemoteArtifact,
    ) -> Result<ArtifactRef, Error> {
        let bytes = backend.fetch_artifact(remote, a).await.map_err(|e| Error::unavailable(format!("artifact fetch: {e:?}")))?;
        let actual = sha256_hex(&bytes);
        // A2A files carry no mandatory digest: when none was disclosed we can only pin what we received.
        let verifiable = !a.sha256.is_empty();
        if verifiable && (actual != a.sha256.to_lowercase() || bytes.len() as u64 != a.size_bytes) {
            return Err(Error::new(ErrorCode::IntegrityFailure, "remote artifact does not match its disclosed digest"));
        }
        let classification = if ["public", "internal", "confidential", "restricted"].contains(&a.classification.as_str()) {
            a.classification.clone()
        } else {
            "internal".into()
        };
        let grant = self
            .domain
            .begin_artifact_upload(
                wctx,
                BeginUpload {
                    filename: a.filename.clone(),
                    media_type: Some(a.media_type.clone()),
                    size_bytes: Some(bytes.len() as u64),
                    sha256: Some(actual),
                    classification: Some(classification),
                    source_task_id: Some(task_id.into()),
                    ..Default::default()
                },
            )
            .await?;
        let resp = self.http.put(&grant.plan.url).body(bytes).send().await.map_err(|e| Error::unavailable(format!("local object upload: {e}")))?;
        if !resp.status().is_success() {
            return Err(Error::unavailable(format!("local object upload failed: {}", resp.status())));
        }
        self.domain.complete_artifact_upload(wctx, &grant.artifact_id, CompleteUpload { version: Some(grant.version), parts: vec![] }).await
    }
}

fn backend_is_a2a(agent: &AgentInfo) -> bool {
    agent.source_type == "a2a" || agent.agent_id.starts_with(somework_domain::federation::A2A_AGENT_PREFIX)
}

/// Outbox sink "gateway": one row per (task, remote agent) request.
pub struct EgressSink {
    pub egress: Arc<Egress>,
}

#[async_trait]
impl OutboxSink for EgressSink {
    fn name(&self) -> &'static str {
        "gateway"
    }

    async fn deliver(&self, item: &OutboxItem) -> Result<(), SinkError> {
        let task_id = item.payload["taskId"].as_str().ok_or_else(|| SinkError::permanent("egress row has no taskId"))?;
        let agent_id = item.payload["agentId"].as_str().ok_or_else(|| SinkError::permanent("egress row has no agentId"))?;
        self.egress.handle(task_id, agent_id).await
    }
}
