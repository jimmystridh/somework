use axum::{
    Router,
    extract::{Path, State},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::json;
use somework_domain::{
    auth::DelegateGrant,
    catalog::{ApproveEntry, RegisterAgent, SearchRequest},
};

use crate::{http::*, state::AppState};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/catalog/search", post(search))
        .route("/v1/catalog/entries", get(list))
        .route("/v1/agents/{agent_id}", get(get_agent).put(register_agent))
        .route("/v1/agents/{agent_id}/approval", post(approve))
        .route("/v1/capabilities/{id}/{version}", get(get_capability))
        .route("/v1/authorizations/delegate", post(delegate))
}

async fn search(State(s): State<AppState>, Auth(ctx): Auth, Body(req): Body<SearchRequest>) -> ApiResult {
    ok(s.domain.search_catalog(&ctx, req).await?)
}

async fn list(State(s): State<AppState>, Auth(ctx): Auth) -> ApiResult {
    ok(json!({"entries": s.domain.list_catalog(&ctx).await?}))
}

async fn get_agent(State(s): State<AppState>, Auth(ctx): Auth, Path(agent_id): Path<String>) -> ApiResult {
    ok(s.domain.get_agent(&ctx, &agent_id).await?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterBody {
    card: Option<serde_json::Value>,
    visibility: Option<somework_core::contracts::Visibility>,
    source: Option<somework_core::contracts::Source>,
}

async fn register_agent(State(s): State<AppState>, Auth(ctx): Auth, Path(agent_id): Path<String>, Body(body): Body<serde_json::Value>) -> ApiResult {
    // accept either {"card": {...}, "visibility": ...} or a bare AgentCard
    let (card, visibility, source) = if body.get("card").is_some() {
        let b: RegisterBody = serde_json::from_value(body).map_err(somework_core::Error::from)?;
        (b.card.unwrap_or_default(), b.visibility, b.source)
    } else {
        (body, None, None)
    };
    if card.get("agentId").and_then(|v| v.as_str()) != Some(agent_id.as_str()) {
        return Err(somework_core::Error::invalid("the card's agentId must match the URL").into());
    }
    ok(s.domain.register_agent(&ctx, RegisterAgent { card, visibility, source }).await?)
}

async fn approve(State(s): State<AppState>, Auth(ctx): Auth, Path(agent_id): Path<String>, Body(body): Body<ApproveEntry>) -> ApiResult {
    ok(s.domain.approve_entry(&ctx, &agent_id, body).await?)
}

async fn get_capability(State(s): State<AppState>, Auth(ctx): Auth, Path((id, version)): Path<(String, String)>) -> ApiResult {
    ok(s.domain.get_capability(&ctx, &id, &version).await?)
}

async fn delegate(State(s): State<AppState>, Auth(ctx): Auth, Body(body): Body<DelegateGrant>) -> ApiResult {
    created(s.domain.delegate_grant(&ctx, body).await?)
}
