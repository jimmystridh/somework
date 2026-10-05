//! Matrix collaboration plane: an Application Service bridge that projects canonical SomeWork state into
//! readable rooms/threads (outbound) and turns human participation into policy-checked domain calls (inbound).
//! Matrix is a projection, never the authority: see `docs/matrix.md`.

pub mod bridge;
pub mod client;
pub mod config;
pub mod crypto;
pub mod ingest;
pub mod sink;

use std::sync::Arc;

pub use bridge::Bridge;
pub use config::{MatrixConfig, registration_yaml};
pub use sink::MatrixSink;
use somework_domain::{Domain, outbox::OutboxConfig};
use tokio_util::sync::CancellationToken;

static RUNNING: std::sync::OnceLock<parking_lot::Mutex<std::collections::HashMap<String, Arc<Bridge>>>> = std::sync::OnceLock::new();

/// Operator hook: the bridge running for the domain database at `database_path` in this process (e.g. to rotate
/// Application Service tokens).
pub fn running_bridge(database_path: &str) -> Option<Arc<Bridge>> {
    RUNNING.get().and_then(|m| m.lock().get(database_path).cloned())
}

pub struct MatrixPlane {
    pub bridge: Arc<Bridge>,
    pub router: axum::Router,
    pub task: tokio::task::JoinHandle<()>,
}

/// Starts the projector (outbox runner for sink `matrix`) and builds the appservice router.
pub fn start(domain: Domain, cfg: MatrixConfig, shutdown: CancellationToken) -> MatrixPlane {
    let throttle = std::time::Duration::from_millis(cfg.progress_throttle_ms);
    let bridge = Bridge::new(domain.clone(), cfg);
    let sink = Arc::new(MatrixSink::new(bridge.clone()));
    let task = domain.spawn_outbox(sink, OutboxConfig { coalesce_interval: throttle, ..Default::default() }, shutdown);
    let router = ingest::router(bridge.clone());
    if let Some(crypto) = bridge.crypto.clone() {
        // publish the observer device early so members' clients can share room keys with it
        let observer = bridge.cfg.bot_user_id();
        tokio::spawn(async move {
            for attempt in 0..30u64 {
                match crypto.ensure_device(&observer).await {
                    Ok(_) => return,
                    Err(e) => {
                        tracing::warn!(error = %e, "observer device not published yet");
                        tokio::time::sleep(std::time::Duration::from_millis(250 * (attempt + 1))).await;
                    }
                }
            }
        });
    }
    RUNNING.get_or_init(Default::default).lock().insert(bridge.domain.cfg.database_path.to_string_lossy().to_string(), bridge.clone());
    MatrixPlane { bridge, router, task }
}
