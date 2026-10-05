//! Outbound calls to a peer gateway: mTLS with our client identity plus a fresh single-use grant per request.

use std::{collections::HashMap, sync::Arc};

use chrono::Duration;
use parking_lot::Mutex;
use reqwest::{Method, StatusCode};
use serde_json::Value;
use somework_core::{Error, contracts::Action};
use somework_domain::Domain;

use crate::{
    config::GatewayConfig,
    grants::{GrantRequest, mint_grant},
    peers::{PeerRecord, Peers},
    tls::{peer_http_client, thumbprint_of_pem},
};

/// Full error chain of a transport failure (reqwest hides the TLS cause behind its top-level message).
pub fn error_chain(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut source = e.source();
    while let Some(s) = source {
        out.push_str(": ");
        out.push_str(&s.to_string());
        source = s.source();
    }
    out
}

#[derive(Debug)]
pub enum PeerCallError {
    /// Could not reach the peer (or it answered 5xx): the caller should retry later.
    Transient(String),
    /// The peer answered with a definite refusal.
    Refused {
        status: u16,
        body: Value,
    },
    Local(Error),
}

impl From<Error> for PeerCallError {
    fn from(e: Error) -> Self {
        PeerCallError::Local(e)
    }
}

impl std::fmt::Display for PeerCallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PeerCallError::Transient(m) => write!(f, "peer unreachable: {m}"),
            PeerCallError::Refused { status, body } => write!(f, "peer refused ({status}): {body}"),
            PeerCallError::Local(e) => write!(f, "{e}"),
        }
    }
}

#[derive(Clone)]
pub struct PeerClient {
    domain: Domain,
    peers: Peers,
    cfg: Arc<GatewayConfig>,
    identity: Option<(String, String)>,
    our_thumbprint: Option<String>,
    clients: Arc<Mutex<HashMap<String, (String, reqwest::Client)>>>,
}

impl PeerClient {
    pub fn new(domain: Domain, peers: Peers, cfg: Arc<GatewayConfig>) -> Result<Self, Error> {
        let identity = cfg.client_identity()?;
        let our_thumbprint = identity.as_ref().map(|(cert, _)| thumbprint_of_pem(cert)).transpose()?;
        Ok(Self { domain, peers, cfg, identity, our_thumbprint, clients: Default::default() })
    }

    pub fn peers(&self) -> &Peers {
        &self.peers
    }

    fn http(&self, peer: &PeerRecord) -> Result<reqwest::Client, Error> {
        let mut cache = self.clients.lock();
        if let Some((stamp, client)) = cache.get(&peer.peer_domain_id)
            && *stamp == peer.updated_at
        {
            return Ok(client.clone());
        }
        let client = peer_http_client(self.identity.as_ref(), peer.server_ca_pem.as_deref())?;
        cache.insert(peer.peer_domain_id.clone(), (peer.updated_at.clone(), client.clone()));
        Ok(client)
    }

    pub async fn call(
        &self,
        peer_id: &str,
        method: Method,
        path: &str,
        body: Option<&Value>,
        actions: &[Action],
        task_id: Option<&str>,
        capabilities: &[String],
    ) -> Result<(StatusCode, Value), PeerCallError> {
        let peer = self.peers.get(peer_id).await?.filter(PeerRecord::is_active).ok_or_else(|| PeerCallError::Local(Error::not_found("peer")))?;
        let base = peer.gateway_url.clone().ok_or_else(|| PeerCallError::Local(Error::invalid("peer has no gateway URL")))?;
        let grant = mint_grant(
            &self.domain,
            GrantRequest {
                peer_domain_id: peer_id,
                task_id,
                actions,
                capabilities,
                presenter_thumbprint: self.our_thumbprint.as_deref(),
                ttl: Duration::seconds(self.cfg.grant_ttl_seconds),
            },
        )?;
        let mut req = self
            .http(&peer)?
            .request(method, format!("{}{}", base.trim_end_matches('/'), path))
            .bearer_auth(grant)
            .header("traceparent", somework_core::trace::TraceContext::new_root().traceparent());
        if let Some(b) = body {
            req = req.json(b);
        }
        let resp = req.send().await.map_err(|e| PeerCallError::Transient(error_chain(&e)))?;
        let status = resp.status();
        let bytes = resp.bytes().await.map_err(|e| PeerCallError::Transient(error_chain(&e)))?;
        let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        if status.is_server_error() {
            return Err(PeerCallError::Transient(format!("peer answered {status}")));
        }
        if status.is_client_error() {
            return Err(PeerCallError::Refused { status: status.as_u16(), body: value });
        }
        Ok((status, value))
    }

    pub async fn call_bytes(&self, peer_id: &str, path: &str, task_id: &str) -> Result<Vec<u8>, PeerCallError> {
        let peer = self.peers.get(peer_id).await?.filter(PeerRecord::is_active).ok_or_else(|| PeerCallError::Local(Error::not_found("peer")))?;
        let base = peer.gateway_url.clone().ok_or_else(|| PeerCallError::Local(Error::invalid("peer has no gateway URL")))?;
        let grant = mint_grant(
            &self.domain,
            GrantRequest {
                peer_domain_id: peer_id,
                task_id: Some(task_id),
                actions: &[Action::ArtifactRead, Action::TaskRead],
                capabilities: &[],
                presenter_thumbprint: self.our_thumbprint.as_deref(),
                ttl: Duration::seconds(self.cfg.grant_ttl_seconds),
            },
        )?;
        let resp = self
            .http(&peer)?
            .get(format!("{}{}", base.trim_end_matches('/'), path))
            .bearer_auth(grant)
            .send()
            .await
            .map_err(|e| PeerCallError::Transient(error_chain(&e)))?;
        if !resp.status().is_success() {
            return Err(PeerCallError::Refused { status: resp.status().as_u16(), body: Value::Null });
        }
        Ok(resp.bytes().await.map_err(|e| PeerCallError::Transient(error_chain(&e)))?.to_vec())
    }

    pub fn our_thumbprint(&self) -> Option<&str> {
        self.our_thumbprint.as_deref()
    }
}
