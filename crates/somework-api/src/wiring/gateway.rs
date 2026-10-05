use std::sync::Arc;

use somework_core::Error;
use somework_domain::Domain;
use tokio_util::sync::CancellationToken;

use super::Wired;
use crate::config::ServerConfig;

pub async fn wire(domain: &Domain, cfg: &ServerConfig, shutdown: &CancellationToken, out: &mut Wired) -> Result<(), Error> {
    let Some(gateway_cfg) = cfg.gateway.clone() else { return Ok(()) };
    let handle = somework_gateway::start(domain.clone(), gateway_cfg, shutdown.clone()).await?;
    out.routers.push(handle.public_router);
    out.gateway = Some(Arc::new(handle.admin));
    out.tasks.extend(handle.tasks);
    Ok(())
}
