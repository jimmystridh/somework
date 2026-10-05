use std::sync::Arc;

use ed25519_dalek::SigningKey;
use serde_json::{Value, json};
use somework_api::{config::ServerConfig, runner};
use somework_client::Client;
use somework_core::{
    contracts::{ActorKind, ApprovalStatus},
    ids, jws,
};
use somework_domain::{Domain, auth::CreatePrincipal, catalog::ApproveEntry, policy::Permissions};
use tempfile::TempDir;

pub fn card(agent_id: &str, domain_id: &str, caps: Vec<Value>) -> Value {
    json!({
        "schemaVersion": "1.0",
        "agentId": agent_id,
        "domainId": domain_id,
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

pub struct StackBuilder {
    cfg: ServerConfig,
    dir: TempDir,
}

pub struct Stack {
    pub runtime: runner::Runtime,
    pub dir: TempDir,
    pub url: String,
    pub domain_id: String,
    pub admin_key: Arc<SigningKey>,
    pub admin: Client,
}

#[derive(Clone)]
pub struct Agent {
    pub id: String,
    pub key: Arc<SigningKey>,
    pub client: Client,
    pub base: String,
    pub domain_id: String,
}

#[derive(Clone)]
pub struct Human {
    pub id: String,
    pub key: Arc<SigningKey>,
    pub client: Client,
}

impl Agent {
    /// A fresh process of the same logical agent (new runtimeInstanceId), already registered with the domain.
    pub async fn new_runtime(&self) -> Agent {
        let rt = ids::runtime_instance_id();
        let client = Client::assertion(&self.base, (*self.key).clone(), "agent", &self.id, &self.domain_id).with_runtime(rt);
        client.register_runtime(json!({"test": true})).await.expect("register runtime");
        Agent { client, ..self.clone() }
    }
}

impl StackBuilder {
    pub fn new() -> Self {
        let dir = TempDir::new().expect("tempdir");
        let mut cfg = ServerConfig::default();
        cfg.domain.id = "development".into();
        cfg.domain.db = dir.path().join("somework.db");
        cfg.domain.listen = "127.0.0.1:0".into();
        cfg.domain.public_url = "auto".into();
        cfg.domain.synchronous_full = false;
        cfg.domain.maintenance_interval_ms = 100;
        cfg.objects.dir = Some(dir.path().join("objects"));
        cfg.ui.dir = Some(crate::process::repo_root().join("ui"));
        Self { cfg, dir }
    }

    pub fn config(mut self, f: impl FnOnce(&mut ServerConfig)) -> Self {
        f(&mut self.cfg);
        self
    }

    pub fn dir(&self) -> &std::path::Path {
        self.dir.path()
    }

    /// Enables the NATS plane against a running [`crate::nats::NatsServer`].
    pub fn with_nats(self, nats: &crate::nats::NatsServer) -> Self {
        let cfg = nats.plane_config();
        self.config(|c| c.nats = Some(cfg))
    }

    pub async fn start(self) -> Stack {
        let domain_id = self.cfg.domain.id.clone();
        let domain = Domain::open(self.cfg.domain_config()).await.expect("open domain");
        let key = jws::new_signing_key();
        domain.bootstrap_admin("root", &jws::verifying_key_to_b64(&key.verifying_key())).await.expect("bootstrap admin");
        let runtime = runner::start_with_domain(domain, self.cfg).await.expect("start server");
        let url = runtime.url();
        let admin = Client::assertion(&url, key.clone(), "service", "root", &domain_id);
        Stack { runtime, dir: self.dir, url, domain_id, admin_key: Arc::new(key), admin }
    }
}

impl Default for StackBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl Stack {
    pub async fn start() -> Stack {
        StackBuilder::new().start().await
    }

    pub fn domain(&self) -> &Domain {
        &self.runtime.domain
    }

    pub async fn create_principal(&self, kind: ActorKind, id: &str, permissions: Permissions) -> Arc<SigningKey> {
        let key = jws::new_signing_key();
        self.domain()
            .create_principal(
                &self.domain().system_ctx(),
                CreatePrincipal {
                    kind,
                    id: id.into(),
                    display_name: Some(id.into()),
                    permissions: Some(permissions),
                    public_key: Some(jws::verifying_key_to_b64(&key.verifying_key())),
                    matrix_user_id: None,
                    oidc_issuer: None,
                    oidc_subject: None,
                },
            )
            .await
            .expect("create principal");
        Arc::new(key)
    }

    /// An enrolled agent without a catalog entry (a pure requester).
    pub async fn requester(&self, id: &str, caps: &[&str], side_effects: somework_core::contracts::SideEffects) -> Agent {
        let mut perms = Permissions::default_agent();
        perms.capabilities = caps.iter().map(|c| c.to_string()).collect();
        perms.side_effects_at_most = Some(side_effects);
        let key = self.create_principal(ActorKind::Agent, id, perms).await;
        let client = Client::assertion(&self.url, (*key).clone(), "agent", id, &self.domain_id).with_runtime(ids::runtime_instance_id());
        client.register_runtime(json!({})).await.ok(); // requesters without a card cannot register runtimes; that is fine
        Agent { id: id.into(), key, client, base: self.url.clone(), domain_id: self.domain_id.clone() }
    }

    /// Enrols a worker agent, registers its card, has an administrator approve it and registers a runtime.
    pub async fn worker(&self, id: &str, caps: Vec<Value>, perms: Permissions) -> Agent {
        let key = self.create_principal(ActorKind::Agent, id, perms).await;
        let bootstrap = Client::assertion(&self.url, (*key).clone(), "agent", id, &self.domain_id);
        let entry = bootstrap.register_agent(&card(id, &self.domain_id, caps)).await.expect("register card");
        let entry_id = entry["entryId"].as_str().expect("entry id").to_string();
        self.domain()
            .approve_entry(&self.domain().system_ctx(), &entry_id, ApproveEntry { status: Some(ApprovalStatus::Approved), ..Default::default() })
            .await
            .expect("approve entry");
        let agent = Agent { id: id.into(), key, client: bootstrap, base: self.url.clone(), domain_id: self.domain_id.clone() };
        agent.new_runtime().await
    }

    pub async fn human(&self, id: &str, perms: Permissions) -> Human {
        let key = self.create_principal(ActorKind::Human, id, perms).await;
        let client = Client::assertion(&self.url, (*key).clone(), "human", id, &self.domain_id);
        Human { id: id.into(), key, client }
    }

    pub async fn stop(self) {
        self.runtime.stop().await;
    }
}

#[allow(dead_code)]
fn _unused(_: anyhow::Error) {}
