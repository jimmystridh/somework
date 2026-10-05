use std::{path::PathBuf, time::Duration};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatrixProfile {
    /// TLS in transit, private homeserver, no Matrix E2EE; full collaboration inspection.
    AuditableInternal,
    /// E2EE rooms with an authorized audit observer device; the platform emits metadata-only projections.
    EncryptedWithObserver,
    /// E2EE without a content observer; the domain retains task/audit metadata only.
    MetadataOnlyPrivate,
}

#[derive(Debug, Clone)]
pub struct DomainConfig {
    pub domain_id: String,
    pub display_name: String,
    pub database_path: PathBuf,
    pub db_max_connections: u32,
    pub db_synchronous_full: bool,
    pub db_busy_timeout: Duration,
    /// Base64url 32 byte key protecting signing keys at rest. Generated and stored next to the database when absent.
    pub master_key: Option<String>,
    pub public_url: String,
    pub inline_payload_limit_bytes: usize,
    pub max_artifact_bytes: u64,
    pub artifact_quota_bytes: u64,
    pub message_retention_days: i64,
    pub audit_retention_days: i64,
    pub default_lease_seconds: i64,
    pub max_lease_seconds: i64,
    pub max_task_attempts: u64,
    pub idempotency_ttl_hours: i64,
    pub runtime_ttl_seconds: i64,
    pub grant_ttl_seconds: i64,
    pub assertion_max_age_seconds: i64,
    pub download_grant_ttl_seconds: i64,
    pub upload_grant_ttl_seconds: i64,
    pub approval_ttl_seconds: i64,
    pub max_agent_hops: u32,
    pub matrix_profile: MatrixProfile,
    pub audit_plaintext: bool,
    /// Sinks for which the transactional outbox is populated.
    pub outbox_sinks: Vec<String>,
    pub catalog_auto_approve: bool,
    pub dev_allow_unauthenticated_admin: bool,
}

impl DomainConfig {
    pub fn new(domain_id: impl Into<String>, database_path: impl Into<PathBuf>) -> Self {
        let domain_id = domain_id.into();
        Self {
            display_name: domain_id.clone(),
            domain_id,
            database_path: database_path.into(),
            db_max_connections: 8,
            db_synchronous_full: true,
            db_busy_timeout: Duration::from_secs(15),
            master_key: None,
            public_url: "http://127.0.0.1:8080".into(),
            inline_payload_limit_bytes: 32 * 1024,
            max_artifact_bytes: 1024 * 1024 * 1024,
            artifact_quota_bytes: 10 * 1024 * 1024 * 1024 * 1024,
            message_retention_days: 90,
            audit_retention_days: 365,
            default_lease_seconds: 60,
            max_lease_seconds: 900,
            max_task_attempts: 5,
            idempotency_ttl_hours: 24,
            runtime_ttl_seconds: 45,
            grant_ttl_seconds: 900,
            assertion_max_age_seconds: 300,
            download_grant_ttl_seconds: 120,
            upload_grant_ttl_seconds: 900,
            approval_ttl_seconds: 3600,
            max_agent_hops: 16,
            matrix_profile: MatrixProfile::AuditableInternal,
            audit_plaintext: true,
            outbox_sinks: vec![],
            catalog_auto_approve: false,
            dev_allow_unauthenticated_admin: false,
        }
    }

    pub fn with_sinks(mut self, sinks: &[&str]) -> Self {
        self.outbox_sinks = sinks.iter().map(|s| s.to_string()).collect();
        self
    }

    pub fn sink_enabled(&self, sink: &str) -> bool {
        self.outbox_sinks.iter().any(|s| s == sink)
    }
}

pub const SINK_NATS: &str = "nats";
pub const SINK_MATRIX: &str = "matrix";
pub const SINK_GATEWAY: &str = "gateway";
