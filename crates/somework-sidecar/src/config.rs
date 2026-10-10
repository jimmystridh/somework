use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Transport security for the connections the sidecar opens itself (the domain HTTPS API).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(default)]
pub struct TlsConfig {
    /// Refuse plaintext: the domain URL must be https.
    pub required: bool,
    /// PEM bundle of the private CA that signs the domain server certificate. When set, only this CA is trusted.
    pub ca_file: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    /// MCP over stdio.
    #[default]
    Mcp,
    /// MCP over localhost streamable HTTP.
    McpHttp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SidecarConfig {
    pub domain_url: String,
    pub key_file: PathBuf,
    pub runtime_instance_id: Option<String>,
    pub mode: Mode,
    pub mcp_http_listen: String,
    pub tls: TlsConfig,
}

impl Default for SidecarConfig {
    fn default() -> Self {
        Self {
            domain_url: "http://127.0.0.1:8080".into(),
            key_file: "agent.key.json".into(),
            runtime_instance_id: None,
            mode: Mode::Mcp,
            mcp_http_listen: "127.0.0.1:0".into(),
            tls: TlsConfig::default(),
        }
    }
}

impl SidecarConfig {
    pub fn load(path: &std::path::Path) -> anyhow::Result<Self> {
        let raw = std::fs::read_to_string(path)?;
        if path.extension().is_some_and(|e| e == "json") { Ok(serde_json::from_str(&raw)?) } else { Ok(toml::from_str(&raw)?) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_config_file_sets_the_mode_and_the_tls_policy() {
        let cfg: SidecarConfig =
            toml::from_str("domain_url = \"https://somework.example\"\nmode = \"mcp-http\"\n[tls]\nrequired = true\nca_file = \"ca.pem\"\n").unwrap();
        assert_eq!(cfg.mode, Mode::McpHttp);
        assert!(cfg.tls.required && cfg.tls.ca_file.is_some());
        assert_eq!(SidecarConfig::default().mode, Mode::Mcp);
    }
}
