//! Operator CLI: bootstrap, enrolment, token minting and verification. These commands act on the database
//! directly: file-system access to the domain database is the trust anchor for the first administrator.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::json;
use somework_core::{
    contracts::{ActorKind, SideEffects},
    jws,
};
use somework_domain::{Domain, auth::CreatePrincipal, policy::Permissions};

use crate::config::ServerConfig;

#[derive(Parser)]
#[command(name = "somework", version, about = "SomeWork: agent collaboration platform")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand)]
pub enum Command {
    /// Run the domain service.
    Serve {
        #[arg(long, env = "SOMEWORK_CONFIG", default_value = "somework.toml")]
        config: PathBuf,
    },
    /// Administrative commands (operate directly on the database).
    Admin {
        #[arg(long, env = "SOMEWORK_CONFIG", default_value = "somework.toml")]
        config: PathBuf,
        #[command(subcommand)]
        command: AdminCommand,
    },
    /// Write a consistent online backup of the database, artifacts and key material.
    Backup {
        #[arg(long, env = "SOMEWORK_CONFIG", default_value = "somework.toml")]
        config: PathBuf,
        #[arg(long)]
        to: PathBuf,
    },
    /// Print the Matrix Application Service registration.yaml for the configured [matrix] section.
    MatrixRegistration {
        #[arg(long, env = "SOMEWORK_CONFIG", default_value = "somework.toml")]
        config: PathBuf,
    },
    /// Matrix end-to-end encryption key custody: export/import the crypto state as a passphrase-wrapped bundle,
    /// or verify it. The passphrase is read from SOMEWORK_CRYPTO_PASSPHRASE.
    MatrixCrypto {
        #[arg(long, env = "SOMEWORK_CONFIG", default_value = "somework.toml")]
        config: PathBuf,
        #[command(subcommand)]
        command: MatrixCryptoCommand,
    },
    /// Restore a backup into a clean directory and verify it.
    Restore {
        #[arg(long)]
        from: PathBuf,
        #[arg(long)]
        to: PathBuf,
    },
}

#[derive(Subcommand)]
pub enum MatrixCryptoCommand {
    /// Write an encrypted recovery bundle of all Olm/Megolm state.
    Export {
        #[arg(long)]
        out: PathBuf,
        /// PBKDF2-HMAC-SHA256 iterations used to derive the wrapping key.
        #[arg(long, default_value_t = 600_000)]
        iterations: u32,
    },
    /// Replace the crypto state with the contents of a recovery bundle (re-sealed with this deployment's master key).
    Import {
        #[arg(long)]
        from: PathBuf,
    },
    /// Open every sealed secret with the master key and decrypt the stored Megolm test vector.
    Verify,
}

#[derive(Subcommand)]
pub enum AdminCommand {
    /// Create (or re-key) the administrator service principal and write its key file.
    Bootstrap {
        #[arg(long, default_value = "root")]
        name: String,
        #[arg(long)]
        key_out: PathBuf,
    },
    /// Enrol an agent principal. Either generate its key here (`--key-out`) or register a public key that was generated
    /// on the worker host (`--public-key`, from `somework-sidecar keygen`) so the private key never travels.
    EnrollAgent {
        #[arg(long)]
        id: String,
        #[arg(long, default_value = "read")]
        side_effects: String,
        #[arg(long, default_value = "internal")]
        classification: String,
        /// Capability id patterns the agent may invoke as a requester.
        #[arg(long = "may-invoke")]
        may_invoke: Vec<String>,
        #[arg(long, conflicts_with = "public_key", required_unless_present = "public_key")]
        key_out: Option<PathBuf>,
        /// Base64 Ed25519 public key generated on the worker host.
        #[arg(long)]
        public_key: Option<String>,
    },
    /// Replace an agent's registered public key (rotation): stop the worker, run this, start it with the new key.
    /// The old key stops working immediately.
    RotateAgentKey {
        #[arg(long)]
        id: String,
        #[arg(long)]
        public_key: String,
    },
    /// Replace an agent's permissions (same fields and defaults as `enroll-agent`); use it to let an enrolled agent invoke
    /// more capabilities without re-enrolling it.
    SetAgentPermissions {
        #[arg(long)]
        id: String,
        #[arg(long, default_value = "read")]
        side_effects: String,
        #[arg(long, default_value = "internal")]
        classification: String,
        /// Capability id patterns the agent may invoke as a requester.
        #[arg(long = "may-invoke")]
        may_invoke: Vec<String>,
    },
    /// Disable or re-enable an agent. A disabled agent cannot authenticate: the kill switch for a lost key.
    SetAgentStatus {
        #[arg(long)]
        id: String,
        /// `active` or `disabled`
        #[arg(long)]
        status: String,
    },
    /// Enrol a human principal and map their identities explicitly.
    EnrollHuman {
        #[arg(long)]
        id: String,
        #[arg(long)]
        matrix_user: Option<String>,
        #[arg(long)]
        oidc_issuer: Option<String>,
        #[arg(long)]
        oidc_subject: Option<String>,
        /// `admin`, `auditor`, `operator` (repeatable).
        #[arg(long = "role")]
        roles: Vec<String>,
        #[arg(long = "approves")]
        approves: Vec<String>,
        #[arg(long, default_value = "internal")]
        classification: String,
    },
    /// Print a short-lived assertion for use with curl.
    Token {
        #[arg(long)]
        key: PathBuf,
        #[arg(long, default_value_t = 300)]
        ttl_seconds: i64,
    },
    /// Verify the audit hash chain.
    /// Register (or update) an agent's card from a JSON file and optionally approve it so it becomes discoverable.
    RegisterCard {
        /// AgentCard JSON (`schemaVersion`, `agentId`, `domainId`, `displayName`, `description`, `owner`, `capabilities`, `interfaces`).
        #[arg(long)]
        card: PathBuf,
        #[arg(long)]
        approve: bool,
    },
    VerifyAudit,
    /// Re-enqueue work-ready notifications for every queued task (after losing JetStream state).
    RepublishQueued,
    /// Render `nats-server.conf` (and an initial `users.conf`) for a deployed broker from the `[nats]` section of the
    /// server config. All paths are as the broker process sees them (inside its container).
    RenderNatsConf {
        #[arg(long)]
        out_dir: PathBuf,
        /// Interface the broker listens on.
        #[arg(long, default_value = "0.0.0.0")]
        host: String,
        #[arg(long, default_value_t = 4222)]
        port: u16,
        #[arg(long, default_value = "/data/jetstream")]
        store_dir: PathBuf,
        #[arg(long, default_value = "/etc/nats/nats.pid")]
        pid_file: PathBuf,
        /// Server certificate and key; without them the broker speaks plaintext (loopback or test use only).
        #[arg(long, requires = "tls_key")]
        tls_cert: Option<PathBuf>,
        #[arg(long, requires = "tls_cert")]
        tls_key: Option<PathBuf>,
        /// Upper bounds for JetStream storage so a runaway queue cannot fill the host.
        #[arg(long, default_value = "5GB")]
        max_file_store: String,
        #[arg(long, default_value = "256MB")]
        max_memory_store: String,
    },
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KeyFile {
    pub kind: String,
    pub id: String,
    pub domain_id: String,
    pub private_key: String,
    pub public_key: String,
}

impl KeyFile {
    pub fn generate(kind: &str, id: &str, domain_id: &str) -> Self {
        let key = jws::new_signing_key();
        Self {
            kind: kind.into(),
            id: id.into(),
            domain_id: domain_id.into(),
            private_key: jws::signing_key_to_b64(&key),
            public_key: jws::verifying_key_to_b64(&key.verifying_key()),
        }
    }

    pub fn write(&self, path: &Path) -> Result<()> {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            options.mode(0o600);
            let mut file = options.open(path)?;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?; // an existing, looser file is tightened before the secret is written
            file.write_all(serde_json::to_string_pretty(self)?.as_bytes())?;
            Ok(())
        }
        #[cfg(not(unix))]
        {
            options.open(path)?.write_all(serde_json::to_string_pretty(self)?.as_bytes())?;
            Ok(())
        }
    }

    pub fn read(path: &Path) -> Result<Self> {
        serde_json::from_str(&std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?).context("parse key file")
    }

    pub fn signing_key(&self) -> Result<ed25519_dalek::SigningKey> {
        Ok(jws::signing_key_from_b64(&self.private_key)?)
    }
}

fn render_nats_conf(cfg: &ServerConfig, command: AdminCommand) -> Result<()> {
    use somework_nats::conf::{NatsConfigGenerator, ServerConfSpec, ServerTls, server_conf, write_private};
    let AdminCommand::RenderNatsConf { out_dir, host, port, store_dir, pid_file, tls_cert, tls_key, max_file_store, max_memory_store } = command else {
        unreachable!("only called for RenderNatsConf")
    };
    use sha2::Digest as _;
    let nats = cfg.nats.as_ref().context("the server config has no [nats] section")?;
    let (user, password) = nats.user.as_deref().zip(nats.password.as_deref()).context("[nats] needs user and password: the domain's own broker login")?;
    let users_file = out_dir.join("users.conf");
    let spec = ServerConfSpec {
        server_name: format!("somework-{}", cfg.domain.id),
        host,
        tls: tls_cert.zip(tls_key).map(|(cert_file, key_file)| ServerTls { cert_file, key_file }),
        max_file_store: Some(max_file_store),
        max_memory_store: Some(max_memory_store),
        port,
        store_dir,
        domain_id: cfg.domain.id.clone(),
        users_file: users_file.clone(),
        pid_file: Some(pid_file),
        system_user: "system".into(),
        // derived, so re-rendering the config never changes it and no extra secret needs storing
        system_password: hex::encode(&sha2::Sha256::digest(format!("somework-nats-system:{password}").as_bytes())[..16]),
    };
    write_private(&out_dir.join("nats-server.conf"), &server_conf(&spec))?;
    if !users_file.exists() {
        // the domain rewrites this file whenever agents are enrolled; start with the domain's own login only
        let generator = NatsConfigGenerator::new(somework_nats::conf::CredentialSecret::from_master_key("unused"));
        write_private(&users_file, &generator.users_fragment(user, password, &[]))?;
    }
    println!("wrote {}/nats-server.conf and users.conf (set [nats] users_file to the users.conf path as the domain sees it)", out_dir.display());
    Ok(())
}

pub async fn run_admin(config: &Path, command: AdminCommand) -> Result<()> {
    let cfg = ServerConfig::load(config)?;
    let command = match command {
        render @ AdminCommand::RenderNatsConf { .. } => return render_nats_conf(&cfg, render),
        other => other,
    };
    let domain = Domain::open(cfg.domain_config()).await?;
    let domain_id = cfg.domain.id.clone();
    let ctx = domain.system_ctx();
    match command {
        AdminCommand::Bootstrap { name, key_out } => {
            let key = KeyFile::generate("service", &name, &domain_id);
            domain.bootstrap_admin(&name, &key.public_key).await?;
            key.write(&key_out)?;
            println!("administrator {name} ready; key written to {}", key_out.display());
        }
        AdminCommand::EnrollAgent { id, side_effects, classification, may_invoke, key_out, public_key } => {
            let generated = match (&public_key, key_out) {
                (None, Some(out)) => Some((KeyFile::generate("agent", &id, &domain_id), out)),
                (Some(_), None) => None,
                _ => anyhow::bail!("give exactly one of --key-out (generate the key here) or --public-key (generated on the worker host)"),
            };
            let public_key = match (&generated, public_key) {
                (Some((key, _)), _) => key.public_key.clone(),
                (None, Some(provided)) => provided,
                (None, None) => unreachable!("one of the two is always present"),
            };
            let mut perms = Permissions::default_agent();
            perms.side_effects_at_most = Some(SideEffects::parse(&side_effects).context("side-effects must be none, read, write or irreversible")?);
            perms.classification_max = Some(classification);
            perms.capabilities = may_invoke;
            domain
                .create_principal(
                    &ctx,
                    CreatePrincipal {
                        kind: ActorKind::Agent,
                        id: id.clone(),
                        display_name: Some(id.clone()),
                        permissions: Some(perms),
                        public_key: Some(public_key),
                        matrix_user_id: None,
                        oidc_issuer: None,
                        oidc_subject: None,
                    },
                )
                .await?;
            match generated {
                Some((key, out)) => {
                    key.write(&out)?;
                    println!("agent {id} enrolled; key written to {}", out.display());
                }
                None => println!("agent {id} enrolled with the provided public key"),
            }
        }
        AdminCommand::RotateAgentKey { id, public_key } => {
            domain.update_principal(&ctx, ActorKind::Agent, &id, None, None, Some(public_key)).await?;
            println!("agent {id}: public key replaced; the previous key no longer authenticates");
        }
        AdminCommand::SetAgentPermissions { id, side_effects, classification, may_invoke } => {
            let mut perms = Permissions::default_agent();
            perms.side_effects_at_most = Some(SideEffects::parse(&side_effects).context("side-effects must be none, read, write or irreversible")?);
            perms.classification_max = Some(classification);
            perms.capabilities = may_invoke;
            domain.update_principal(&ctx, ActorKind::Agent, &id, Some(perms), None, None).await?;
            println!("agent {id}: permissions replaced");
        }
        AdminCommand::SetAgentStatus { id, status } => {
            domain.update_principal(&ctx, ActorKind::Agent, &id, None, Some(status.clone()), None).await?;
            println!("agent {id}: status {status}");
        }
        AdminCommand::EnrollHuman { id, matrix_user, oidc_issuer, oidc_subject, roles, approves, classification } => {
            let mut perms = Permissions::default_human();
            perms.roles = roles;
            perms.approves = approves;
            perms.classification_max = Some(classification);
            domain
                .create_principal(
                    &ctx,
                    CreatePrincipal {
                        kind: ActorKind::Human,
                        id: id.clone(),
                        display_name: Some(id.clone()),
                        permissions: Some(perms),
                        public_key: None,
                        matrix_user_id: matrix_user,
                        oidc_issuer,
                        oidc_subject,
                    },
                )
                .await?;
            println!("human {id} enrolled");
        }
        AdminCommand::Token { key, ttl_seconds } => {
            let kf = KeyFile::read(&key)?;
            let token = jws::mint_assertion(
                &kf.signing_key()?,
                &format!("{}:{}", kf.kind, kf.id),
                &format!("somework:{}", kf.domain_id),
                None,
                chrono::Utc::now(),
                chrono::Duration::seconds(ttl_seconds),
            );
            println!("{token}");
        }
        AdminCommand::VerifyAudit => match domain.verify_audit_chain().await? {
            None => println!("{}", json!({"intact": true})),
            Some(seq) => {
                println!("{}", json!({"intact": false, "firstBrokenSeq": seq}));
                std::process::exit(2);
            }
        },
        AdminCommand::RegisterCard { card, approve } => {
            let card: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&card).with_context(|| format!("read {}", card.display()))?)?;
            let entry = domain.register_agent(&ctx, somework_domain::catalog::RegisterAgent { card, ..Default::default() }).await?;
            if approve {
                let approval =
                    somework_domain::catalog::ApproveEntry { status: Some(somework_core::contracts::ApprovalStatus::Approved), ..Default::default() };
                domain.approve_entry(&ctx, &entry.entry_id, approval).await?;
            }
            println!("registered {} ({})", entry.agent_card.agent_id, if approve { "approved" } else { "draft" });
        }
        AdminCommand::RepublishQueued => {
            let n = domain.republish_queued_tasks().await?;
            println!("re-enqueued {n} queued task(s)");
        }
        AdminCommand::RenderNatsConf { .. } => unreachable!("handled before the domain is opened"),
    }
    Ok(())
}

pub async fn run_matrix_crypto(config: &Path, command: MatrixCryptoCommand) -> Result<()> {
    let cfg = ServerConfig::load(config)?;
    let domain = Domain::open(cfg.domain_config()).await?;
    let passphrase = || std::env::var("SOMEWORK_CRYPTO_PASSPHRASE").context("set SOMEWORK_CRYPTO_PASSPHRASE to the recovery passphrase");
    match command {
        MatrixCryptoCommand::Export { out, iterations } => {
            let bundle = domain.export_matrix_crypto(&passphrase()?, iterations).await?;
            std::fs::write(&out, bundle)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&out, std::fs::Permissions::from_mode(0o600))?;
            }
            println!("recovery bundle written to {}", out.display());
        }
        MatrixCryptoCommand::Import { from } => {
            let report = domain.import_matrix_crypto(&std::fs::read_to_string(&from)?, &passphrase()?).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        MatrixCryptoCommand::Verify => {
            let report = domain.verify_matrix_crypto().await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
    }
    Ok(())
}
