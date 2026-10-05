//! Server configuration (TOML).

use std::path::PathBuf;

use serde::Deserialize;
use somework_domain::{
    config::{DomainConfig, MatrixProfile},
    objects_s3::S3Config,
};

use crate::oidc::OidcProvider;

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct DomainSection {
    pub id: String,
    pub display_name: Option<String>,
    pub db: PathBuf,
    pub listen: String,
    pub public_url: String,
    pub master_key: Option<String>,
    pub catalog_auto_approve: bool,
    pub audit_plaintext: bool,
    pub matrix_profile: MatrixProfile,
    pub lease_seconds: i64,
    pub max_lease_seconds: i64,
    pub max_task_attempts: u64,
    pub inline_payload_limit_bytes: usize,
    pub max_artifact_bytes: u64,
    pub maintenance_interval_ms: u64,
    pub synchronous_full: bool,
    pub upload_grant_ttl_seconds: i64,
    pub download_grant_ttl_seconds: i64,
    pub artifact_quota_bytes: u64,
    /// 0 disables scheduled backups.
    pub backup_interval_seconds: u64,
    pub backup_dir: Option<PathBuf>,
    /// Number of scheduled backups to keep.
    pub backup_keep: usize,
    /// Copy the master key file into scheduled backups (convenient for single-node setups, discouraged in production).
    pub backup_include_master_key: bool,
}

impl Default for DomainSection {
    fn default() -> Self {
        Self {
            id: "development".into(),
            display_name: None,
            db: "data/somework.db".into(),
            listen: "127.0.0.1:8080".into(),
            public_url: "http://127.0.0.1:8080".into(),
            master_key: None,
            catalog_auto_approve: false,
            audit_plaintext: true,
            matrix_profile: MatrixProfile::AuditableInternal,
            lease_seconds: 60,
            max_lease_seconds: 900,
            max_task_attempts: 5,
            inline_payload_limit_bytes: 32 * 1024,
            max_artifact_bytes: 1024 * 1024 * 1024,
            maintenance_interval_ms: 1000,
            synchronous_full: true,
            upload_grant_ttl_seconds: 900,
            download_grant_ttl_seconds: 120,
            artifact_quota_bytes: 10 * 1024 * 1024 * 1024 * 1024,
            backup_interval_seconds: 0,
            backup_dir: None,
            backup_keep: 7,
            backup_include_master_key: false,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct ObjectsSection {
    /// `fs` (default) or `s3`.
    pub kind: Option<String>,
    pub dir: Option<PathBuf>,
    pub s3: Option<S3Config>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct UiSection {
    pub dir: Option<PathBuf>,
    pub login: Option<crate::ui_session::UiLogin>,
    /// Dev-only: allow pasting a bearer token to start a session. Disabled by default.
    pub dev_token_login: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct ServerConfig {
    pub domain: DomainSection,
    pub objects: ObjectsSection,
    pub oidc: Vec<OidcProvider>,
    pub ui: UiSection,
    pub nats: Option<somework_nats::NatsConfig>,
    pub matrix: Option<somework_matrix::MatrixConfig>,
    pub gateway: Option<somework_gateway::GatewayConfig>,
    pub allow_failpoint_admin: bool,
    pub grpc: Option<crate::grpc::GrpcSection>,
}

impl ServerConfig {
    pub fn load(path: &std::path::Path) -> anyhow::Result<Self> {
        let raw = std::fs::read_to_string(path)?;
        Ok(toml::from_str(&raw)?)
    }

    pub fn domain_config(&self) -> DomainConfig {
        let d = &self.domain;
        let mut cfg = DomainConfig::new(d.id.clone(), d.db.clone());
        cfg.display_name = d.display_name.clone().unwrap_or_else(|| d.id.clone());
        cfg.public_url = d.public_url.clone();
        cfg.master_key = d.master_key.clone();
        cfg.catalog_auto_approve = d.catalog_auto_approve;
        cfg.audit_plaintext = d.audit_plaintext;
        cfg.matrix_profile = d.matrix_profile;
        cfg.default_lease_seconds = d.lease_seconds;
        cfg.max_lease_seconds = d.max_lease_seconds;
        cfg.max_task_attempts = d.max_task_attempts;
        cfg.inline_payload_limit_bytes = d.inline_payload_limit_bytes;
        cfg.max_artifact_bytes = d.max_artifact_bytes;
        cfg.db_synchronous_full = d.synchronous_full;
        cfg.upload_grant_ttl_seconds = d.upload_grant_ttl_seconds;
        cfg.download_grant_ttl_seconds = d.download_grant_ttl_seconds;
        cfg.artifact_quota_bytes = d.artifact_quota_bytes;
        let mut sinks = vec![];
        if self.nats.is_some() {
            sinks.push(somework_domain::config::SINK_NATS.to_string());
        }
        if self.matrix.is_some() {
            sinks.push(somework_domain::config::SINK_MATRIX.to_string());
        }
        if self.gateway.is_some() {
            sinks.push(somework_domain::config::SINK_GATEWAY.to_string());
        }
        cfg.outbox_sinks = sinks;
        cfg
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pilot_domain_example_is_a_valid_config() {
        let cfg: ServerConfig = toml::from_str(include_str!("../../../deploy/vm105/somework.toml.example")).expect("deploy/vm105/somework.toml.example parses");
        let nats = cfg.nats.expect("the pilot config enables NATS");
        assert!(nats.tls_required && nats.tls_ca_file.is_some() && nats.users_file.is_some());
        assert!(nats.reload_command.is_none(), "the pilot compose reloads the broker with the nats-reloader service, not from the domain");
        assert_eq!(nats.client_url.as_deref(), Some("tls://nats.internal:4222"));
        assert!(cfg.ui.dev_token_login.eq(&false), "the pilot example never enables the development token login");
    }
}
