use axum::{
    Router,
    extract::{Path, Query, State},
    routing::{get, patch, post},
};
use serde::Deserialize;
use serde_json::json;
use somework_domain::{
    auth::CreatePrincipal,
    policy::{Permissions, PolicyDocument},
    tasks::TaskFilter,
};

use crate::{http::*, state::AppState};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/admin/principals", post(create_principal).get(list_principals))
        .route("/v1/admin/principals/{kind}/{id}", patch(update_principal))
        .route("/v1/admin/policy", get(get_policy).put(put_policy))
        .route("/v1/admin/audit", get(audit))
        .route("/v1/admin/audit/verify", get(verify_audit))
        .route("/v1/admin/events", get(all_events))
        .route("/v1/admin/messages", get(audit_messages))
        .route("/v1/admin/tasks", get(all_tasks))
        .route("/v1/admin/outbox", get(outbox))
        .route("/v1/admin/outbox/requeue", post(requeue))
        .route("/v1/admin/maintenance", post(maintenance))
        .route("/v1/admin/signing-keys/rotate", post(rotate))
        .route("/v1/admin/overview", get(overview))
        .route("/v1/admin/whoami", get(whoami))
        .route("/v1/admin/failpoints", post(failpoints))
}

async fn create_principal(State(s): State<AppState>, Auth(ctx): Auth, Body(req): Body<CreatePrincipal>) -> ApiResult {
    created(s.domain.create_principal(&ctx, req).await?)
}

async fn list_principals(State(s): State<AppState>, Auth(ctx): Auth) -> ApiResult {
    ok(json!({"principals": s.domain.list_principals(&ctx).await?}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdatePrincipal {
    permissions: Option<Permissions>,
    status: Option<String>,
    public_key: Option<String>,
}

async fn update_principal(State(s): State<AppState>, Auth(ctx): Auth, Path((kind, id)): Path<(String, String)>, Body(b): Body<UpdatePrincipal>) -> ApiResult {
    let kind = somework_domain::domain::parse_kind(&kind).ok_or_else(|| somework_core::Error::invalid("unknown principal kind"))?;
    ok(s.domain.update_principal(&ctx, kind, &id, b.permissions, b.status, b.public_key).await?)
}

async fn get_policy(State(s): State<AppState>, Auth(ctx): Auth) -> ApiResult {
    ok(s.domain.get_policy(&ctx).await?)
}

async fn put_policy(State(s): State<AppState>, Auth(ctx): Auth, Body(doc): Body<PolicyDocument>) -> ApiResult {
    ok(s.domain.put_policy(&ctx, doc).await?)
}

#[derive(Deserialize)]
struct AuditQuery {
    #[serde(rename = "taskId")]
    task_id: Option<String>,
    after: Option<i64>,
    limit: Option<i64>,
}

async fn audit(State(s): State<AppState>, Auth(ctx): Auth, Query(q): Query<AuditQuery>) -> ApiResult {
    ok(json!({"events": s.domain.list_audit(&ctx, q.task_id.as_deref(), q.after.unwrap_or(0), q.limit.unwrap_or(200)).await?}))
}

async fn verify_audit(State(s): State<AppState>, Auth(ctx): Auth) -> ApiResult {
    s.domain.enforce_read(&ctx, somework_domain::policy::AuthzRequest::new("audit.read")).await?;
    let broken = s.domain.verify_audit_chain().await?;
    ok(json!({"intact": broken.is_none(), "firstBrokenSeq": broken}))
}

#[derive(Deserialize)]
struct AllEventsQuery {
    #[serde(rename = "taskId")]
    task_id: Option<String>,
    after: Option<i64>,
    limit: Option<i64>,
}

async fn all_events(State(s): State<AppState>, Auth(ctx): Auth, Query(q): Query<AllEventsQuery>) -> ApiResult {
    ok(json!({"events": s.domain.list_all_events(&ctx, q.task_id.as_deref(), q.after.unwrap_or(0), q.limit.unwrap_or(200)).await?}))
}

#[derive(Deserialize)]
struct MessagesQuery {
    #[serde(rename = "conversationId")]
    conversation_id: Option<String>,
    #[serde(rename = "taskId")]
    task_id: Option<String>,
    limit: Option<i64>,
}

async fn audit_messages(State(s): State<AppState>, Auth(ctx): Auth, Query(q): Query<MessagesQuery>) -> ApiResult {
    ok(json!({"messages": s.domain.audit_messages(&ctx, q.conversation_id.as_deref(), q.task_id.as_deref(), q.limit.unwrap_or(200)).await?}))
}

async fn all_tasks(State(s): State<AppState>, Auth(ctx): Auth, Query(mut f): Query<TaskFilter>) -> ApiResult {
    f.all = Some(true);
    ok(s.domain.list_tasks(&ctx, f).await?)
}

async fn outbox(State(s): State<AppState>, Auth(ctx): Auth) -> ApiResult {
    s.domain.enforce_read(&ctx, somework_domain::policy::AuthzRequest::new("ops.read")).await?;
    ok(json!({"sinks": s.domain.outbox_stats().await?}))
}

#[derive(Deserialize)]
struct RequeueBody {
    sink: String,
}

async fn requeue(State(s): State<AppState>, Auth(ctx): Auth, Body(b): Body<RequeueBody>) -> ApiResult {
    s.domain.enforce_read(&ctx, somework_domain::policy::AuthzRequest::new("ops.read")).await?;
    ok(json!({"requeued": s.domain.outbox_requeue_dead(&b.sink).await?}))
}

async fn maintenance(State(s): State<AppState>, Auth(ctx): Auth) -> ApiResult {
    s.domain.enforce_read(&ctx, somework_domain::policy::AuthzRequest::new("ops.read")).await?;
    ok(s.domain.run_maintenance().await?)
}

async fn rotate(State(s): State<AppState>, Auth(ctx): Auth) -> ApiResult {
    s.domain.enforce_read(&ctx, somework_domain::policy::AuthzRequest::new("domain.admin")).await?;
    ok(json!({"kid": s.domain.rotate_signing_key().await?}))
}

async fn overview(State(s): State<AppState>, Auth(ctx): Auth) -> ApiResult {
    ok(s.domain.overview(&ctx).await?)
}

async fn whoami(Auth(ctx): Auth) -> ApiResult {
    ok(
        json!({"actor": ctx.actor.actor_ref(), "principalId": ctx.actor.principal_id, "roles": ctx.actor.permissions.roles, "actions": ctx.actor.permissions.actions, "runtimeInstanceId": ctx.actor.runtime_instance_id}),
    )
}

#[derive(Deserialize)]
struct FailpointBody {
    spec: String,
}

/// Chaos-test hook; only available when the server was started with `--allow-failpoint-admin`.
async fn failpoints(State(s): State<AppState>, Auth(ctx): Auth, Body(b): Body<FailpointBody>) -> ApiResult {
    if !s.allow_failpoint_admin {
        return Err(somework_core::Error::not_found("failpoint admin").into());
    }
    s.domain.enforce_read(&ctx, somework_domain::policy::AuthzRequest::new("domain.admin")).await?;
    if b.spec.trim().is_empty() {
        s.domain.failpoints.clear();
    } else {
        s.domain.failpoints.arm_from_spec(&b.spec);
    }
    ok(json!({"armed": b.spec}))
}
