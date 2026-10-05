use axum::{
    Router,
    extract::{Query, State},
    routing::{delete, post},
};
use serde::Deserialize;
use serde_json::json;
use somework_domain::runtimes::RegisterRuntime;

use crate::{http::*, state::AppState};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/connection", axum::routing::get(connection))
        .route("/v1/runtimes", post(register).get(list))
        .route("/v1/runtimes/heartbeat", post(heartbeat))
        .route("/v1/runtimes/self", delete(end))
}

async fn register(State(s): State<AppState>, Auth(ctx): Auth, Body(req): Body<RegisterRuntime>) -> ApiResult {
    created(s.domain.register_runtime(&ctx, req).await?)
}

async fn heartbeat(State(s): State<AppState>, Auth(ctx): Auth) -> ApiResult {
    ok(s.domain.runtime_heartbeat(&ctx).await?)
}

async fn end(State(s): State<AppState>, Auth(ctx): Auth) -> ApiResult {
    s.domain.end_runtime(&ctx).await?;
    no_content()
}

#[derive(Deserialize)]
struct ListQuery {
    #[serde(rename = "agentId")]
    agent_id: Option<String>,
}

async fn list(State(s): State<AppState>, Auth(ctx): Auth, Query(q): Query<ListQuery>) -> ApiResult {
    ok(json!({"runtimes": s.domain.list_runtimes(&ctx, q.agent_id.as_deref()).await?}))
}

/// `GET /v1/connection`: transport endpoints and scoped credentials for the caller (outbound-only connectivity).
async fn connection(State(s): State<AppState>, Auth(ctx): Auth) -> ApiResult {
    match &s.connection {
        Some(provider) => ok(provider.connection_info(&ctx).await?),
        None => ok(json!({"nats": null, "pollOnly": true})),
    }
}
