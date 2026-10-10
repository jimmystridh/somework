//! Wires optional planes (NATS, Matrix) into a running server. Each plane owns one file here.

mod matrix;
mod nats;

use std::sync::Arc;

use axum::Router;
use somework_core::Error;
use somework_domain::Domain;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::config::ServerConfig;

#[derive(Default)]
pub struct Wired {
    /// Extra routes merged into the public listener (Matrix appservice endpoints).
    pub routers: Vec<Router>,
    pub connection: Option<Arc<dyn somework_domain::streams::ConnectionProvider>>,
    pub tasks: Vec<JoinHandle<()>>,
}

pub async fn wire(domain: &Domain, cfg: &ServerConfig, shutdown: &CancellationToken) -> Result<Wired, Error> {
    let mut wired = Wired::default();
    nats::wire(domain, cfg, shutdown, &mut wired).await?;
    matrix::wire(domain, cfg, shutdown, &mut wired).await?;
    Ok(wired)
}
