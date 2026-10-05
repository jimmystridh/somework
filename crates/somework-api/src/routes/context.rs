use axum::{
    Router,
    extract::{Path, Query, State},
    routing::{get, post},
};
use serde::Deserialize;
use somework_domain::context::{AcceptRequest, OfferRequest};

use crate::{http::*, state::AppState};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/context-packs", post(create))
        .route("/v1/context-packs/{id}/{version}", get(get_pack))
        .route("/v1/context-packs/{id}/{version}/offer", post(offer))
        .route("/v1/context-packs/{id}/{version}/accept", post(accept))
        .route("/v1/context-offers/{id}", get(get_offer))
        .route("/v1/context-offers/{id}/decline", post(decline))
}

async fn create(State(s): State<AppState>, Auth(ctx): Auth, Body(pack): Body<serde_json::Value>) -> ApiResult {
    created(s.domain.create_context_pack(&ctx, pack).await?)
}

#[derive(Deserialize)]
struct GetQuery {
    /// Comma separated section names; omitted returns the manifest view.
    sections: Option<String>,
    #[serde(rename = "taskId")]
    task_id: Option<String>,
}

async fn get_pack(State(s): State<AppState>, Auth(ctx): Auth, Path((id, version)): Path<(String, u64)>, Query(q): Query<GetQuery>) -> ApiResult {
    let sections = q.sections.map(|s| s.split(',').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect::<Vec<_>>());
    ok(s.domain.get_context_pack(&ctx, &id, version, sections, q.task_id.as_deref()).await?)
}

async fn offer(State(s): State<AppState>, Auth(ctx): Auth, Path((id, version)): Path<(String, u64)>, Body(req): Body<OfferRequest>) -> ApiResult {
    created(s.domain.offer_context(&ctx, &id, version, req).await?)
}

async fn accept(State(s): State<AppState>, Auth(ctx): Auth, Path((id, version)): Path<(String, u64)>, Body(req): Body<AcceptRequest>) -> ApiResult {
    ok(s.domain.accept_context(&ctx, &id, version, req).await?)
}

async fn get_offer(State(s): State<AppState>, Auth(ctx): Auth, Path(id): Path<String>) -> ApiResult {
    ok(s.domain.get_offer(&ctx, &id).await?)
}

async fn decline(State(s): State<AppState>, Auth(ctx): Auth, Path(id): Path<String>) -> ApiResult {
    ok(s.domain.decline_offer(&ctx, &id).await?)
}
