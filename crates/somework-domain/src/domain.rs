use std::{ops::Deref, sync::Arc};

use futures::future::BoxFuture;
use parking_lot::RwLock;
use serde_json::{Value, json};
use somework_core::{
    Error, ErrorCode,
    clock::{SharedClock, system_clock, ts},
    contracts::{ActorKind, ActorRef},
    ids,
    jws::{self, new_signing_key, signing_key_from_b64, signing_key_to_b64, verifying_key_to_b64},
    trace::TraceContext,
};
use sqlx::{Row, SqliteConnection};
use tokio::sync::Notify;

use crate::{
    config::DomainConfig,
    db::{Db, DbOptions, DbResultExt, Tx, db_error},
    failpoints::Failpoints,
    metrics::Metrics,
    policy::{AuthzRequest, Decision, Permissions, PolicyDocument, evaluate},
    secrets::MasterKey,
};

pub struct Inner {
    pub db: Db,
    pub cfg: DomainConfig,
    pub clock: SharedClock,
    pub master: MasterKey,
    pub metrics: Metrics,
    pub failpoints: Failpoints,
    pub outbox_notify: Notify,
    pub event_notify: Notify,
    pub(crate) signing: RwLock<Option<(String, ed25519_dalek::SigningKey)>>,
    pub(crate) objects: RwLock<Option<Arc<dyn crate::objects::ObjectStore>>>,
}

#[derive(Clone)]
pub struct Domain {
    inner: Arc<Inner>,
}

impl Deref for Domain {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.inner
    }
}

/// An authenticated caller. Identity is only ever constructed by [`Domain::authenticate`] (ID-03).
#[derive(Debug, Clone)]
pub struct Actor {
    pub principal_id: String,
    pub kind: ActorKind,
    pub id: String,
    pub domain_id: String,
    pub display_name: Option<String>,
    /// Effective permissions: stored grants narrowed by any presented token.
    pub permissions: Permissions,
    pub runtime_instance_id: Option<String>,
    pub grant_jti: Option<String>,
    /// Set when the caller authenticated with a task-bound grant.
    pub task_scope: Option<String>,
    /// Set for requests that entered through the federation gateway on behalf of a peer domain.
    pub peer_domain: Option<String>,
}

impl Actor {
    pub fn actor_ref(&self) -> ActorRef {
        ActorRef { kind: self.kind, id: self.id.clone(), domain_id: self.domain_id.clone(), display_name: self.display_name.clone() }
    }

    pub fn kind_str(&self) -> &'static str {
        kind_str(self.kind)
    }

    /// `<kind>:<id>` label used by policy rules and audit.
    pub fn label(&self) -> String {
        format!("{}:{}", self.kind_str(), self.id)
    }

    pub fn is_admin(&self) -> bool {
        self.permissions.has_role("admin")
    }
}

pub fn kind_str(kind: ActorKind) -> &'static str {
    match kind {
        ActorKind::Agent => "agent",
        ActorKind::Human => "human",
        ActorKind::Service => "service",
        ActorKind::Domain => "domain",
    }
}

pub fn parse_kind(raw: &str) -> Option<ActorKind> {
    match raw {
        "agent" => Some(ActorKind::Agent),
        "human" => Some(ActorKind::Human),
        "service" => Some(ActorKind::Service),
        "domain" => Some(ActorKind::Domain),
        _ => None,
    }
}

/// Per-request context threaded through every domain operation.
#[derive(Debug, Clone)]
pub struct Ctx {
    pub actor: Actor,
    pub trace: TraceContext,
    pub idempotency_key: Option<String>,
    pub if_match: Option<u64>,
    pub transport: String,
    pub transport_event_id: Option<String>,
}

impl Ctx {
    pub fn new(actor: Actor) -> Self {
        Self { actor, trace: TraceContext::new_root(), idempotency_key: None, if_match: None, transport: "rest".into(), transport_event_id: None }
    }

    pub fn with_trace(mut self, trace: TraceContext) -> Self {
        self.trace = trace;
        self
    }

    pub fn with_idempotency(mut self, key: impl Into<String>) -> Self {
        self.idempotency_key = Some(key.into());
        self
    }

    pub fn with_transport(mut self, transport: impl Into<String>) -> Self {
        self.transport = transport.into();
        self
    }

    pub fn with_transport_event(mut self, id: impl Into<String>) -> Self {
        self.transport_event_id = Some(id.into());
        self
    }

    pub fn with_if_match(mut self, revision: u64) -> Self {
        self.if_match = Some(revision);
        self
    }
}

pub const SYSTEM_PRINCIPAL_ID: &str = "prn_system";

impl Domain {
    pub async fn open(cfg: DomainConfig) -> Result<Self, Error> {
        Self::open_with_clock(cfg, system_clock()).await
    }

    pub async fn open_with_clock(cfg: DomainConfig, clock: SharedClock) -> Result<Self, Error> {
        let db_existed = cfg.database_path.exists();
        let db = Db::open(
            &cfg.database_path,
            &DbOptions { max_connections: cfg.db_max_connections, synchronous_full: cfg.db_synchronous_full, busy_timeout: cfg.db_busy_timeout },
        )
        .await?;
        let master = Self::load_master_key(&cfg, db_existed)?;
        let domain = Domain {
            inner: Arc::new(Inner {
                db,
                cfg,
                clock,
                master,
                metrics: Metrics::new(),
                failpoints: Failpoints::from_env(),
                outbox_notify: Notify::new(),
                event_notify: Notify::new(),
                signing: RwLock::new(None),
                objects: RwLock::new(None),
            }),
        };
        domain.bootstrap().await?;
        Ok(domain)
    }

    fn load_master_key(cfg: &DomainConfig, db_existed: bool) -> Result<MasterKey, Error> {
        if let Some(raw) = &cfg.master_key {
            return MasterKey::from_b64(raw);
        }
        if let Ok(raw) = std::env::var("SOMEWORK_MASTER_KEY") {
            return MasterKey::from_b64(raw.trim());
        }
        let path = cfg.database_path.with_extension("masterkey");
        match std::fs::read_to_string(&path) {
            Ok(raw) => MasterKey::from_b64(raw.trim()),
            Err(_) if db_existed => Err(Error::internal(format!(
                "master key {} not found next to the existing database; restore the key file or set SOMEWORK_MASTER_KEY (a new key would make the stored signing keys unreadable)",
                path.display()
            ))),
            Err(_) => {
                let key = MasterKey::generate();
                std::fs::write(&path, key.to_b64()).map_err(|e| Error::internal(format!("write master key: {e}")))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
                }
                Ok(key)
            }
        }
    }

    async fn bootstrap(&self) -> Result<(), Error> {
        let now = ts(self.clock.now());
        let domain_id = self.cfg.domain_id.clone();
        let display = self.cfg.display_name.clone();
        let mut tx = self.db.begin_write().await?;
        sqlx::query("INSERT OR IGNORE INTO domains(domain_id, kind, display_name, status, config, created_at) VALUES (?, 'local', ?, 'active', '{}', ?)")
            .bind(&domain_id)
            .bind(&display)
            .bind(&now)
            .execute(&mut *tx)
            .await
            .db()?;
        let active: Option<String> = sqlx::query_scalar("SELECT kid FROM signing_keys WHERE domain_id = ? AND status = 'active' LIMIT 1")
            .bind(&domain_id)
            .fetch_optional(&mut *tx)
            .await
            .db()?;
        if active.is_none() {
            let key = new_signing_key();
            let kid = format!("{}-{}", domain_id, &ids::jti()[..8]);
            let sealed = self.master.seal(signing_key_to_b64(&key).as_bytes(), kid.as_bytes());
            sqlx::query("INSERT INTO signing_keys(kid, domain_id, public_key, private_key, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)")
                .bind(&kid)
                .bind(&domain_id)
                .bind(verifying_key_to_b64(&key.verifying_key()))
                .bind(sealed)
                .bind(&now)
                .execute(&mut *tx)
                .await
                .db()?;
        }
        let has_policy: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM policies WHERE domain_id = ? AND active = 1").bind(&domain_id).fetch_optional(&mut *tx).await.db()?;
        if has_policy.is_none() {
            let doc = PolicyDocument { catalog_auto_approve: self.cfg.catalog_auto_approve, audit_plaintext: self.cfg.audit_plaintext, ..Default::default() };
            sqlx::query("INSERT INTO policies(version, domain_id, document, active, created_by, created_at) VALUES (?, ?, ?, 1, 'system', ?)")
                .bind(&doc.version)
                .bind(&domain_id)
                .bind(serde_json::to_string(&doc)?)
                .bind(&now)
                .execute(&mut *tx)
                .await
                .db()?;
        }
        tx.commit().await.map_err(db_error)?;
        self.load_active_signing_key().await?;
        Ok(())
    }

    async fn load_active_signing_key(&self) -> Result<(), Error> {
        let row = sqlx::query("SELECT kid, private_key FROM signing_keys WHERE domain_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1")
            .bind(&self.cfg.domain_id)
            .fetch_one(self.db.pool())
            .await
            .db()?;
        let kid: String = row.get("kid");
        let sealed: String = row.get("private_key");
        let raw = self.master.open(&sealed, kid.as_bytes())?;
        let key = signing_key_from_b64(std::str::from_utf8(&raw).map_err(|_| Error::internal("signing key is not utf8"))?)?;
        *self.signing.write() = Some((kid, key));
        Ok(())
    }

    pub fn now(&self) -> chrono::DateTime<chrono::Utc> {
        self.clock.now()
    }

    pub fn now_ts(&self) -> String {
        ts(self.clock.now())
    }

    pub fn domain_id(&self) -> &str {
        &self.cfg.domain_id
    }

    /// Audience value that grants issued for this domain service carry.
    pub fn service_audience(&self) -> String {
        format!("somework:{}", self.cfg.domain_id)
    }

    pub fn active_signing_key(&self) -> Result<(String, ed25519_dalek::SigningKey), Error> {
        self.signing.read().clone().ok_or_else(|| Error::internal("no active signing key loaded"))
    }

    /// Rotates the domain signing key. Retired public keys stay in the table so old signatures remain verifiable.
    pub async fn rotate_signing_key(&self) -> Result<String, Error> {
        let now = self.now_ts();
        let key = new_signing_key();
        let kid = format!("{}-{}", self.cfg.domain_id, &ids::jti()[..8]);
        let sealed = self.master.seal(signing_key_to_b64(&key).as_bytes(), kid.as_bytes());
        let domain_id = self.cfg.domain_id.clone();
        let public = verifying_key_to_b64(&key.verifying_key());
        let kid2 = kid.clone();
        self.db
            .write(move |tx| {
                Box::pin(async move {
                    sqlx::query("UPDATE signing_keys SET status = 'retired', retired_at = ? WHERE domain_id = ? AND status = 'active'")
                        .bind(&now)
                        .bind(&domain_id)
                        .execute(&mut **tx)
                        .await
                        .db()?;
                    sqlx::query("INSERT INTO signing_keys(kid, domain_id, public_key, private_key, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)")
                        .bind(&kid2)
                        .bind(&domain_id)
                        .bind(public)
                        .bind(sealed)
                        .bind(&now)
                        .execute(&mut **tx)
                        .await
                        .db()?;
                    Ok(())
                })
            })
            .await?;
        self.load_active_signing_key().await?;
        Ok(kid)
    }

    pub async fn verifying_key(&self, kid: &str) -> Result<ed25519_dalek::VerifyingKey, Error> {
        let public: Option<String> = sqlx::query_scalar("SELECT public_key FROM signing_keys WHERE kid = ? AND domain_id = ?")
            .bind(kid)
            .bind(&self.cfg.domain_id)
            .fetch_optional(self.db.pool())
            .await
            .db()?;
        let public = public.ok_or_else(|| Error::unauthenticated("unknown signing key"))?;
        jws::verifying_key_from_b64(&public)
    }

    pub fn system_actor(&self) -> Actor {
        Actor {
            principal_id: SYSTEM_PRINCIPAL_ID.into(),
            kind: ActorKind::Service,
            id: "somework-system".into(),
            domain_id: self.cfg.domain_id.clone(),
            display_name: Some("SomeWork system".into()),
            permissions: Permissions::admin(),
            runtime_instance_id: None,
            grant_jti: None,
            task_scope: None,
            peer_domain: None,
        }
    }

    pub fn system_ctx(&self) -> Ctx {
        Ctx::new(self.system_actor()).with_transport("system")
    }

    pub async fn failpoint(&self, name: &str) -> Result<(), Error> {
        self.failpoints.hit(name).await
    }

    pub fn trace_id(ctx: &Ctx) -> String {
        ctx.trace.trace_id.clone()
    }

    // ---- policy ---------------------------------------------------------------------------------------------------

    pub async fn active_policy(&self, conn: &mut SqliteConnection) -> Result<PolicyDocument, Error> {
        let raw: Option<String> = sqlx::query_scalar("SELECT document FROM policies WHERE domain_id = ? AND active = 1")
            .bind(&self.cfg.domain_id)
            .fetch_optional(conn)
            .await
            .map_err(|e| Error::new(ErrorCode::PolicyUnavailable, format!("policy store unavailable: {e}")))?;
        match raw {
            Some(raw) => serde_json::from_str(&raw).map_err(|e| Error::new(ErrorCode::PolicyUnavailable, format!("active policy is unreadable: {e}"))),
            None => Err(Error::new(ErrorCode::PolicyUnavailable, "no active policy")),
        }
    }

    fn decide(&self, policy: &PolicyDocument, ctx: &Ctx, req: &AuthzRequest) -> Decision {
        let started = std::time::Instant::now();
        let (allow, reasons, obligations) = evaluate(policy, &ctx.actor.label(), &ctx.actor.permissions, req);
        self.metrics.policy_latency.observe(started.elapsed().as_secs_f64());
        if allow {
            self.metrics.policy_allow_count.inc();
        } else {
            self.metrics.policy_deny_count.inc();
        }
        Decision { decision_id: ids::decision_id(), allow, reasons, obligations, policy_version: policy.version.clone() }
    }

    fn denial(&self, decision: &Decision, req: &AuthzRequest) -> Error {
        Error::denied(decision.reasons.join("; ")).with_details(json!({
            "decision": decision,
            "action": req.action,
            "resource": req.resource,
            "taskId": req.task_id,
        }))
    }

    /// Authorize a mutation inside its transaction. Allow decisions are persisted atomically with the mutation;
    /// denials surface as `PolicyDenied` errors that [`Domain::run`] persists after the transaction rolls back.
    pub async fn enforce(&self, conn: &mut SqliteConnection, ctx: &Ctx, req: AuthzRequest) -> Result<Decision, Error> {
        let policy = self.active_policy(conn).await?;
        let decision = self.decide(&policy, ctx, &req);
        if !decision.allow {
            return Err(self.denial(&decision, &req));
        }
        self.persist_decision(conn, ctx, &req, &decision).await?;
        Ok(decision)
    }

    /// Authorize a read. Allowed reads are not persisted (no write amplification); denials still are.
    pub async fn enforce_read(&self, ctx: &Ctx, req: AuthzRequest) -> Result<Decision, Error> {
        let mut conn = self.db.pool().acquire().await.db()?;
        let policy = self.active_policy(&mut conn).await?;
        let decision = self.decide(&policy, ctx, &req);
        if !decision.allow {
            return Err(self.denial(&decision, &req));
        }
        Ok(decision)
    }

    pub async fn persist_decision(&self, conn: &mut SqliteConnection, ctx: &Ctx, req: &AuthzRequest, decision: &Decision) -> Result<(), Error> {
        sqlx::query(
            "INSERT INTO policy_decisions(decision_id, domain_id, occurred_at, actor_principal_id, actor, action, resource, decision, reasons, policy_version, task_id, trace_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&decision.decision_id)
        .bind(&self.cfg.domain_id)
        .bind(self.now_ts())
        .bind(&ctx.actor.principal_id)
        .bind(ctx.actor.label())
        .bind(&req.action)
        .bind(&req.resource)
        .bind(if decision.allow { "allow" } else { "deny" })
        .bind(serde_json::to_string(&decision.reasons)?)
        .bind(&decision.policy_version)
        .bind(&req.task_id)
        .bind(&ctx.trace.trace_id)
        .execute(conn)
        .await
        .db()?;
        Ok(())
    }

    /// Wraps a domain operation: records policy denials (decision, audit entry and a non-waking `policy.denied`
    /// event) after the operation's own transaction has rolled back, and tracks metrics.
    pub async fn run<T>(&self, ctx: &Ctx, op: &'static str, fut: impl std::future::Future<Output = Result<T, Error>>) -> Result<T, Error> {
        use tracing::Instrument;
        // Every operation is a span named after the spec's recommended span list (task.submit, message.send, ...),
        // carrying the W3C trace id so logs and traces can be joined across transports.
        let span = tracing::info_span!("somework.op", op, trace_id = %ctx.trace.trace_id, span_id = %ctx.trace.span_id, actor = %ctx.actor.label(), transport = %ctx.transport);
        let result = fut.instrument(span).await;
        if let Err(err) = &result
            && err.code == ErrorCode::PolicyDenied
            && let Err(record_err) = self.record_denial(ctx, op, err).await
        {
            tracing::warn!(error = %record_err, "failed to record policy denial");
        }
        result
    }

    async fn record_denial(&self, ctx: &Ctx, op: &str, err: &Error) -> Result<(), Error> {
        let Some(details) = &err.details else { return Ok(()) };
        let Ok(decision) = serde_json::from_value::<Decision>(details["decision"].clone()) else { return Ok(()) };
        let req = AuthzRequest {
            action: details["action"].as_str().unwrap_or(op).to_string(),
            resource: details["resource"].as_str().map(String::from),
            task_id: details["taskId"].as_str().map(String::from),
            ..Default::default()
        };
        let ctx = ctx.clone();
        let this = self.clone();
        let op = op.to_string();
        self.db
            .write(move |tx| {
                Box::pin(async move {
                    this.persist_decision(tx, &ctx, &req, &decision).await?;
                    this.audit(
                        tx,
                        &ctx,
                        crate::audit::AuditRecord::new(&op, req.resource.clone(), "denied")
                            .task(req.task_id.clone())
                            .decision(&decision)
                            .detail(json!({"reasons": decision.reasons})),
                    )
                    .await?;
                    this.emit_policy_denied(tx, &ctx, &decision, &req).await?;
                    Ok(())
                })
            })
            .await
    }

    /// Run `f` in a write transaction.
    pub async fn write<T, F>(&self, f: F) -> Result<T, Error>
    where
        T: Send,
        F: for<'t> FnOnce(&'t mut Tx) -> BoxFuture<'t, Result<T, Error>> + Send,
    {
        let out = self.db.write(f).await?;
        self.outbox_notify.notify_waiters();
        self.event_notify.notify_waiters();
        Ok(out)
    }

    pub fn inline_limit(&self) -> usize {
        self.cfg.inline_payload_limit_bytes
    }

    pub fn check_inline_size(&self, value: &Value, what: &str) -> Result<usize, Error> {
        let size = serde_json::to_vec(value)?.len();
        if size > self.inline_limit() {
            return Err(Error::new(
                ErrorCode::PayloadTooLarge,
                format!("{what} is {size} bytes; the inline limit is {} bytes. Store large content as an artifact and reference it.", self.inline_limit()),
            )
            .with_details(json!({"sizeBytes": size, "limitBytes": self.inline_limit()})));
        }
        Ok(size)
    }
}
