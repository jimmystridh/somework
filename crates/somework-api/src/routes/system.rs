use axum::{
    Router,
    extract::State,
    http::{StatusCode, header},
    response::IntoResponse,
    routing::get,
};
use serde_json::json;

use crate::{http::*, state::AppState};

pub fn routes() -> Router<AppState> {
    Router::new().route("/healthz", get(healthz)).route("/readyz", get(readyz)).route("/metrics", get(metrics))
}

async fn healthz() -> ApiResult {
    ok(json!({"status": "ok"}))
}

async fn readyz(State(s): State<AppState>) -> ApiResult {
    let db_ok = s.domain.db_healthy().await;
    let store_ok = match s.domain.object_store() {
        Ok(store) => store.healthy().await,
        Err(_) => true,
    };
    let status = if db_ok { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };
    reply(status, json!({"database": db_ok, "objectStore": store_ok, "domainId": s.domain.cfg.domain_id}))
}

async fn metrics(State(s): State<AppState>) -> impl IntoResponse {
    let _ = s.domain.refresh_gauges().await;
    ([(header::CONTENT_TYPE, "text/plain; version=0.0.4")], s.domain.metrics.render())
}
