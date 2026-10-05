//! Trust-domain federation gateway (mTLS + signed grants), disclosure control and A2A interoperability.
//! See `docs/gateway.md`.

pub mod a2a;
pub mod catalog_import;
pub mod config;
pub mod disclosure;
pub mod egress;
pub mod fed_backend;
pub mod grants;
pub mod ingress;
pub mod peer_client;
pub mod peers;
pub mod tls;

use std::{net::SocketAddr, sync::Arc, time::Duration};

use axum::Router;
use serde_json::{Value, json};
use somework_core::Error;
use somework_domain::{Domain, outbox::OutboxConfig};
use tokio_util::sync::CancellationToken;

pub use config::{A2aConfig, GatewayConfig};
pub use peers::{AddPeer, PeerKey, PeerPolicy, PeerRecord, PeerStatus, Peers};

/// Administrative surface of the gateway, shared with the API's admin routes.
#[derive(Clone)]
pub struct GatewayAdmin {
    pub domain: Domain,
    pub peers: Peers,
    pub client: peer_client::PeerClient,
    pub federation_addr: Option<SocketAddr>,
    pub audience: String,
}

impl GatewayAdmin {
    /// What a peer administrator needs to register this domain: audience, certificate thumbprint and signing keys.
    pub async fn identity(&self) -> Result<Value, Error> {
        let rows: Vec<(String, String, String)> = sqlx_keys(&self.domain).await?;
        Ok(json!({
            "domainId": self.domain.domain_id(),
            "gatewayAudience": self.audience,
            "clientCertificateThumbprint": self.client.our_thumbprint(),
            "federationAddress": self.federation_addr.map(|a| a.to_string()),
            "signingKeys": rows.into_iter().map(|(kid, public_key, status)| json!({"kid": kid, "publicKey": public_key, "status": status})).collect::<Vec<_>>(),
        }))
    }
}

async fn sqlx_keys(domain: &Domain) -> Result<Vec<(String, String, String)>, Error> {
    use somework_domain::db::DbResultExt;
    sqlx::query_as("SELECT kid, public_key, status FROM signing_keys WHERE domain_id = ? ORDER BY created_at")
        .bind(domain.domain_id())
        .fetch_all(domain.db.pool())
        .await
        .db()
}

pub struct GatewayHandle {
    /// A2A routes, merged into the public listener.
    pub public_router: Router,
    pub admin: GatewayAdmin,
    pub tasks: Vec<tokio::task::JoinHandle<()>>,
}

pub async fn start(domain: Domain, cfg: GatewayConfig, shutdown: CancellationToken) -> Result<GatewayHandle, Error> {
    let cfg = Arc::new(cfg);
    let peers = Peers::new(domain.clone());
    let client = peer_client::PeerClient::new(domain.clone(), peers.clone(), cfg.clone())?;
    let mut tasks = vec![];
    let mut federation_addr = None;

    if let Some(listen) = &cfg.listen {
        let (cert, key) = cfg.server_identity()?.ok_or_else(|| Error::invalid("gateway.listen requires a server certificate and key"))?;
        peers.refresh_pinned().await?;
        let tls_cfg = tls::server_config(&cert, &key, peers.pinned())?;
        let listener = tokio::net::TcpListener::bind(listen).await.map_err(|e| Error::internal(format!("gateway bind {listen}: {e}")))?;
        federation_addr = listener.local_addr().ok();
        tasks.push(tls::spawn_pin_refresher(peers.clone(), shutdown.clone()));
        let app = ingress::router(ingress::IngressState { domain: domain.clone(), peers: peers.clone() });
        let token = shutdown.clone();
        tasks.push(tokio::spawn(async move { tls::serve_mtls(app, listener, tls_cfg, token).await }));
    }

    let federation_backend = Arc::new(fed_backend::FederationBackend { domain: domain.clone(), client: client.clone() });
    let a2a_backend = Arc::new(a2a::client::A2aBackend::new(domain.clone()));
    let egress = egress::Egress::new(
        domain.clone(),
        federation_backend,
        a2a_backend,
        Duration::from_millis(cfg.egress_poll_ms),
        cfg.egress_lease_seconds,
        shutdown.clone(),
    );
    if domain.cfg.sink_enabled(somework_domain::config::SINK_GATEWAY) {
        let sink = Arc::new(egress::EgressSink { egress: egress.clone() });
        tasks.push(domain.spawn_outbox(
            sink,
            OutboxConfig {
                poll_interval: Duration::from_millis(100),
                base_backoff: Duration::from_millis(200),
                max_backoff: Duration::from_secs(5),
                max_attempts: 1_000,
                ..Default::default()
            },
            shutdown.clone(),
        ));
    }
    let keeper = egress.clone();
    let token = shutdown.clone();
    tasks.push(tokio::spawn(async move {
        keeper.resume_open().await;
        loop {
            let _ = keeper.refresh_workers().await;
            tokio::select! {
                _ = token.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_secs(10)) => {},
            }
        }
    }));

    let mut public_router = Router::new();
    if cfg.a2a.enabled {
        let state = a2a::server::A2aState {
            domain: domain.clone(),
            base_url: cfg.a2a.public_base_url.clone(),
            provider: cfg.a2a.provider_organization.clone().zip(cfg.a2a.provider_url.clone()),
            blocking_wait: Duration::from_secs(25),
        };
        public_router = public_router.merge(a2a::server::router(state));
    }
    let admin = GatewayAdmin { audience: grants::gateway_audience(domain.domain_id()), domain, peers, client, federation_addr };
    Ok(GatewayHandle { public_router, admin, tasks })
}
