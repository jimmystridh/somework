//! Two-domain harness: two complete stacks (separate SQLite databases) whose gateways trust each other over real mTLS.

use serde_json::{Value, json};
use somework_core::contracts::{ApprovalStatus, Visibility};
use somework_domain::{catalog::ApproveEntry, policy::Permissions};
use somework_gateway::{GatewayConfig, PeerPolicy};

use crate::{
    pki::{Ca, Identity},
    process::free_port,
    stack::{Agent, Stack, StackBuilder},
};

pub struct DomainGateway {
    pub port: u16,
    pub ca: Ca,
    pub server: Identity,
    pub client: Identity,
}

impl DomainGateway {
    pub fn new(name: &str) -> Self {
        let ca = Ca::new(&format!("{name} gateway CA"));
        let server = ca.leaf(&format!("{name} gateway"));
        let client = ca.leaf(&format!("{name} egress"));
        Self { port: free_port(), ca, server, client }
    }

    pub fn url(&self) -> String {
        format!("https://127.0.0.1:{}", self.port)
    }

    pub fn config(&self) -> GatewayConfig {
        GatewayConfig {
            listen: Some(format!("127.0.0.1:{}", self.port)),
            server_cert_pem: Some(self.server.cert_pem.clone()),
            server_key_pem: Some(self.server.key_pem.clone()),
            client_cert_pem: Some(self.client.cert_pem.clone()),
            client_key_pem: Some(self.client.key_pem.clone()),
            egress_poll_ms: 80,
            ..Default::default()
        }
    }
}

pub struct Pair {
    pub dev: Stack,
    pub ops: Stack,
    pub dev_gw: DomainGateway,
    pub ops_gw: DomainGateway,
}

pub struct PairOptions {
    /// What `development` allows the `operations` peer (policy stored on development's peer record).
    pub dev_policy_for_ops: PeerPolicy,
    /// What `operations` allows the `development` peer.
    pub ops_policy_for_dev: PeerPolicy,
}

impl Default for PairOptions {
    fn default() -> Self {
        Self {
            dev_policy_for_ops: PeerPolicy { imports: vec!["ops.*".into()], ..Default::default() },
            ops_policy_for_dev: PeerPolicy { exports: vec!["ops.diagnose".into()], ..Default::default() },
        }
    }
}

impl Pair {
    pub async fn start(opts: PairOptions) -> Pair {
        let dev_gw = DomainGateway::new("development");
        let ops_gw = DomainGateway::new("operations");
        let dev = StackBuilder::new()
            .config(|c| {
                c.domain.id = "development".into();
                c.gateway = Some(dev_gw.config());
            })
            .start()
            .await;
        let ops = StackBuilder::new()
            .config(|c| {
                c.domain.id = "operations".into();
                c.gateway = Some(ops_gw.config());
            })
            .start()
            .await;
        let pair = Pair { dev, ops, dev_gw, ops_gw };
        pair.connect("development", "operations", &opts.dev_policy_for_ops).await;
        pair.connect("operations", "development", &opts.ops_policy_for_dev).await;
        pair
    }

    pub fn stack(&self, domain: &str) -> &Stack {
        if domain == "development" { &self.dev } else { &self.ops }
    }

    fn gw(&self, domain: &str) -> &DomainGateway {
        if domain == "development" { &self.dev_gw } else { &self.ops_gw }
    }

    /// Registers `remote` as a peer of `local` (pinned cert, CA, signing key, policy).
    pub async fn connect(&self, local: &str, remote: &str, policy: &PeerPolicy) -> Value {
        let identity = self.stack(remote).admin.get("/v1/admin/federation/identity").await.expect("remote identity");
        let key = identity["signingKeys"].as_array().and_then(|k| k.iter().find(|k| k["status"] == "active")).expect("active signing key").clone();
        let body = json!({
            "peerDomainId": remote,
            "displayName": remote,
            "gatewayUrl": self.gw(remote).url(),
            "trustTier": "partner",
            "clientCertThumbprints": [self.gw(remote).client.thumbprint],
            "serverCaPem": self.gw(remote).ca.cert_pem,
            "signingKeys": [key],
            "policy": policy,
        });
        self.stack(local).admin.post("/v1/admin/federation/peers", &body).await.expect("add peer")
    }

    /// Enrols a worker in `operations`, exports `capability` to peers and returns the worker.
    pub async fn exported_worker(&self, stack: &Stack, id: &str, caps: Vec<Value>, perms: Permissions, exported: &[&str]) -> Agent {
        let agent = stack.worker(id, caps, perms).await;
        stack
            .domain()
            .approve_entry(
                &stack.domain().system_ctx(),
                id,
                ApproveEntry {
                    status: Some(ApprovalStatus::Approved),
                    visibility: Some(Visibility::Exported),
                    exported_capabilities: Some(exported.iter().map(|s| s.to_string()).collect()),
                    ..Default::default()
                },
            )
            .await
            .expect("export entry");
        agent
    }

    pub async fn stop(self) {
        self.dev.stop().await;
        self.ops.stop().await;
    }
}
