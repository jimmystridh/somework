//! A2A v1 server (HTTP+JSON binding). External agents are authenticated like any other principal and mapped onto a
//! tightly scoped internal principal; every request then goes through the normal domain authorization (an external
//! A2A request never bypasses local policy). Terminal tasks stay immutable: follow-ups become sibling tasks.

use std::{collections::HashMap, convert::Infallible, time::Duration};

use axum::{
    Json, Router,
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use somework_core::{
    Error, ErrorCode,
    canonical::sha256_hex,
    contracts::{Capability, CapabilityRef},
    trace::TraceContext,
};
use somework_domain::{
    Ctx, Domain,
    auth::AuthMeta,
    catalog::SearchRequest,
    db::{DbResultExt, scol},
    tasks::{CancelRequest, InputRequest, SubmitTask, TaskFilter, TaskView},
};

use super::model::*;
use crate::ingress::alias_for;

#[derive(Clone)]
pub struct A2aState {
    pub domain: Domain,
    /// Externally visible base URL of this interface, e.g. `https://host/a2a`.
    pub base_url: Option<String>,
    pub provider: Option<(String, String)>,
    pub blocking_wait: Duration,
}

pub struct A2aError {
    http: u16,
    status: &'static str,
    reason: &'static str,
    message: String,
}

impl A2aError {
    fn new(http: u16, status: &'static str, reason: &'static str, message: impl Into<String>) -> Self {
        Self { http, status, reason, message: message.into() }
    }
    fn invalid(message: impl Into<String>) -> Self {
        Self::new(400, "INVALID_ARGUMENT", "INVALID_PARAMS", message)
    }
    fn unsupported(message: impl Into<String>) -> Self {
        Self::new(400, "FAILED_PRECONDITION", "UNSUPPORTED_OPERATION", message)
    }
    fn task_not_found() -> Self {
        Self::new(404, "NOT_FOUND", "TASK_NOT_FOUND", "task not found")
    }
}

impl From<Error> for A2aError {
    fn from(e: Error) -> Self {
        match e.code {
            ErrorCode::Unauthenticated => Self::new(401, "UNAUTHENTICATED", "UNAUTHENTICATED", "authentication failed"),
            ErrorCode::NotFound => Self::task_not_found(),
            ErrorCode::PolicyDenied | ErrorCode::SenderMismatch => Self::new(403, "PERMISSION_DENIED", "PERMISSION_DENIED", "request not permitted"),
            ErrorCode::ValidationFailed | ErrorCode::SchemaViolation | ErrorCode::PayloadTooLarge => Self::invalid(e.message),
            ErrorCode::TaskTerminal | ErrorCode::InvalidTransition => Self::new(400, "FAILED_PRECONDITION", "TASK_NOT_CANCELABLE", e.message),
            ErrorCode::Unavailable | ErrorCode::PolicyUnavailable => Self::new(503, "UNAVAILABLE", "INTERNAL_ERROR", "temporarily unavailable"),
            _ => Self::new(500, "INTERNAL", "INTERNAL_ERROR", "internal error"),
        }
    }
}

impl IntoResponse for A2aError {
    fn into_response(self) -> Response {
        let mut r = (
            StatusCode::from_u16(self.http).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            Json(error_body(self.http, self.status, self.reason, &self.message)),
        )
            .into_response();
        if self.http == 401 {
            r.headers_mut().insert(header::WWW_AUTHENTICATE, "Bearer".parse().expect("static header"));
        }
        r
    }
}

type A2aResult = Result<Response, A2aError>;

fn json_ok(v: Value) -> A2aResult {
    let mut r = Json(v).into_response();
    r.headers_mut().insert(header::CONTENT_TYPE, "application/a2a+json".parse().expect("static header"));
    Ok(r)
}

pub fn router(state: A2aState) -> Router {
    let api = Router::new()
        .route("/message:send", post(send_message))
        .route("/message:stream", post(stream_message))
        .route("/tasks", get(list_tasks))
        .route("/tasks/{id}", get(task_get_or_subscribe).post(task_action))
        .route("/tasks/{id}/pushNotificationConfigs", post(push_unsupported).get(push_unsupported))
        .route("/tasks/{id}/pushNotificationConfigs/{push_id}", get(push_unsupported).delete(push_unsupported))
        .route("/extendedAgentCard", get(extended_card))
        .route("/agent-card:extended", get(extended_card))
        .route("/artifacts/{task_id}/{artifact_id}/{version}", get(artifact_content))
        .route("/.well-known/agent-card.json", get(public_card));
    Router::new().nest("/a2a", api.clone()).nest("/a2a/agents/{alias}", api).route("/.well-known/agent-card.json", get(public_card)).with_state(state)
}

fn version_check(headers: &HeaderMap) -> Result<(), A2aError> {
    match headers.get("a2a-version").and_then(|v| v.to_str().ok()) {
        None => Ok(()),
        Some(v) if v.trim().starts_with("1.0") => Ok(()),
        Some(v) => Err(A2aError::new(
            400,
            "FAILED_PRECONDITION",
            "VERSION_NOT_SUPPORTED",
            format!("protocol version {v} is not supported; this agent speaks {PROTOCOL_VERSION}"),
        )),
    }
}

async fn auth(state: &A2aState, headers: &HeaderMap) -> Result<Ctx, A2aError> {
    version_check(headers)?;
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(|| A2aError::from(Error::unauthenticated("missing bearer token")))?;
    let mut actor = state.domain.authenticate(token, &AuthMeta { transport: "a2a".into(), peer_cert_sha256: None }).await?;
    // external callers only ever see exported capabilities, whatever their principal could do internally
    actor.peer_domain = Some(A2A_PRINCIPAL_PEER.into());
    let trace =
        headers.get("traceparent").and_then(|v| v.to_str().ok()).and_then(TraceContext::parse).map(|t| t.child()).unwrap_or_else(TraceContext::new_root);
    Ok(Ctx::new(actor).with_trace(trace).with_transport("a2a"))
}

async fn alias_target(state: &A2aState, params: &HashMap<String, String>) -> Result<Option<String>, A2aError> {
    let Some(alias) = params.get("alias") else { return Ok(None) };
    let ids: Vec<String> =
        sqlx::query_scalar("SELECT agent_id FROM agents").fetch_all(state.domain.db.pool()).await.map_err(|e| Error::internal(e.to_string()))?;
    ids.into_iter().find(|id| &alias_for(state.domain.domain_id(), id) == alias).map(Some).ok_or_else(A2aError::task_not_found)
}

/// Base URL of the interface the caller reached: configured, or derived from the request's `Host`.
fn base_for(state: &A2aState, params: &HashMap<String, String>, headers: &HeaderMap) -> String {
    let root = match &state.base_url {
        Some(b) => b.trim_end_matches('/').to_string(),
        None => format!("http://{}/a2a", headers.get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("localhost")),
    };
    match params.get("alias") {
        Some(a) => format!("{root}/agents/{a}"),
        None => root,
    }
}

// ---- cards ---------------------------------------------------------------------------------------------------------

async fn public_caps(state: &A2aState, only_agent: Option<&str>) -> Result<Vec<Capability>, A2aError> {
    let rows = sqlx::query("SELECT a.agent_id, a.card, c.exported_capabilities FROM catalog_entries c JOIN agents a ON a.agent_id = c.agent_id WHERE c.approval_status = 'approved' AND c.visibility = 'public'")
        .fetch_all(state.domain.db.pool())
        .await
        .db()?;
    let mut out: Vec<Capability> = vec![];
    for r in rows {
        if only_agent.is_some_and(|a| a != scol(&r, "agent_id")) {
            continue;
        }
        let card: somework_core::contracts::AgentCard = serde_json::from_str(&scol(&r, "card")).map_err(|e| Error::internal(e.to_string()))?;
        let exported: Vec<String> = serde_json::from_str(&scol(&r, "exported_capabilities")).unwrap_or_default();
        out.extend(card.capabilities.into_iter().filter(|c| exported.contains(&c.id)));
    }
    Ok(out)
}

async fn public_card(State(s): State<A2aState>, headers: HeaderMap, params: Option<Path<HashMap<String, String>>>) -> A2aResult {
    version_check(&headers)?;
    let params = params.map(|p| p.0).unwrap_or_default();
    let target = alias_target(&s, &params).await?;
    let caps = public_caps(&s, target.as_deref()).await?;
    let name = format!("{} gateway", s.domain.cfg.display_name);
    let provider = s.provider.as_ref().map(|(o, u)| (o.as_str(), u.as_str()));
    json_ok(agent_card(CardInput {
        name: &name,
        description: "SomeWork domain gateway; authenticate to see the full set of skills you may invoke",
        base_url: &base_for(&s, &params, &headers),
        caps: &caps,
        provider,
    }))
}

async fn extended_card(State(s): State<A2aState>, headers: HeaderMap, params: Option<Path<HashMap<String, String>>>) -> A2aResult {
    let ctx = auth(&s, &headers).await?;
    let params = params.map(|p| p.0).unwrap_or_default();
    let target = alias_target(&s, &params).await?;
    let entries = s.domain.list_catalog(&ctx).await?;
    let mut caps: Vec<Capability> = vec![];
    for e in entries.into_iter().filter(|e| target.as_deref().is_none_or(|t| e.agent_card.agent_id == t)) {
        for c in e.agent_card.capabilities {
            if !caps.iter().any(|k| k.id == c.id && k.version == c.version) {
                caps.push(c);
            }
        }
    }
    let name = format!("{} gateway", s.domain.cfg.display_name);
    let provider = s.provider.as_ref().map(|(o, u)| (o.as_str(), u.as_str()));
    json_ok(agent_card(CardInput {
        name: &name,
        description: "Skills available to the authenticated caller",
        base_url: &base_for(&s, &params, &headers),
        caps: &caps,
        provider,
    }))
}

// ---- messages ------------------------------------------------------------------------------------------------------

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct SendRequest {
    message: Value,
    configuration: Value,
    metadata: Value,
}

struct Invocation {
    capability_id: Option<String>,
    capability_version: Option<String>,
    input: Value,
}

fn parse_capability(v: &Value) -> (Option<String>, Option<String>) {
    match v {
        Value::String(s) => (Some(s.clone()), None),
        Value::Object(o) => (o.get("id").and_then(Value::as_str).map(String::from), o.get("version").and_then(Value::as_str).map(String::from)),
        _ => (None, None),
    }
}

fn extract_invocation(req: &SendRequest) -> Result<Invocation, A2aError> {
    let msg = &req.message;
    if !msg.is_object() || msg["parts"].as_array().is_none_or(Vec::is_empty) {
        return Err(A2aError::invalid("message with at least one part is required"));
    }
    let mut cap_id = None;
    let mut cap_version = None;
    for source in [&msg["metadata"]["capability"], &msg["metadata"]["skillId"], &req.metadata["capability"], &req.metadata["skillId"]] {
        if !source.is_null() {
            (cap_id, cap_version) = parse_capability(source);
            break;
        }
    }
    let mut input = Value::Null;
    let mut text = vec![];
    for part in msg["parts"].as_array().cloned().unwrap_or_default() {
        if let Some(t) = part.get("text").and_then(Value::as_str) {
            text.push(t.to_string());
        }
        if let Some(d) = part.get("data").filter(|d| d.is_object()) {
            let mut d = d.clone();
            let obj = d.as_object_mut().expect("checked");
            for key in ["capability", "skillId"] {
                if let Some(v) = obj.remove(key)
                    && cap_id.is_none()
                {
                    (cap_id, cap_version) = parse_capability(&v);
                }
            }
            input = match obj.remove("input") {
                Some(i) => i,
                None => d,
            };
        }
    }
    if input.is_null() {
        input = if text.is_empty() { json!({}) } else { json!({"text": text.join("\n")}) };
    }
    Ok(Invocation { capability_id: cap_id, capability_version: cap_version, input })
}

async fn resolve_capability(state: &A2aState, ctx: &Ctx, inv: &Invocation, target: &Option<String>) -> Result<CapabilityRef, A2aError> {
    let id = match &inv.capability_id {
        Some(id) => id.clone(),
        None => {
            // an agent-scoped interface with exactly one skill needs no explicit selection
            let caps = state
                .domain
                .list_catalog(ctx)
                .await?
                .into_iter()
                .filter(|e| target.as_deref().is_none_or(|t| e.agent_card.agent_id == t))
                .flat_map(|e| e.agent_card.capabilities)
                .collect::<Vec<_>>();
            match caps.as_slice() {
                [only] => only.id.clone(),
                _ => return Err(A2aError::unsupported("no skill selected: set message.metadata.skillId (or a `skillId` key in a data part)")),
            }
        }
    };
    let found = state.domain.search_catalog(ctx, SearchRequest { required_capabilities: vec![id.clone()], limit: Some(50), ..Default::default() }).await?;
    for m in found.matches {
        if target.as_deref().is_some_and(|t| t != m.agent_id) {
            continue;
        }
        if let Some(c) = m.matched_capabilities.iter().find(|c| c.id == id && inv.capability_version.as_deref().is_none_or(|v| v == c.version)) {
            return Ok(c.clone());
        }
    }
    Err(A2aError::unsupported(format!("unknown skill {id}")))
}

async fn record_mapping(state: &A2aState, ctx: &Ctx, task: &TaskView, follow_up_of: Option<&str>, external_id: &str) {
    let now = state.domain.now_ts();
    let _ = sqlx::query("INSERT OR IGNORE INTO federated_tasks(internal_task_id, direction, peer_domain_id, external_task_id, external_context_id, remote_principal, protocol_version, follow_up_of, status, created_at, updated_at) VALUES (?, 'a2a_in', NULL, ?, ?, ?, ?, ?, 'open', ?, ?)")
        .bind(&task.task.task_id)
        .bind(external_id)
        .bind(&task.task.conversation_id)
        .bind(format!("{}:{}", ctx.actor.kind_str(), ctx.actor.id))
        .bind(PROTOCOL_VERSION)
        .bind(follow_up_of)
        .bind(&now)
        .bind(&now)
        .execute(state.domain.db.pool())
        .await;
}

async fn create_or_continue(state: &A2aState, ctx: &Ctx, params: &HashMap<String, String>, req: &SendRequest) -> Result<TaskView, A2aError> {
    let target = alias_target(state, params).await?;
    let message_id = req.message["messageId"].as_str().map(String::from).unwrap_or_else(somework_core::ids::message_id);
    let inv = extract_invocation(req)?;
    let context_id = req.message["contextId"].as_str().filter(|c| !c.is_empty()).map(String::from);

    if let Some(task_id) = req.message["taskId"].as_str().filter(|t| !t.is_empty()) {
        let existing = state.domain.get_task(ctx, task_id).await.map_err(|_| A2aError::task_not_found())?;
        if existing.task.state == somework_core::fsm::TaskState::InputRequired {
            return Ok(state.domain.provide_input(ctx, task_id, InputRequest { data: inv.input.clone(), expected_revision: None }).await?);
        }
        if !existing.task.state.is_terminal() {
            return Err(A2aError::unsupported("the task is still running; send follow-ups after it finishes or cancel it"));
        }
        // terminal tasks are immutable: the follow-up is a sibling task in the same conversation lineage
        let capability = match &inv.capability_id {
            Some(_) => resolve_capability(state, ctx, &inv, &target).await?,
            None => existing.task.capability.clone(),
        };
        let submit = SubmitTask {
            capability: Some(capability),
            target_agent_id: target,
            conversation_id: existing.task.conversation_id.clone(),
            input: Some(inv.input),
            idempotency_key: Some(format!("a2a:{}:{message_id}", ctx.actor.id)),
            ..Default::default()
        };
        let created = state.domain.submit_task(ctx, submit).await?.task;
        record_mapping(state, ctx, &created, Some(task_id), &message_id).await;
        return Ok(created);
    }

    let capability = resolve_capability(state, ctx, &inv, &target).await?;
    let conversation_id = match &context_id {
        Some(c) if state.domain.get_conversation(ctx, c).await.is_ok() => Some(c.clone()),
        _ => None,
    };
    let submit = SubmitTask {
        capability: Some(capability),
        target_agent_id: target,
        conversation_id,
        input: Some(inv.input),
        idempotency_key: Some(format!("a2a:{}:{message_id}", ctx.actor.id)),
        ..Default::default()
    };
    let created = state.domain.submit_task(ctx, submit).await?.task;
    record_mapping(state, ctx, &created, None, &message_id).await;
    Ok(created)
}

async fn wait_settled(state: &A2aState, ctx: &Ctx, task: TaskView) -> TaskView {
    let deadline = tokio::time::Instant::now() + state.blocking_wait;
    let mut current = task;
    while !current.task.state.is_terminal() && current.task.state != somework_core::fsm::TaskState::InputRequired && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
        match state.domain.get_task(ctx, &current.task.task_id).await {
            Ok(t) => current = t,
            Err(_) => break,
        }
    }
    current
}

async fn send_message(State(s): State<A2aState>, headers: HeaderMap, params: Option<Path<HashMap<String, String>>>, Json(req): Json<SendRequest>) -> A2aResult {
    let ctx = auth(&s, &headers).await?;
    let params = params.map(|p| p.0).unwrap_or_default();
    let mut task = create_or_continue(&s, &ctx, &params, &req).await?;
    let immediate = req.configuration["returnImmediately"].as_bool().unwrap_or(false);
    if !immediate {
        task = wait_settled(&s, &ctx, task).await;
    }
    json_ok(json!({"task": task_to_a2a(&task, &base_for(&s, &params, &headers))}))
}

fn sse_event(v: &Value) -> Event {
    Event::default().data(v.to_string())
}

fn task_stream(state: A2aState, ctx: Ctx, task_id: String, base: String, first: Option<TaskView>) -> impl futures::Stream<Item = Result<Event, Infallible>> {
    async_stream::stream! {
        let mut last: Option<(String, i64)> = None;
        let mut sent_artifacts = false;
        if let Some(t) = &first {
            yield Ok(sse_event(&json!({"task": task_to_a2a(t, &base)})));
            last = Some((t.task.state.as_str().to_string(), t.task.revision as i64));
            if t.task.state.is_terminal() { return; }
        }
        loop {
            tokio::time::sleep(Duration::from_millis(150)).await;
            let Ok(t) = state.domain.get_task(&ctx, &task_id).await else { break };
            let key = (t.task.state.as_str().to_string(), t.task.revision as i64);
            if last.as_ref() != Some(&key) {
                if t.task.state.is_terminal() && !sent_artifacts {
                    sent_artifacts = true;
                    for a in artifacts_of(&t, &base) {
                        yield Ok(sse_event(&json!({"artifactUpdate": {"taskId": t.task.task_id, "contextId": t.task.conversation_id.clone().unwrap_or_default(), "artifact": a, "lastChunk": true}})));
                    }
                }
                yield Ok(sse_event(&status_update(&t)));
                last = Some(key);
            }
            if t.task.state.is_terminal() { break; }
        }
    }
}

async fn stream_message(
    State(s): State<A2aState>,
    headers: HeaderMap,
    params: Option<Path<HashMap<String, String>>>,
    Json(req): Json<SendRequest>,
) -> A2aResult {
    let ctx = auth(&s, &headers).await?;
    let params = params.map(|p| p.0).unwrap_or_default();
    let task = create_or_continue(&s, &ctx, &params, &req).await?;
    let base = base_for(&s, &params, &headers);
    let id = task.task.task_id.clone();
    Ok(Sse::new(task_stream(s, ctx, id, base, Some(task))).keep_alive(KeepAlive::default()).into_response())
}

// ---- tasks ---------------------------------------------------------------------------------------------------------

async fn task_get_or_subscribe(State(s): State<A2aState>, headers: HeaderMap, Path(params): Path<HashMap<String, String>>) -> A2aResult {
    let ctx = auth(&s, &headers).await?;
    let raw = params.get("id").cloned().unwrap_or_default();
    let base = base_for(&s, &params, &headers);
    if let Some(id) = raw.strip_suffix(":subscribe") {
        let task = s.domain.get_task(&ctx, id).await.map_err(|_| A2aError::task_not_found())?;
        if task.task.state.is_terminal() {
            return Err(A2aError::unsupported("the task is in a terminal state; there is nothing to subscribe to"));
        }
        let id = id.to_string();
        return Ok(Sse::new(task_stream(s, ctx, id, base, Some(task))).keep_alive(KeepAlive::default()).into_response());
    }
    let task = s.domain.get_task(&ctx, &raw).await.map_err(|_| A2aError::task_not_found())?;
    json_ok(task_to_a2a(&task, &base))
}

async fn task_action(State(s): State<A2aState>, headers: HeaderMap, Path(params): Path<HashMap<String, String>>) -> A2aResult {
    let ctx = auth(&s, &headers).await?;
    let raw = params.get("id").cloned().unwrap_or_default();
    let base = base_for(&s, &params, &headers);
    if let Some(id) = raw.strip_suffix(":cancel") {
        let task = s.domain.cancel_task(&ctx, id, CancelRequest { reason: Some("canceled by A2A client".into()), ..Default::default() }).await?;
        return json_ok(task_to_a2a(&task, &base));
    }
    if let Some(id) = raw.strip_suffix(":subscribe") {
        let task = s.domain.get_task(&ctx, id).await.map_err(|_| A2aError::task_not_found())?;
        let id = id.to_string();
        return Ok(Sse::new(task_stream(s, ctx, id, base, Some(task))).keep_alive(KeepAlive::default()).into_response());
    }
    Err(A2aError::new(404, "NOT_FOUND", "METHOD_NOT_FOUND", "unknown task action"))
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct ListQuery {
    context_id: Option<String>,
    status: Option<String>,
    page_size: Option<i64>,
    page_token: Option<String>,
}

async fn list_tasks(State(s): State<A2aState>, headers: HeaderMap, params: Option<Path<HashMap<String, String>>>, Query(q): Query<ListQuery>) -> A2aResult {
    let params = params.map(|p| p.0).unwrap_or_default();
    let ctx = auth(&s, &headers).await?;
    let base = base_for(&s, &params, &headers);
    let listed = s
        .domain
        .list_tasks(
            &ctx,
            TaskFilter {
                conversation_id: q.context_id.clone(),
                cursor: q.page_token.clone(),
                limit: Some(q.page_size.unwrap_or(50).clamp(1, 100)),
                ..Default::default()
            },
        )
        .await?;
    let mut tasks = vec![];
    for t in &listed.tasks {
        let mapped: Option<i64> = sqlx::query_scalar("SELECT 1 FROM federated_tasks WHERE internal_task_id = ? AND direction = 'a2a_in'")
            .bind(&t.task.task_id)
            .fetch_optional(s.domain.db.pool())
            .await
            .db()
            .map_err(A2aError::from)?;
        if mapped.is_none() {
            continue;
        }
        let a = task_to_a2a(t, &base);
        if q.status.as_deref().is_none_or(|st| a["status"]["state"] == st) {
            tasks.push(a);
        }
    }
    let total = tasks.len();
    json_ok(json!({"tasks": tasks, "nextPageToken": listed.next_cursor.unwrap_or_default(), "pageSize": tasks.len(), "totalSize": total}))
}

async fn push_unsupported() -> A2aResult {
    Err(A2aError::new(
        400,
        "FAILED_PRECONDITION",
        "PUSH_NOTIFICATION_NOT_SUPPORTED",
        "push notifications are not supported by this gateway; use streaming or polling",
    ))
}

/// Artifact bytes are served through the gateway behind the same authentication; no object-store URL leaves the domain.
async fn artifact_content(State(s): State<A2aState>, headers: HeaderMap, Path(params): Path<HashMap<String, String>>) -> A2aResult {
    let ctx = auth(&s, &headers).await?;
    let (task_id, artifact_id) = (params.get("task_id").cloned().unwrap_or_default(), params.get("artifact_id").cloned().unwrap_or_default());
    let version: u64 = params.get("version").and_then(|v| v.parse().ok()).unwrap_or(1);
    let task = s.domain.get_task(&ctx, &task_id).await.map_err(|_| A2aError::task_not_found())?;
    if !task.task.result_artifacts.iter().any(|a| a.artifact_id == artifact_id && a.version == version) {
        return Err(A2aError::task_not_found());
    }
    let grant = s
        .domain
        .artifact_download_grant(&ctx, &artifact_id, version, somework_domain::artifacts::DownloadRequest { task_id: Some(task_id), fencing_token: None })
        .await?;
    let bytes = reqwest::get(&grant.url).await.map_err(|e| Error::unavailable(e.to_string()))?.bytes().await.map_err(|e| Error::unavailable(e.to_string()))?;
    if sha256_hex(&bytes) != grant.artifact.digest.value {
        return Err(Error::new(ErrorCode::IntegrityFailure, "stored artifact does not match its digest").into());
    }
    let mut r = Response::new(Body::from(bytes));
    r.headers_mut().insert(header::CONTENT_TYPE, grant.artifact.media_type.parse().unwrap_or("application/octet-stream".parse().expect("static")));
    Ok(r)
}
