#![allow(dead_code)]

use std::sync::Arc;

use chrono::{Duration, TimeZone, Utc};
use ed25519_dalek::SigningKey;
use serde_json::{Value, json};
use somework_core::{
    clock::ManualClock,
    contracts::{Action, ActorKind, SideEffects},
    jws,
};
use somework_domain::{
    Ctx, Domain,
    auth::{AuthMeta, CreatePrincipal},
    config::DomainConfig,
    objects::FsObjectStore,
    policy::Permissions,
};
use tempfile::TempDir;

pub struct Env {
    pub domain: Domain,
    pub clock: ManualClock,
    pub dir: TempDir,
    pub admin: Principal,
    pub fs: FsObjectStore,
}

#[derive(Clone)]
pub struct Principal {
    pub kind: ActorKind,
    pub id: String,
    pub key: Arc<SigningKey>,
    pub runtime: Option<String>,
}

impl Principal {
    pub fn issuer(&self) -> String {
        format!("{}:{}", somework_domain::domain::kind_str(self.kind), self.id)
    }
}

pub fn card(agent_id: &str, caps: Vec<Value>) -> Value {
    json!({
        "schemaVersion": "1.0",
        "agentId": agent_id,
        "domainId": "development",
        "displayName": agent_id.rsplit('/').next().unwrap_or(agent_id),
        "description": format!("Agent {agent_id}"),
        "owner": {"team": "platform"},
        "capabilities": caps,
        "interfaces": [{"protocol": "somework"}]
    })
}

pub fn capability(id: &str, version: &str, side_effects: &str, description: &str) -> Value {
    json!({
        "id": id,
        "version": version,
        "name": id,
        "description": description,
        "tags": ["test"],
        "inputSchema": {"type": "object", "required": ["repository"], "properties": {"repository": {"type": "string"}, "commit": {"type": "string"}}},
        "outputSchema": {"type": "object", "required": ["verdict"], "properties": {"verdict": {"type": "string", "enum": ["approve", "reject"]}}},
        "sideEffects": side_effects
    })
}

pub fn worker_permissions(side_effects: SideEffects) -> Permissions {
    let mut p = Permissions::default_agent();
    p.side_effects_at_most = Some(side_effects);
    p.capabilities = vec![];
    p
}

pub fn caller_permissions(caps: &[&str], side_effects: SideEffects) -> Permissions {
    let mut p = Permissions::default_agent();
    p.capabilities = caps.iter().map(|c| c.to_string()).collect();
    p.side_effects_at_most = Some(side_effects);
    p
}

impl Env {
    pub async fn new() -> Self {
        Self::with_config(|_| {}).await
    }

    pub async fn with_config(tweak: impl FnOnce(&mut DomainConfig)) -> Self {
        let dir = TempDir::new().unwrap();
        let mut cfg = DomainConfig::new("development", dir.path().join("somework.db"));
        cfg.db_synchronous_full = false;
        tweak(&mut cfg);
        let clock = ManualClock::new(Utc.with_ymd_and_hms(2026, 10, 3, 12, 0, 0).unwrap());
        let domain = Domain::open_with_clock(cfg, Arc::new(clock.clone())).await.unwrap();
        let store = FsObjectStore::new(dir.path().join("objects"), "http://localhost:0", [7u8; 32], Arc::new(clock.clone())).unwrap();
        domain.set_object_store(Arc::new(store.clone()));
        let key = jws::new_signing_key();
        let admin_view = domain.bootstrap_admin("root", &jws::verifying_key_to_b64(&key.verifying_key())).await.unwrap();
        let admin = Principal { kind: ActorKind::Service, id: admin_view.id, key: Arc::new(key), runtime: None };
        Self { domain, clock, dir, admin, fs: store }
    }

    pub async fn ctx(&self, p: &Principal) -> Ctx {
        let assertion =
            jws::mint_assertion(&p.key, &p.issuer(), &self.domain.service_audience(), p.runtime.as_deref(), self.domain.now(), Duration::minutes(5));
        let actor = self.domain.authenticate(&assertion, &AuthMeta { transport: "test".into(), peer_cert_sha256: None }).await.expect("authenticate");
        Ctx::new(actor)
    }

    pub async fn try_ctx(&self, p: &Principal) -> Result<Ctx, somework_core::Error> {
        let assertion =
            jws::mint_assertion(&p.key, &p.issuer(), &self.domain.service_audience(), p.runtime.as_deref(), self.domain.now(), Duration::minutes(5));
        let actor = self.domain.authenticate(&assertion, &AuthMeta { transport: "test".into(), peer_cert_sha256: None }).await?;
        Ok(Ctx::new(actor))
    }

    pub async fn admin_ctx(&self) -> Ctx {
        self.ctx(&self.admin.clone()).await
    }

    pub async fn create_principal(&self, kind: ActorKind, id: &str, permissions: Option<Permissions>) -> Principal {
        let key = jws::new_signing_key();
        let admin = self.admin_ctx().await;
        self.domain
            .create_principal(
                &admin,
                CreatePrincipal {
                    kind,
                    id: id.into(),
                    display_name: Some(id.into()),
                    permissions,
                    public_key: Some(jws::verifying_key_to_b64(&key.verifying_key())),
                    matrix_user_id: None,
                    oidc_issuer: None,
                    oidc_subject: None,
                },
            )
            .await
            .unwrap();
        Principal { kind, id: id.into(), key: Arc::new(key), runtime: None }
    }

    /// Enrols an agent, registers its card, approves it and registers a runtime instance.
    pub async fn worker(&self, agent_id: &str, caps: Vec<Value>, perms: Permissions) -> Principal {
        let mut p = self.create_principal(ActorKind::Agent, agent_id, Some(perms)).await;
        let ctx = self.ctx(&p).await;
        let entry =
            self.domain.register_agent(&ctx, somework_domain::catalog::RegisterAgent { card: card(agent_id, caps), ..Default::default() }).await.unwrap();
        self.domain
            .approve_entry(
                &self.admin_ctx().await,
                &entry.entry_id,
                somework_domain::catalog::ApproveEntry { status: Some(somework_core::contracts::ApprovalStatus::Approved), ..Default::default() },
            )
            .await
            .unwrap();
        p.runtime = Some(somework_core::ids::runtime_instance_id());
        let ctx = self.ctx(&p).await;
        self.domain.register_runtime(&ctx, Default::default()).await.unwrap();
        p
    }

    pub fn advance(&self, seconds: i64) {
        self.clock.advance(Duration::seconds(seconds));
    }

    pub async fn new_runtime(&self, p: &Principal) -> Principal {
        let mut q = p.clone();
        q.runtime = Some(somework_core::ids::runtime_instance_id());
        let ctx = self.ctx(&q).await;
        self.domain.register_runtime(&ctx, Default::default()).await.unwrap();
        q
    }
}

pub fn submit(cap: &str, version: &str) -> somework_domain::tasks::SubmitTask {
    somework_domain::tasks::SubmitTask {
        capability: Some(somework_core::contracts::CapabilityRef { id: cap.into(), version: version.into() }),
        input: Some(json!({"repository": "billing/import-service", "commit": "61a8d52"})),
        ..Default::default()
    }
}

pub fn _use_action(_: Action) {}

impl Env {
    /// Uploads `bytes` through the presigned grant flow and returns the verified ArtifactRef.
    pub async fn upload(&self, p: &Principal, name: &str, classification: &str, bytes: &[u8], task: Option<&str>) -> somework_core::contracts::ArtifactRef {
        use sha2::{Digest, Sha256};
        let ctx = self.ctx(p).await;
        let grant = self
            .domain
            .begin_artifact_upload(
                &ctx,
                somework_domain::artifacts::BeginUpload {
                    filename: Some(name.into()),
                    media_type: Some("application/octet-stream".into()),
                    size_bytes: Some(bytes.len() as u64),
                    sha256: Some(hex::encode(Sha256::digest(bytes))),
                    classification: Some(classification.into()),
                    source_task_id: task.map(String::from),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let token = grant.plan.url.rsplit("/v1/objects/").next().unwrap().to_string();
        self.fs.put_with_grant(&token, bytes.to_vec()).await.unwrap();
        self.domain.complete_artifact_upload(&ctx, &grant.artifact_id, Default::default()).await.unwrap()
    }
}
