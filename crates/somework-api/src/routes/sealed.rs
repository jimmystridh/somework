use axum::{
    Router,
    extract::{Path, State},
    routing::{get, post},
};
use serde_json::json;
use somework_domain::sealed::SealRequest;

use crate::{http::*, state::AppState};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/sealed", post(seal).get(pending))
        .route("/v1/sealed/{id}/open", post(unseal))
        .route("/v1/sealed/recipients/{kind}/{id}/key", get(recipient_key))
}

async fn seal(State(s): State<AppState>, Auth(ctx): Auth, Body(req): Body<SealRequest>) -> ApiResult {
    created(s.domain.seal_secret(&ctx, req).await?)
}

async fn pending(State(s): State<AppState>, Auth(ctx): Auth) -> ApiResult {
    ok(json!({"secrets": s.domain.list_sealed_pending(&ctx).await?}))
}

/// POST (not GET): reading consumes the secret.
async fn unseal(State(s): State<AppState>, Auth(ctx): Auth, Path(id): Path<String>) -> ApiResult {
    ok(s.domain.unseal_secret(&ctx, &id).await?)
}

async fn recipient_key(State(s): State<AppState>, Auth(ctx): Auth, Path((kind, id)): Path<(String, String)>) -> ApiResult {
    let kind = somework_domain::domain::parse_kind(&kind).ok_or_else(|| somework_core::Error::invalid("unknown principal kind"))?;
    ok(json!({"publicKey": s.domain.principal_public_key(&ctx, kind, &id).await?}))
}
