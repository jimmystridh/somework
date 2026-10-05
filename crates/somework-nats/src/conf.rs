//! nats-server configuration generator: one NATS *account* per trust domain (structural subject isolation) with a
//! system account, a domain-service admin user and one least-privilege user per agent.

use std::path::{Path, PathBuf};

use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};
use somework_core::{ids::subject_token, subjects};

type HmacSha256 = Hmac<Sha256>;

/// Derives per-agent NATS credentials from the domain master key so they are stable across restarts.
#[derive(Clone)]
pub struct CredentialSecret([u8; 32]);

impl CredentialSecret {
    pub fn from_master_key(master_b64: &str) -> Self {
        Self(Sha256::digest(format!("somework-nats-creds:{master_b64}").as_bytes()).into())
    }

    pub fn password_for(&self, agent_id: &str) -> String {
        let mut mac = HmacSha256::new_from_slice(&self.0).expect("HMAC accepts any key length");
        mac.update(format!("agent:{agent_id}").as_bytes());
        hex::encode(mac.finalize().into_bytes())[..40].to_string()
    }
}

pub fn agent_user_name(agent_id: &str) -> String {
    format!("a_{}", subject_token(agent_id))
}

pub fn account_name(domain_id: &str) -> String {
    let cleaned: String = domain_id.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' }).collect();
    format!("DOMAIN_{cleaned}")
}

#[derive(Debug, Clone)]
pub struct AgentGrant {
    pub agent_id: String,
    pub pools: Vec<String>,
}

fn pull_subjects(stream: &str, consumer: &str) -> Vec<String> {
    vec![
        format!("$JS.API.CONSUMER.MSG.NEXT.{stream}.{consumer}"),
        format!("$JS.API.CONSUMER.INFO.{stream}.{consumer}"),
        format!("$JS.ACK.{stream}.{consumer}.>"),
    ]
}

/// Subjects an agent may publish to: pull/ack on its own consumers, ephemeral streaming and its own presence.
pub fn agent_publish_allow(grant: &AgentGrant) -> Vec<String> {
    let mut out = vec![
        format!("$JS.API.STREAM.INFO.{}", subjects::STREAM_INBOX),
        format!("$JS.API.STREAM.INFO.{}", subjects::STREAM_WORK),
        format!("$JS.API.STREAM.INFO.{}", subjects::STREAM_SUBSCRIPTIONS),
        "somework.stream.task.*.*".to_string(),
        subjects::presence(&grant.agent_id),
    ];
    out.extend(pull_subjects(subjects::STREAM_INBOX, &subjects::inbox_consumer(&grant.agent_id)));
    out.extend(pull_subjects(subjects::STREAM_SUBSCRIPTIONS, &subscription_consumer(&grant.agent_id)));
    for pool in &grant.pools {
        out.extend(pull_subjects(subjects::STREAM_WORK, &subjects::pool_consumer(pool)));
    }
    out
}

/// One durable consumer per agent on the subscriptions stream; its filter set follows the agent's subscriptions.
pub fn subscription_consumer(agent_id: &str) -> String {
    format!("subs_{}", subject_token(agent_id))
}

fn quoted(items: &[String]) -> String {
    items.iter().map(|s| format!("\"{s}\"")).collect::<Vec<_>>().join(", ")
}

pub struct NatsConfigGenerator {
    pub secret: CredentialSecret,
}

impl NatsConfigGenerator {
    pub fn new(secret: CredentialSecret) -> Self {
        Self { secret }
    }

    /// The `users = [...]` fragment for the domain account (included by [`server_conf`]).
    pub fn users_fragment(&self, admin_user: &str, admin_password: &str, grants: &[AgentGrant]) -> String {
        let mut out = String::from("users = [\n");
        out.push_str(&format!("  {{ user: \"{admin_user}\", password: \"{admin_password}\" }}\n"));
        for g in grants {
            out.push_str(&format!(
                "  {{ user: \"{}\", password: \"{}\", permissions: {{ publish: {{ allow: [{}] }}, subscribe: {{ allow: [\"_INBOX.>\"] }} }} }}\n",
                agent_user_name(&g.agent_id),
                self.secret.password_for(&g.agent_id),
                quoted(&agent_publish_allow(g))
            ));
        }
        out.push_str("]\n");
        out
    }
}

/// Server certificate and key for client connections (agents, workers and the domain). Clients verify the certificate
/// against their own configured CA; the broker does not ask for client certificates (clients authenticate with
/// per-principal credentials).
pub struct ServerTls {
    pub cert_file: PathBuf,
    pub key_file: PathBuf,
}

pub struct ServerConfSpec {
    pub server_name: String,
    /// Interface to listen on; `127.0.0.1` for a broker that only the local domain talks to.
    pub host: String,
    pub tls: Option<ServerTls>,
    /// Upper bounds for JetStream storage (nats size syntax, e.g. `5GB`). Unset means the server default (unbounded
    /// file store), which a pilot should not run with.
    pub max_file_store: Option<String>,
    pub max_memory_store: Option<String>,
    pub port: u16,
    pub store_dir: PathBuf,
    pub domain_id: String,
    pub users_file: PathBuf,
    pub pid_file: Option<PathBuf>,
    pub system_user: String,
    pub system_password: String,
}

/// Main nats-server.conf: system account, the domain account (JetStream enabled) and the users include.
pub fn server_conf(spec: &ServerConfSpec) -> String {
    let account = account_name(&spec.domain_id);
    // nats-server resolves include paths relative to the main config file, so both live in one directory
    let users_include = spec.users_file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut out = format!("server_name: \"{}\"\nhost: \"{}\"\nport: {}\n", spec.server_name, spec.host, spec.port);
    if let Some(pid) = &spec.pid_file {
        out.push_str(&format!("pid_file: \"{}\"\n", pid.display()));
    }
    let mut jetstream = format!("store_dir: \"{}\"", spec.store_dir.display());
    if let Some(limit) = &spec.max_file_store {
        jetstream.push_str(&format!(", max_file_store: {limit}"));
    }
    if let Some(limit) = &spec.max_memory_store {
        jetstream.push_str(&format!(", max_memory_store: {limit}"));
    }
    out.push_str(&format!("jetstream {{ {jetstream} }}\n"));
    if let Some(tls) = &spec.tls {
        out.push_str(&format!("tls {{\n  cert_file: \"{}\"\n  key_file: \"{}\"\n  timeout: 3\n}}\n", tls.cert_file.display(), tls.key_file.display()));
    }
    out.push_str(&format!(
        "accounts {{\n  SYS {{ users = [ {{ user: \"{}\", password: \"{}\" }} ] }}\n  {account} {{\n    jetstream: enabled\n    include \"{users_include}\"\n  }}\n}}\nsystem_account: SYS\n",
        spec.system_user, spec.system_password
    ));
    out
}

pub fn write_private(path: &Path, content: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, content)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passwords_are_stable_and_per_agent() {
        let s = CredentialSecret::from_master_key("k");
        assert_eq!(s.password_for("agent/a"), s.password_for("agent/a"));
        assert_ne!(s.password_for("agent/a"), s.password_for("agent/b"));
        assert_ne!(CredentialSecret::from_master_key("other").password_for("agent/a"), s.password_for("agent/a"));
    }

    #[test]
    fn agent_cannot_publish_to_work_inbox_or_events() {
        let allow = agent_publish_allow(&AgentGrant { agent_id: "agent/a".into(), pools: vec!["agent/a".into()] });
        assert!(allow.iter().all(|s| !s.starts_with("somework.work") && !s.starts_with("somework.inbox") && !s.starts_with("somework.event")));
        assert!(allow.iter().any(|s| s.contains("CONSUMER.MSG.NEXT.SOMEWORK_INBOX.inbox_agent")));
    }
}
