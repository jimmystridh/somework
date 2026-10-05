use somework_core::Error;
use somework_domain::Domain;
use tokio_util::sync::CancellationToken;

use super::Wired;
use crate::config::ServerConfig;

pub async fn wire(domain: &Domain, cfg: &ServerConfig, shutdown: &CancellationToken, out: &mut Wired) -> Result<(), Error> {
    let Some(nats_cfg) = &cfg.nats else { return Ok(()) };
    let handle = somework_nats::start(domain.clone(), nats_cfg.clone(), shutdown.clone()).await?;
    out.streams = Some(handle.stream_source.clone());
    out.connection = Some(handle.connection.clone());
    out.tasks.extend(handle.tasks);
    Ok(())
}
