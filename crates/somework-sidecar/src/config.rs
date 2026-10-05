use std::{collections::BTreeMap, path::PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AdapterConfig {
    /// Spawn `command` per task; task document on stdin, JSON-lines protocol on stdout. The child starts with an empty
    /// environment plus [`DEFAULT_CHILD_ENV`], the variables named in `env_allow`, and the explicit `env` values.
    Exec {
        command: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
        #[serde(default)]
        env_allow: Vec<String>,
    },
    /// POST the task document to a local agent endpoint; the response body is the result document.
    Http { url: String },
    /// No agent attached: the sidecar only serves MCP.
    #[default]
    None,
}

/// Variables an executor inherits from the sidecar unless the configuration names more. Nothing else (in particular no
/// credential or sidecar setting) crosses into the child.
pub const DEFAULT_CHILD_ENV: &[&str] = &["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR"];

/// Transport security for the connections the sidecar opens itself (domain HTTPS API and NATS).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(default)]
pub struct TlsConfig {
    /// Refuse plaintext: the domain URL must be https and NATS must negotiate TLS.
    pub required: bool,
    /// PEM bundle of the private CA that signs the domain and NATS server certificates. When set, only this CA is trusted.
    pub ca_file: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum WakeMode {
    /// NATS when `GET /v1/connection` offers it (with periodic HTTP reconciliation), otherwise polling.
    #[default]
    Auto,
    /// HTTP held long-poll only. The rollback mode when NATS is not wanted.
    Poll,
    /// Like `Auto`, but the worker refuses to start without NATS.
    Nats,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct WorkerConfig {
    pub adapter: AdapterConfig,
    pub wake: WakeMode,
    pub lease_seconds: i64,
    pub concurrency: usize,
    pub poll_wait_seconds: u64,
    /// While NATS is the wake transport, queued tasks are also looked up over HTTP this often, so a lost or delayed
    /// notification can only add latency, never strand work.
    pub reconcile_seconds: u64,
    /// Applied to the NATS connection (the sidecar copies the top-level `tls` section here).
    pub tls: TlsConfig,
    /// Fraction of the lease after which it is extended (heartbeat interval = lease * ratio).
    pub heartbeat_ratio: f64,
    pub runtime_heartbeat_seconds: u64,
    pub progress_throttle_ms: u64,
    /// Capabilities this worker is willing to run (empty = whatever the domain routes to it).
    pub max_stderr_notices: usize,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            adapter: AdapterConfig::None,
            wake: WakeMode::Auto,
            lease_seconds: 30,
            concurrency: 4,
            poll_wait_seconds: 5,
            reconcile_seconds: 25,
            tls: TlsConfig::default(),
            heartbeat_ratio: 0.33,
            runtime_heartbeat_seconds: 10,
            progress_throttle_ms: 250,
            max_stderr_notices: 50,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    /// MCP over stdio only.
    #[default]
    Mcp,
    /// MCP over localhost streamable HTTP only.
    McpHttp,
    Worker,
    /// Worker plus MCP over stdio.
    Both,
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
    pub worker: WorkerConfig,
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
            worker: WorkerConfig::default(),
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
    fn the_pilot_worker_example_is_a_valid_config() {
        let cfg: SidecarConfig = toml::from_str(include_str!("../../../deploy/vm102/worker.toml.example")).expect("deploy/vm102/worker.toml.example parses");
        assert_eq!(cfg.mode, Mode::Worker);
        assert!(cfg.tls.required && cfg.tls.ca_file.is_some());
        assert_eq!((cfg.worker.wake, cfg.worker.concurrency, cfg.worker.reconcile_seconds), (WakeMode::Nats, 1, 25));
        assert!(matches!(cfg.worker.adapter, AdapterConfig::Exec { ref command, .. } if command == &["/opt/executors/run"]));
    }
}
