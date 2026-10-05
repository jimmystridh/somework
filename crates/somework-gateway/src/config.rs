use std::path::PathBuf;

use serde::Deserialize;
use somework_core::Error;

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct A2aConfig {
    pub enabled: bool,
    /// Externally visible base URL of the A2A interface (defaults to the domain's public URL + `/a2a`).
    pub public_base_url: Option<String>,
    pub provider_organization: Option<String>,
    pub provider_url: Option<String>,
}

impl Default for A2aConfig {
    fn default() -> Self {
        Self { enabled: true, public_base_url: None, provider_organization: None, provider_url: None }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct GatewayConfig {
    /// Address of the mTLS federation listener (`host:port`); omit to run only the A2A surface.
    pub listen: Option<String>,
    pub server_cert_pem: Option<String>,
    pub server_cert_path: Option<PathBuf>,
    pub server_key_pem: Option<String>,
    pub server_key_path: Option<PathBuf>,
    /// Client identity presented to peer gateways when this domain calls out.
    pub client_cert_pem: Option<String>,
    pub client_cert_path: Option<PathBuf>,
    pub client_key_pem: Option<String>,
    pub client_key_path: Option<PathBuf>,
    pub egress_poll_ms: u64,
    pub egress_lease_seconds: i64,
    /// Lifetime of grants minted for peers; capped at five minutes.
    pub grant_ttl_seconds: i64,
    pub a2a: A2aConfig,
}

impl Default for GatewayConfig {
    fn default() -> Self {
        Self {
            listen: None,
            server_cert_pem: None,
            server_cert_path: None,
            server_key_pem: None,
            server_key_path: None,
            client_cert_pem: None,
            client_cert_path: None,
            client_key_pem: None,
            client_key_path: None,
            egress_poll_ms: 200,
            egress_lease_seconds: 30,
            grant_ttl_seconds: 120,
            a2a: A2aConfig::default(),
        }
    }
}

fn load(inline: &Option<String>, path: &Option<PathBuf>, what: &str) -> Result<Option<String>, Error> {
    match (inline, path) {
        (Some(v), _) => Ok(Some(v.clone())),
        (None, Some(p)) => std::fs::read_to_string(p).map(Some).map_err(|e| Error::invalid(format!("gateway {what}: {e}"))),
        (None, None) => Ok(None),
    }
}

impl GatewayConfig {
    pub fn server_identity(&self) -> Result<Option<(String, String)>, Error> {
        match (load(&self.server_cert_pem, &self.server_cert_path, "server certificate")?, load(&self.server_key_pem, &self.server_key_path, "server key")?) {
            (Some(c), Some(k)) => Ok(Some((c, k))),
            (None, None) => Ok(None),
            _ => Err(Error::invalid("gateway server certificate and key must be configured together")),
        }
    }

    pub fn client_identity(&self) -> Result<Option<(String, String)>, Error> {
        match (load(&self.client_cert_pem, &self.client_cert_path, "client certificate")?, load(&self.client_key_pem, &self.client_key_path, "client key")?) {
            (Some(c), Some(k)) => Ok(Some((c, k))),
            (None, None) => Ok(None),
            _ => Err(Error::invalid("gateway client certificate and key must be configured together")),
        }
    }

    pub fn grant_ttl(&self) -> chrono::Duration {
        chrono::Duration::seconds(self.grant_ttl_seconds.clamp(10, 300))
    }
}
