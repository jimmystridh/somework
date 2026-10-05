use somework_core::Error;
use somework_domain::Domain;
use tokio_util::sync::CancellationToken;

use super::Wired;
use crate::config::ServerConfig;

pub async fn wire(domain: &Domain, cfg: &ServerConfig, shutdown: &CancellationToken, out: &mut Wired) -> Result<(), Error> {
    let Some(matrix) = &cfg.matrix else { return Ok(()) };
    if matrix.as_token.is_empty() || matrix.hs_token.is_empty() || matrix.homeserver_url.is_empty() {
        return Err(Error::invalid("[matrix] requires homeserver_url, as_token and hs_token"));
    }
    let plane = somework_matrix::start(domain.clone(), matrix.clone(), shutdown.clone());
    out.routers.push(plane.router);
    out.tasks.push(plane.task);
    Ok(())
}
