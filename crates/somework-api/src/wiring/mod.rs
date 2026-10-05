//! Wires optional planes (NATS, Matrix, gateway) into a running server. Each plane owns one file here.

mod gateway;
mod matrix;
mod nats;

use std::sync::Arc;

use axum::Router;
use somework_core::Error;
use somework_domain::{Domain, streams::StreamSource};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::config::ServerConfig;

#[derive(Default)]
pub struct Wired {
    /// Extra routes merged into the public listener (Matrix appservice endpoints, A2A, ...).
    pub routers: Vec<Router>,
    pub streams: Option<Arc<dyn StreamSource>>,
    pub connection: Option<Arc<dyn somework_domain::streams::ConnectionProvider>>,
    pub gateway: Option<Arc<somework_gateway::GatewayAdmin>>,
    pub tasks: Vec<JoinHandle<()>>,
}

pub async fn wire(domain: &Domain, cfg: &ServerConfig, shutdown: &CancellationToken) -> Result<Wired, Error> {
    let mut wired = Wired::default();
    nats::wire(domain, cfg, shutdown, &mut wired).await?;
    matrix::wire(domain, cfg, shutdown, &mut wired).await?;
    gateway::wire(domain, cfg, shutdown, &mut wired).await?;
    Ok(wired)
}
