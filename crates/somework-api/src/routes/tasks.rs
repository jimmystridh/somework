use std::time::Duration;

use axum::{
    Router,
    extract::{Path, Query, State},
    response::{
        IntoResponse,
        sse::{Event, KeepAlive, Sse},
    },
    routing::{get, post},
};
use futures::StreamExt;
use serde::Deserialize;
use serde_json::json;
use somework_domain::tasks::*;

use crate::{http::*, state::AppState};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/tasks", post(submit).get(list))
        .route("/v1/tasks/next", get(next))
        .route("/v1/tasks/{id}", get(get_task))
        .route("/v1/tasks/{id}/events", get(task_events))
        .route("/v1/tasks/{id}/tree", get(tree))
        .route("/v1/tasks/{id}/stream", get(stream))
        .route("/v1/tasks/{id}/claim", post(claim))
        .route("/v1/tasks/{id}/heartbeat", post(heartbeat))
        .route("/v1/tasks/{id}/progress", post(progress))
        .route("/v1/tasks/{id}/input", post(input))
        .route("/v1/tasks/{id}/complete", post(complete))
        .route("/v1/tasks/{id}/fail", post(fail))
        .route("/v1/tasks/{id}/cancel", post(cancel))
        .route("/v1/tasks/{id}/reconcile", post(reconcile))
        .route("/v1/approvals", get(list_approvals))
        .route("/v1/approvals/{id}", get(get_approval))
        .route("/v1/approvals/{id}/decision", post(decide))
}

async fn submit(State(s): State<AppState>, Auth(ctx): Auth, Body(req): Body<SubmitTask>) -> ApiResult {
    created(s.domain.submit_task(&ctx, req).await?)
}

async fn list(State(s): State<AppState>, Auth(ctx): Auth, Query(f): Query<TaskFilter>) -> ApiResult {
    ok(s.domain.list_tasks(&ctx, f).await?)
}

#[derive(Deserialize)]
struct NextQuery {
    wait: Option<u64>,
    limit: Option<i64>,
}

async fn next(State(s): State<AppState>, Auth(ctx): Auth, Query(q): Query<NextQuery>) -> ApiResult {
    ok(json!({"tasks": s.domain.next_tasks(&ctx, q.limit.unwrap_or(10), Duration::from_secs(q.wait.unwrap_or(0).min(30))).await?}))
}

async fn get_task(State(s): State<AppState>, Auth(ctx): Auth, Path(id): Path<String>) -> ApiResult {
    ok(s.domain.get_task(&ctx, &id).await?)
}

#[derive(Deserialize)]
struct EventsQuery {
    after: Option<i64>,
    limit: Option<i64>,
}

async fn task_events(State(s): State<AppState>, Auth(ctx): Auth, Path(id): Path<String>, Query(q): Query<EventsQuery>) -> ApiResult {
    ok(json!({"events": s.domain.list_task_events(&ctx, &id, q.after.unwrap_or(0), q.limit.unwrap_or(200)).await?}))
}

async fn tree(State(s): State<AppState>, Auth(ctx): Auth, Path(id): Path<String>) -> ApiResult {
    ok(s.domain.task_tree(&ctx, &id).await?)
}

/// SSE: current durable snapshot first, then live chunks (STR-02: a reconnecting consumer always recovers state).
async fn stream(State(s): State<AppState>, Auth(ctx): Auth, Path(id): Path<String>) -> Result<axum::response::Response, ApiError> {
    let snapshot = s.domain.get_task(&ctx, &id).await?;
    let live = match &s.streams {
        Some(source) => Some(source.subscribe(&id).await?),
        None => None,
    };
    let first =
        futures::stream::once(async move { Ok::<_, std::convert::Infallible>(Event::default().event("snapshot").json_data(snapshot).unwrap_or_default()) });
    let rest = futures::stream::iter(live)
        .flatten()
        .map(|chunk| Ok::<_, std::convert::Infallible>(Event::default().event("chunk").json_data(chunk).unwrap_or_default()));
    Ok(Sse::new(first.chain(rest)).keep_alive(KeepAlive::default()).into_response())
}

async fn claim(State(s): State<AppState>, Auth(ctx): Auth, Path(id): Path<String>, Body(req): Body<ClaimRequest>) -> ApiResult {
    ok(s.domain.claim_task(&ctx, &id, req).await?)
}

async fn heartbeat(State(s): State<AppState>, Auth(ctx): Auth, Path(id): Path<String>, Body(req): Body<HeartbeatRequest>) -> ApiResult {
    ok(s.domain.heartbeat_task(&ctx, &id, req).await?)
}

async fn progress(State(s): State<AppState>, Auth(ctx): Auth, Path(id): Path<String>, Body(req): Body<ProgressRequest>) -> ApiResult {
    ok(s.domain.progress_task(&ctx, &id, req).await?)
}

async fn input(State(s): State<AppState>, Auth(ctx): Auth, Path(id): Path<String>, Body(req): Body<InputRequest>) -> ApiResult {
    ok(s.domain.provide_input(&ctx, &id, req).await?)
}

async fn complete(State(s): State<AppState>, Auth(ctx): Auth, Path(id): Path<String>, Body(req): Body<CompleteRequest>) -> ApiResult {
    ok(s.domain.complete_task(&ctx, &id, req).await?)
}

async fn fail(State(s): State<AppState>, Auth(ctx): Auth, Path(id): Path<String>, Body(req): Body<FailRequest>) -> ApiResult {
    ok(s.domain.fail_task(&ctx, &id, req).await?)
}

async fn cancel(State(s): State<AppState>, Auth(ctx): Auth, Path(id): Path<String>, Body(req): Body<somework_domain::tasks::CancelRequest>) -> ApiResult {
    ok(s.domain.cancel_task(&ctx, &id, req).await?)
}

async fn reconcile(State(s): State<AppState>, Auth(ctx): Auth, Path(id): Path<String>, Body(req): Body<somework_domain::tasks::ReconcileRequest>) -> ApiResult {
    ok(s.domain.reconcile_task(&ctx, &id, req).await?)
}

#[derive(Deserialize)]
struct ApprovalQuery {
    status: Option<String>,
}

async fn list_approvals(State(s): State<AppState>, Auth(ctx): Auth, Query(q): Query<ApprovalQuery>) -> ApiResult {
    ok(json!({"approvals": s.domain.list_approvals(&ctx, q.status.as_deref()).await?}))
}

async fn get_approval(State(s): State<AppState>, Auth(ctx): Auth, Path(id): Path<String>) -> ApiResult {
    ok(s.domain.get_approval(&ctx, &id).await?)
}

async fn decide(State(s): State<AppState>, Auth(ctx): Auth, Path(id): Path<String>, Body(req): Body<somework_domain::tasks::DecideApproval>) -> ApiResult {
    ok(s.domain.decide_approval(&ctx, &id, req).await?)
}
