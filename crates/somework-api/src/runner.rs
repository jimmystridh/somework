//! Assembles a complete server process from a [`ServerConfig`]: domain, artifact store, planes, maintenance, HTTP.

use std::{net::SocketAddr, sync::Arc, time::Duration};

use somework_core::Error;
use somework_domain::{Domain, objects::FsObjectStore};
use tokio_util::sync::CancellationToken;

use crate::{config::ServerConfig, oidc::OidcVerifier, server::RunningServer, state::AppState, wiring};

pub struct Runtime {
    pub domain: Domain,
    pub server: RunningServer,
    pub shutdown: CancellationToken,
    pub grpc_addr: Option<SocketAddr>,
    background: Vec<tokio::task::JoinHandle<()>>,
}

impl Runtime {
    pub fn url(&self) -> String {
        self.server.url()
    }

    pub async fn stop(self) {
        // Graceful shutdown waits for in-flight requests, but long-lived streams (SSE, gRPC watches) would never end:
        // give everything a bounded grace period and then abort.
        const GRACE: std::time::Duration = std::time::Duration::from_secs(3);
        self.shutdown.cancel();
        self.server.shutdown.cancel();
        let mut handles = vec![self.server.handle];
        handles.extend(self.background);
        for mut h in handles {
            if tokio::time::timeout(GRACE, &mut h).await.is_err() {
                h.abort();
            }
        }
        self.domain.db.close().await;
    }
}

pub async fn start(cfg: ServerConfig) -> Result<Runtime, Error> {
    let domain_cfg = cfg.domain_config();
    let domain = Domain::open(domain_cfg).await?;
    start_with_domain(domain, cfg).await
}

pub async fn start_with_domain(domain: Domain, cfg: ServerConfig) -> Result<Runtime, Error> {
    let shutdown = CancellationToken::new();
    let addr: SocketAddr = cfg.domain.listen.parse().map_err(|e| Error::invalid(format!("invalid listen address: {e}")))?;
    let (listener, local) = crate::server::bind(addr).await?;
    let mut state = AppState::new(domain.clone());
    if cfg.domain.public_url == "auto" {
        state.public_url = format!("http://{local}");
    }
    state.allow_failpoint_admin = cfg.allow_failpoint_admin;
    state.ui_dir = cfg.ui.dir.clone();
    if !cfg.oidc.is_empty() {
        state.oidc = Some(OidcVerifier::new(cfg.oidc.clone()));
    }
    if cfg.ui.login.is_some() || cfg.ui.dev_token_login {
        state.ui = Some(Arc::new(crate::ui_session::UiState::new(cfg.ui.login.clone(), cfg.ui.dev_token_login, state.public_url.starts_with("https://"))));
    }

    match cfg.objects.kind.as_deref().unwrap_or("fs") {
        "fs" => {
            let dir = cfg.objects.dir.clone().unwrap_or_else(|| cfg.domain.db.with_extension("objects"));
            let secret: [u8; 32] = {
                // derived from the domain master key so grants survive restarts and replicas share them
                use sha2::{Digest, Sha256};
                let seed = format!("somework-fs-grants:{}", domain.master.to_b64());
                Sha256::digest(seed.as_bytes()).into()
            };
            let store =
                FsObjectStore::new(dir, state.public_url.clone(), secret, domain.clock.clone()).map_err(|e| Error::internal(format!("object store: {e}")))?;
            domain.set_object_store(Arc::new(store.clone()));
            state.fs_store = Some(Arc::new(store));
        }
        "s3" => {
            let s3 = cfg.objects.s3.clone().ok_or_else(|| Error::invalid("objects.kind = \"s3\" requires an [objects.s3] section"))?;
            let store = somework_domain::objects_s3::S3ObjectStore::new(s3, domain.clock.clone())?;
            domain.set_object_store(Arc::new(store));
        }
        other => return Err(Error::invalid(format!("unknown object store kind {other}"))),
    }

    let wired = wiring::wire(&domain, &cfg, &shutdown).await?;
    state.streams = wired.streams.clone();
    state.connection = wired.connection.clone();
    state.gateway = wired.gateway.clone();
    let mut background = wired.tasks;
    background.push(domain.spawn_maintenance(Duration::from_millis(cfg.domain.maintenance_interval_ms), shutdown.clone()));
    if let Some(handle) = crate::backup::spawn_scheduled(&domain, &cfg, shutdown.clone()) {
        background.push(handle);
    }

    let mut grpc_addr = None;
    if let Some(section) = &cfg.grpc {
        let grpc = crate::grpc::serve(state.clone(), section, shutdown.clone()).await?;
        grpc_addr = Some(grpc.addr);
        background.push(grpc.handle);
    }

    let server = crate::server::serve_listener(state, wired.routers, listener, local);
    Ok(Runtime { domain, server, shutdown, grpc_addr, background })
}
