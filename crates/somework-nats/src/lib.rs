//! NATS/JetStream machine plane: durable wake-ups and worker dispatch (JetStream), ephemeral streaming and
//! presence (core NATS). PostgreSQL's role in the spec is played by SQLite: this plane only *projects* outbox rows.

pub mod conf;
pub mod config;
mod connection;
mod metrics;
mod plane;
mod presence;
mod sink;
mod streams;

use std::sync::Arc;

use somework_core::Error;
use somework_domain::{Domain, outbox::OutboxConfig};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

pub use config::NatsConfig;
pub use connection::NatsConnectionProvider;
pub use plane::{ConsumerKey, NatsPlane, connect};
pub use sink::NatsSink;
pub use streams::{ChunkKind, ChunkPublisher, NatsStreamSource, StreamChunk};

pub struct NatsHandle {
    pub plane: Arc<NatsPlane>,
    pub stream_source: Arc<NatsStreamSource>,
    pub connection: Arc<NatsConnectionProvider>,
    pub tasks: Vec<JoinHandle<()>>,
}

/// Connects (without blocking on an unavailable broker), starts the outbox publisher, the reconciler that
/// provisions streams/consumers/users, the presence listener and the metrics loop.
pub async fn start(domain: Domain, cfg: NatsConfig, shutdown: CancellationToken) -> Result<NatsHandle, Error> {
    let presence = cfg.presence;
    let plane = NatsPlane::new(domain.clone(), cfg).await?;
    let sink = Arc::new(NatsSink::new(plane.js.clone()));
    let mut tasks = vec![
        domain.spawn_outbox(sink, OutboxConfig::default(), shutdown.clone()),
        plane.spawn_reconciler(shutdown.clone()),
        metrics::spawn_metrics_loop(plane.clone(), shutdown.clone()),
    ];
    if presence {
        tasks.push(presence::spawn_presence_listener(plane.clone(), shutdown.clone()));
    }
    Ok(NatsHandle {
        stream_source: Arc::new(NatsStreamSource::new(plane.clone())),
        connection: Arc::new(NatsConnectionProvider::new(plane.clone())),
        plane,
        tasks,
    })
}
