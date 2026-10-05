use std::{net::SocketAddr, sync::Arc};

use axum::{Router, middleware};
use somework_core::Error;
use somework_domain::{Domain, objects::FsObjectStore};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use tower_http::{compression::CompressionLayer, services::ServeDir};

use crate::{http::trace_layer, routes, state::AppState};

/// Builds the full router. `extra` lets other planes (gateway, A2A, Matrix appservice) mount their routes.
pub fn build_router(state: AppState, extra: Vec<Router>) -> Router {
    let mut app: Router = routes::router().with_state(state.clone());
    for r in extra {
        app = app.merge(r);
    }
    if let Some(dir) = &state.ui_dir {
        app = app.nest_service("/ui", ServeDir::new(dir).append_index_html_on_directories(true));
    }
    app.layer(middleware::from_fn_with_state(state, trace_layer)).layer(CompressionLayer::new())
}

pub struct RunningServer {
    pub addr: SocketAddr,
    pub shutdown: CancellationToken,
    pub handle: tokio::task::JoinHandle<()>,
}

impl RunningServer {
    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }

    pub async fn stop(self) {
        self.shutdown.cancel();
        let _ = self.handle.await;
    }
}

/// Binds `addr` (port 0 picks an ephemeral port). Bind first so the public URL can embed the real port.
pub async fn bind(addr: SocketAddr) -> Result<(TcpListener, SocketAddr), Error> {
    let listener = TcpListener::bind(addr).await.map_err(|e| Error::internal(format!("bind {addr}: {e}")))?;
    let local = listener.local_addr().map_err(|e| Error::internal(e.to_string()))?;
    Ok((listener, local))
}

/// Serves on an already bound listener until the returned token is cancelled.
pub fn serve_listener(state: AppState, extra: Vec<Router>, listener: TcpListener, local: SocketAddr) -> RunningServer {
    let shutdown = CancellationToken::new();
    let app = build_router(state, extra);
    let token = shutdown.clone();
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app).with_graceful_shutdown(async move { token.cancelled().await }).await;
    });
    RunningServer { addr: local, shutdown, handle }
}

pub async fn serve(state: AppState, extra: Vec<Router>, addr: SocketAddr) -> Result<RunningServer, Error> {
    let (listener, local) = bind(addr).await?;
    Ok(serve_listener(state, extra, listener, local))
}

/// Convenience for single-process deployments and tests: local FS artifact store served by this process.
pub fn attach_fs_store(state: &mut AppState, root: impl Into<std::path::PathBuf>, secret: [u8; 32]) -> Result<(), Error> {
    let store =
        FsObjectStore::new(root, state.public_url.clone(), secret, state.domain.clock.clone()).map_err(|e| Error::internal(format!("object store: {e}")))?;
    state.domain.set_object_store(Arc::new(store.clone()));
    state.fs_store = Some(Arc::new(store));
    Ok(())
}

pub fn domain_of(state: &AppState) -> &Domain {
    &state.domain
}
