use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};
use somework_sidecar::{
    config::{AdapterConfig, Mode, SidecarConfig, WakeMode},
    keyfile::KeyFile,
    mcp::{McpServer, transport},
    worker::{Worker, build_adapter},
};
use tokio_util::sync::CancellationToken;
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
#[command(name = "somework-sidecar", version, about = "SomeWork sidecar: MCP server and worker runtime")]
struct Cli {
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the sidecar (MCP and/or worker).
    Run(RunArgs),
    /// Generate a fresh identity on this machine. Prints the public key to register with the domain
    /// (`somework admin enroll-agent --public-key`); the private key stays in the key file.
    Keygen {
        /// Agent id, e.g. agent/reviewer
        #[arg(long)]
        id: String,
        #[arg(long, default_value = "development")]
        domain: String,
        #[arg(long, default_value = "agent")]
        kind: String,
        #[arg(long)]
        key_out: PathBuf,
    },
    /// Print the public key of an existing key file (for registration or rotation).
    PublicKey {
        #[arg(long)]
        key_file: PathBuf,
    },
}

#[derive(clap::Args)]
struct RunArgs {
    #[arg(long, env = "SOMEWORK_SIDECAR_CONFIG")]
    config: Option<PathBuf>,
    #[arg(long, env = "SOMEWORK_DOMAIN_URL")]
    domain_url: Option<String>,
    #[arg(long, env = "SOMEWORK_KEY_FILE")]
    key_file: Option<PathBuf>,
    #[arg(long, value_enum)]
    mode: Option<ModeArg>,
    /// Command run per task (split on whitespace); task JSON on stdin, JSON lines on stdout.
    #[arg(long)]
    exec: Option<String>,
    #[arg(long)]
    http_adapter: Option<String>,
    #[arg(long, value_enum)]
    wake: Option<WakeArg>,
    #[arg(long)]
    lease_seconds: Option<i64>,
    #[arg(long)]
    mcp_http_listen: Option<String>,
    /// Refuse plaintext: the domain URL must be https and NATS must use TLS.
    #[arg(long, env = "SOMEWORK_TLS_REQUIRED")]
    tls_required: bool,
    /// PEM bundle of the private CA for the domain and NATS server certificates (only this CA is trusted).
    #[arg(long, env = "SOMEWORK_TLS_CA_FILE")]
    tls_ca_file: Option<PathBuf>,
    /// Also expose the extended tools (conversations, inbox, polling, sealed secrets).
    #[arg(long)]
    extended_tools: bool,
}

#[derive(Clone, clap::ValueEnum)]
enum ModeArg {
    Mcp,
    McpHttp,
    Worker,
    Both,
}

#[derive(Clone, clap::ValueEnum)]
enum WakeArg {
    Auto,
    Poll,
    Nats,
}

#[tokio::main]
async fn main() -> Result<()> {
    somework_sidecar::tls::install_crypto_provider();
    // stdout belongs to the MCP protocol: all logging goes to stderr
    tracing_subscriber::fmt().with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"))).with_writer(std::io::stderr).init();
    match Cli::parse().command {
        Cmd::Run(args) => run(args).await,
        Cmd::Keygen { id, domain, kind, key_out } => {
            let key = KeyFile::generate(&kind, &id, &domain);
            key.create_new(&key_out)?;
            println!("{}", serde_json::json!({"id": key.id, "domainId": key.domain_id, "publicKey": key.public_key, "keyFile": key_out}));
            Ok(())
        }
        Cmd::PublicKey { key_file } => {
            println!("{}", KeyFile::read(&key_file)?.public_key);
            Ok(())
        }
    }
}

/// Completes on SIGINT or (on unix) SIGTERM, which is what `docker stop` and systemd send.
async fn termination_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => tokio::select! {
                _ = tokio::signal::ctrl_c() => {},
                _ = term.recv() => {},
            },
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

async fn run(args: RunArgs) -> Result<()> {
    let mut cfg = match &args.config {
        Some(p) => SidecarConfig::load(p)?,
        None => SidecarConfig::default(),
    };
    if let Some(v) = args.domain_url {
        cfg.domain_url = v;
    }
    if let Some(v) = args.key_file {
        cfg.key_file = v;
    }
    if let Some(m) = args.mode {
        cfg.mode = match m {
            ModeArg::Mcp => Mode::Mcp,
            ModeArg::McpHttp => Mode::McpHttp,
            ModeArg::Worker => Mode::Worker,
            ModeArg::Both => Mode::Both,
        };
    }
    if let Some(c) = args.exec {
        cfg.worker.adapter =
            AdapterConfig::Exec { command: c.split_whitespace().map(String::from).collect(), env: Default::default(), env_allow: Default::default() };
    }
    if let Some(u) = args.http_adapter {
        cfg.worker.adapter = AdapterConfig::Http { url: u };
    }
    if let Some(w) = args.wake {
        cfg.worker.wake = match w {
            WakeArg::Auto => WakeMode::Auto,
            WakeArg::Poll => WakeMode::Poll,
            WakeArg::Nats => WakeMode::Nats,
        };
    }
    if let Some(l) = args.lease_seconds {
        cfg.worker.lease_seconds = l;
    }
    if let Some(l) = args.mcp_http_listen {
        cfg.mcp_http_listen = l;
    }
    cfg.tls.required |= args.tls_required;
    if let Some(ca) = args.tls_ca_file {
        cfg.tls.ca_file = Some(ca);
    }
    cfg.worker.tls = cfg.tls.clone();
    anyhow::ensure!(!cfg.tls.required || cfg.domain_url.starts_with("https://"), "tls is required but the domain url {} is not https", cfg.domain_url);
    let key = KeyFile::read(&cfg.key_file)?;
    // every process is a distinct runtime instance (ID-02), regardless of configuration
    let runtime = cfg.runtime_instance_id.clone().unwrap_or_else(somework_core::ids::runtime_instance_id);
    let mut client = key.client(&cfg.domain_url, &runtime)?;
    if let Some(ca) = &cfg.tls.ca_file {
        client = client.with_ca_file(ca).map_err(anyhow::Error::msg)?;
    }
    let shutdown = CancellationToken::new();
    let ctrl = shutdown.clone();
    tokio::spawn(async move {
        termination_signal().await;
        ctrl.cancel();
    });

    let worker_task = if matches!(cfg.mode, Mode::Worker | Mode::Both) {
        let adapter = build_adapter(&cfg.worker.adapter, cfg.worker.max_stderr_notices);
        let worker = Worker::new(client.clone(), key.id.clone(), cfg.worker.clone(), adapter);
        let stop = shutdown.clone();
        Some(tokio::spawn(async move {
            if let Err(e) = worker.run(stop).await {
                tracing::error!(error = %e, "worker stopped");
            }
        }))
    } else {
        None
    };

    let mcp = McpServer::with_key(client.clone(), args.extended_tools, key.signing_key()?);
    match cfg.mode {
        Mode::Mcp | Mode::Both => {
            if cfg.mode == Mode::Both {
                client.register_runtime(serde_json::json!({})).await.ok();
            }
            transport::serve_stdio(mcp).await?;
            shutdown.cancel();
        }
        Mode::McpHttp => {
            let addr = transport::serve_http(mcp, &cfg.mcp_http_listen, shutdown.clone()).await?;
            println!("{}", serde_json::json!({"mcpUrl": format!("http://{addr}/mcp")}));
            shutdown.cancelled().await;
        }
        Mode::Worker => shutdown.cancelled().await,
    }
    if let Some(t) = worker_task {
        let _ = t.await;
    }
    Ok(())
}
