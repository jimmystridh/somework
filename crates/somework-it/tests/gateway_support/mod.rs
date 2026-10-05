#![allow(dead_code)]

use std::time::Duration;

use serde_json::{Value, json};
use somework_core::contracts::SideEffects;
use somework_domain::policy::Permissions;
use somework_testkit::{
    Agent, capability,
    federation::{Pair, PairOptions},
    process::eventually,
};

pub fn worker_perms(se: SideEffects) -> Permissions {
    let mut p = Permissions::default_agent();
    p.side_effects_at_most = Some(se);
    p
}

pub fn diagnose_capability() -> Value {
    capability("ops.diagnose", "1", "read", "Diagnose deployment failures from logs and metrics")
}

pub fn task_body(cap: &str) -> Value {
    json!({"capability": {"id": cap, "version": "1"}, "input": {"repository": "billing/import-service", "commit": "61a8d52"}})
}

/// operations exports `ops.diagnose` through a worker; development imports and approves it.
pub async fn standard_pair() -> (Pair, Agent) {
    let pair = Pair::start(PairOptions::default()).await;
    let diag = pair.exported_worker(&pair.ops, "agent/diagnostician", vec![diagnose_capability()], worker_perms(SideEffects::Read), &["ops.diagnose"]).await;
    pair.dev.admin.post("/v1/admin/federation/peers/operations/import-catalog", &json!({"approve": true})).await.expect("import catalog");
    (pair, diag)
}

/// Waits until the remote worker sees a queued task and returns its id.
pub async fn next_remote_task(worker: &Agent) -> String {
    eventually("a task to arrive at the remote worker", Duration::from_secs(15), || async {
        worker.client.next_tasks(1).await.ok().and_then(|t| t.first().and_then(|t| t["taskId"].as_str().map(String::from)))
    })
    .await
}

pub async fn run_worker_once(worker: &Agent, result: Value) -> String {
    let id = next_remote_task(worker).await;
    let claim = worker.client.claim_task(&id, Some(30)).await.expect("claim");
    worker.client.progress_task(&id, &json!({"fencingToken": claim.fencing_token, "message": "looking at logs"})).await.expect("progress");
    worker.client.complete_task(&id, claim.fencing_token, &result, &[]).await.expect("complete");
    id
}

use chrono::Duration as ChronoDuration;
use reqwest::{Method, StatusCode};
use somework_core::contracts::Action;
use somework_gateway::grants::{GrantRequest, mint_grant};
use somework_testkit::federation::DomainGateway;

/// A hand-rolled peer: `from` (development) calling the federation ingress of `to` (operations) with full control over
/// certificate, grant and replay, for negative testing.
pub struct RawPeer<'a> {
    pub pair: &'a Pair,
    pub http: reqwest::Client,
}

impl<'a> RawPeer<'a> {
    pub fn dev_to_ops(pair: &'a Pair) -> Self {
        Self::with_identity(pair, &pair.dev_gw)
    }

    pub fn with_identity(pair: &'a Pair, identity: &DomainGateway) -> Self {
        let http =
            somework_gateway::tls::peer_http_client(Some(&(identity.client.cert_pem.clone(), identity.client.key_pem.clone())), Some(&pair.ops_gw.ca.cert_pem))
                .expect("peer http client");
        Self { pair, http }
    }

    pub fn grant(&self, task_id: Option<&str>, actions: &[Action], caps: &[String], thumbprint: &str, ttl: ChronoDuration) -> String {
        mint_grant(
            self.pair.dev.domain(),
            GrantRequest { peer_domain_id: "operations", task_id, actions, capabilities: caps, presenter_thumbprint: Some(thumbprint), ttl },
        )
        .expect("mint grant")
    }

    pub async fn call(&self, method: Method, path: &str, body: Option<&Value>, grant: &str) -> Result<(StatusCode, Value), reqwest::Error> {
        let mut req = self.http.request(method, format!("{}{}", self.pair.ops_gw.url(), path)).bearer_auth(grant);
        if let Some(b) = body {
            req = req.json(b);
        }
        let resp = req.send().await?;
        let status = resp.status();
        Ok((status, resp.json().await.unwrap_or(Value::Null)))
    }

    /// One fully valid call: fresh grant bound to the dev gateway's own client certificate.
    pub async fn ok_call(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        actions: &[Action],
        task_id: Option<&str>,
        caps: &[String],
    ) -> (StatusCode, Value) {
        let grant = self.grant(task_id, actions, caps, &self.pair.dev_gw.client.thumbprint, ChronoDuration::seconds(60));
        self.call(method, path, body, &grant).await.expect("call")
    }
}

use somework_core::{
    contracts::{ApprovalStatus, Visibility},
    jws,
};
use somework_domain::catalog::ApproveEntry;
use somework_gateway::GatewayConfig;
use somework_testkit::{Stack, StackBuilder};

/// A stack with the A2A surface enabled (no federation listener) and a *public* exported `ops.diagnose` worker.
pub async fn a2a_stack(domain_id: &str) -> (Stack, Agent) {
    let id = domain_id.to_string();
    let stack = StackBuilder::new()
        .config(move |c| {
            c.domain.id = id;
            c.gateway = Some(GatewayConfig { egress_poll_ms: 80, ..Default::default() });
        })
        .start()
        .await;
    let worker = stack.worker("agent/diagnostician", vec![diagnose_capability()], worker_perms(SideEffects::Read)).await;
    stack
        .domain()
        .approve_entry(
            &stack.domain().system_ctx(),
            "agent/diagnostician",
            ApproveEntry {
                status: Some(ApprovalStatus::Approved),
                visibility: Some(Visibility::Public),
                exported_capabilities: Some(vec!["ops.diagnose".into()]),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    (stack, worker)
}

pub struct A2aClient {
    pub issuer: String,
    pub audience: String,
    pub key: ed25519_dalek::SigningKey,
}

impl A2aClient {
    pub async fn enrol(stack: &Stack, name: &str, exports: &[&str]) -> Self {
        let r = stack.admin.post("/v1/admin/federation/a2a/clients", &json!({"name": name, "exports": exports})).await.expect("create a2a client");
        Self {
            issuer: r["issuer"].as_str().unwrap().into(),
            audience: r["audience"].as_str().unwrap().into(),
            key: jws::signing_key_from_b64(r["privateKey"].as_str().unwrap()).unwrap(),
        }
    }

    pub fn token(&self) -> String {
        jws::mint_assertion(&self.key, &self.issuer, &self.audience, None, chrono::Utc::now(), ChronoDuration::minutes(4))
    }
}
