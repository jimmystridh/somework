use std::path::PathBuf;

use serde::Deserialize;

fn default_true() -> bool {
    true
}
fn default_replicas() -> usize {
    1
}
fn default_work_days() -> u64 {
    7
}
fn default_long_days() -> u64 {
    30
}
fn default_dedupe_secs() -> u64 {
    300
}
fn default_ack_wait_secs() -> u64 {
    30
}
fn default_max_deliver() -> i64 {
    20
}
fn default_reconcile_ms() -> u64 {
    500
}
fn default_metrics_ms() -> u64 {
    2000
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct NatsConfig {
    /// URL the domain service connects to.
    pub url: String,
    /// URL handed to agents (defaults to `url`); useful when agents reach NATS through another address.
    pub client_url: Option<String>,
    pub user: Option<String>,
    pub password: Option<String>,
    pub creds_file: Option<PathBuf>,
    /// Create/update streams and consumers (disable when an operator manages JetStream).
    pub provision: bool,
    pub replicas: usize,
    pub work_max_age_days: u64,
    pub inbox_max_age_days: u64,
    pub events_max_age_days: u64,
    pub subscriptions_max_age_days: u64,
    pub dedupe_window_secs: u64,
    pub ack_wait_secs: u64,
    pub max_deliver: i64,
    pub reconcile_interval_ms: u64,
    pub metrics_interval_ms: u64,
    pub tls_ca_file: Option<PathBuf>,
    pub tls_required: bool,
    /// File the plane (re)writes with the per-agent `users = [...]` fragment included by nats-server.conf.
    pub users_file: Option<PathBuf>,
    /// Command run after `users_file` changed, e.g. `["sh","-c","kill -HUP $(cat nats.pid)"]`.
    pub reload_command: Option<Vec<String>>,
    /// Subscribe to `somework.presence.>` and refresh runtime liveness from it.
    #[serde(default = "default_true")]
    pub presence: bool,
}

impl Default for NatsConfig {
    fn default() -> Self {
        Self {
            url: "nats://127.0.0.1:4222".into(),
            client_url: None,
            user: None,
            password: None,
            creds_file: None,
            provision: true,
            replicas: default_replicas(),
            work_max_age_days: default_work_days(),
            inbox_max_age_days: default_long_days(),
            events_max_age_days: default_long_days(),
            subscriptions_max_age_days: default_long_days(),
            dedupe_window_secs: default_dedupe_secs(),
            ack_wait_secs: default_ack_wait_secs(),
            max_deliver: default_max_deliver(),
            reconcile_interval_ms: default_reconcile_ms(),
            metrics_interval_ms: default_metrics_ms(),
            tls_ca_file: None,
            tls_required: false,
            users_file: None,
            reload_command: None,
            presence: true,
        }
    }
}

impl NatsConfig {
    pub fn agent_url(&self) -> &str {
        self.client_url.as_deref().unwrap_or(&self.url)
    }
}
