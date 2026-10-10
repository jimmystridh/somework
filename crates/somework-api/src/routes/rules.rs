use axum::{
    Router,
    extract::{Path, State},
    routing::{get, post},
};
use serde_json::json;
use somework_domain::rules::RuleSpec;

use crate::{http::*, state::AppState};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/rules", get(list))
        .route("/v1/rules/{name}", get(fetch).put(put).delete(remove))
        .route("/v1/rules/{name}/pause", post(pause))
        .route("/v1/rules/{name}/resume", post(resume))
}

async fn list(State(s): State<AppState>, Auth(ctx): Auth) -> ApiResult {
    ok(json!({"rules": s.domain.list_rules(&ctx).await?}))
}

async fn fetch(State(s): State<AppState>, Auth(ctx): Auth, Path(name): Path<String>) -> ApiResult {
    ok(s.domain.get_rule(&ctx, &name).await?)
}

async fn put(State(s): State<AppState>, Auth(ctx): Auth, Path(name): Path<String>, Body(spec): Body<RuleSpec>) -> ApiResult {
    let (rule, was_created) = s.domain.put_rule(&ctx, &name, spec).await?;
    if was_created { created(rule) } else { ok(rule) }
}

async fn remove(State(s): State<AppState>, Auth(ctx): Auth, Path(name): Path<String>) -> ApiResult {
    s.domain.delete_rule(&ctx, &name).await?;
    no_content()
}

async fn pause(State(s): State<AppState>, Auth(ctx): Auth, Path(name): Path<String>) -> ApiResult {
    ok(s.domain.set_rule_status(&ctx, &name, "paused").await?)
}

async fn resume(State(s): State<AppState>, Auth(ctx): Auth, Path(name): Path<String>) -> ApiResult {
    ok(s.domain.set_rule_status(&ctx, &name, "active").await?)
}
