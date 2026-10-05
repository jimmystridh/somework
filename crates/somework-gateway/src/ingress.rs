//! Federation ingress: what a peer domain can ask of this domain. Every route authenticates twice (pinned mTLS
//! certificate + single-use signed grant), maps the peer to its scoped gateway principal and then lets the domain core
//! make the authorization decision. Hidden and nonexistent capabilities are indistinguishable.

use std::{convert::Infallible, time::Duration};

use axum::{
    Extension, Json, Router,
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
    contracts::{Action, ActorKind, ArtifactRef, ContextRef},
    trace::TraceContext,
};
use somework_domain::{
    Ctx, Domain,
    artifacts::DownloadRequest,
    catalog::SearchRequest,
    db::DbResultExt,
    tasks::{CancelRequest, SubmitTask, TaskView},
};

use crate::{
    disclosure::{pack_from_peer, peer_state, redact_keys},
    grants::verify_grant,
    peers::{GATEWAY_PRINCIPAL_PREFIX, PeerRecord, Peers},
    tls::PeerCert,
};

#[derive(Clone)]
pub struct IngressState {
    pub domain: Domain,
    pub peers: Peers,
}

pub fn router(state: IngressState) -> Router {
    Router::new()
        .route("/federation/v1/catalog/search", post(search))
        .route("/federation/v1/tasks", post(submit))
        .route("/federation/v1/tasks/{id}", get(get_task))
        .route("/federation/v1/tasks/{id}/events", get(events))
        .route("/federation/v1/tasks/{id}/cancel", post(cancel))
        .route("/federation/v1/tasks/{id}/artifacts/{artifact_id}/{version}", get(artifact))
        .with_state(state)
}

pub struct Fed {
    pub peer: PeerRecord,
    pub ctx: Ctx,
    pub task_id: Option<String>,
}

pub struct FedError(pub Error);

impl From<Error> for FedError {
    fn from(e: Error) -> Self {
        FedError(e)
    }
}

impl From<serde_json::Error> for FedError {
    fn from(e: serde_json::Error) -> Self {
        FedError(Error::from(e))
    }
}

impl IntoResponse for FedError {
    fn into_response(self) -> Response {
        // deliberately terse: peers learn the class of failure, never internals
        let (status, code, message) = match self.0.code {
            ErrorCode::Unauthenticated => (StatusCode::UNAUTHORIZED, "unauthenticated", "authentication failed".to_string()),
            ErrorCode::NotFound => (StatusCode::NOT_FOUND, "not_found", "not found".to_string()),
            ErrorCode::PolicyDenied | ErrorCode::SenderMismatch => (StatusCode::FORBIDDEN, "forbidden", "request not permitted".to_string()),
            ErrorCode::Internal => (StatusCode::INTERNAL_SERVER_ERROR, "internal", "internal error".to_string()),
            ErrorCode::Unavailable | ErrorCode::PolicyUnavailable => (StatusCode::SERVICE_UNAVAILABLE, "unavailable", "temporarily unavailable".to_string()),
            other => (StatusCode::from_u16(other.status()).unwrap_or(StatusCode::BAD_REQUEST), other.as_str(), self.0.message.clone()),
        };
        (status, Json(json!({"error": {"code": code, "message": message}}))).into_response()
    }
}

type FedResult = Result<Response, FedError>;

fn json_response(status: StatusCode, body: Value) -> FedResult {
    Ok((status, Json(body)).into_response())
}

async fn authenticate(state: &IngressState, cert: &PeerCert, headers: &HeaderMap, required: Action, task_id: Option<&str>) -> Result<Fed, FedError> {
    let unauth = || FedError(Error::unauthenticated("authentication failed"));
    let thumb = cert.0.as_deref().ok_or_else(unauth)?;
    let peer = state.peers.by_thumbprint(thumb).await?.filter(PeerRecord::is_active).ok_or_else(unauth)?;
    let token = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).ok_or_else(unauth)?;
    let claims = verify_grant(&state.domain, &peer, token, thumb, required).await?;
    if let Some(expected) = task_id
        && claims.task_id.as_deref() != Some(expected)
    {
        return Err(unauth());
    }
    let mut conn = state.domain.db.pool().acquire().await.db()?;
    let principal = state
        .domain
        .principal_by_label(&mut conn, ActorKind::Service, &format!("{GATEWAY_PRINCIPAL_PREFIX}{}", peer.peer_domain_id))
        .await?
        .filter(|p| p.status == "active")
        .ok_or_else(unauth)?;
    let policy = state.domain.active_policy(&mut conn).await?;
    let mut actor = state.domain.actor_for_principal(&principal, Some(peer.peer_domain_id.clone())).await;
    actor.permissions = principal.permissions.narrowed_by(&claims, &policy.scale());
    actor.grant_jti = Some(claims.jti.clone());
    let trace =
        headers.get("traceparent").and_then(|v| v.to_str().ok()).and_then(TraceContext::parse).map(|t| t.child()).unwrap_or_else(TraceContext::new_root);
    let ctx = Ctx::new(actor).with_trace(trace).with_transport("gateway").with_transport_event(claims.jti.clone());
    Ok(Fed { peer, ctx, task_id: claims.task_id.clone() })
}

/// Stable opaque name for an exported agent; the real agent id (the fleet's structure) never leaves the domain.
pub fn alias_for(local_domain: &str, agent_id: &str) -> String {
    format!("export-{}", &sha256_hex(format!("{local_domain}|{agent_id}").as_bytes())[..16])
}

async fn search(State(s): State<IngressState>, Extension(cert): Extension<PeerCert>, headers: HeaderMap, Json(req): Json<SearchRequest>) -> FedResult {
    let fed = authenticate(&s, &cert, &headers, Action::CatalogRead, None).await?;
    let result = s.domain.search_catalog(&fed.ctx, req).await?;
    let mut matches = vec![];
    let mut cards = vec![];
    for m in result.matches {
        let mut entry = s.domain.get_agent(&fed.ctx, &m.agent_id).await?;
        let alias = alias_for(s.domain.domain_id(), &m.agent_id);
        entry.entry_id = alias.clone();
        entry.agent_card.agent_id = alias.clone();
        entry.agent_card.display_name = alias.clone();
        entry.agent_card.description = entry.agent_card.capabilities.iter().map(|c| c.name.clone()).collect::<Vec<_>>().join(", ");
        entry.availability.active_instances = None;
        entry.availability.queue_depth = None;
        entry.availability.observed_at = None;
        entry.approval.policy_version = None;
        matches.push(json!({"alias": alias, "domainId": s.domain.domain_id(), "score": m.score, "availability": m.availability, "matchedCapabilities": m.matched_capabilities}));
        cards.push(serde_json::to_value(entry)?);
    }
    json_response(StatusCode::OK, json!({"matches": matches, "cards": cards}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FederatedSubmit {
    capability: somework_core::contracts::CapabilityRef,
    #[serde(default)]
    input: Value,
    #[serde(default)]
    context_pack: Option<Value>,
    #[serde(default)]
    deadline_at: Option<String>,
    #[serde(default)]
    origin_task_id: Option<String>,
}

async fn submit(State(s): State<IngressState>, Extension(cert): Extension<PeerCert>, headers: HeaderMap, Json(req): Json<FederatedSubmit>) -> FedResult {
    let mut fed = authenticate(&s, &cert, &headers, Action::TaskSubmit, None).await?;
    let origin = req.origin_task_id.clone().or_else(|| fed.task_id.clone()).ok_or_else(|| FedError(Error::invalid("originTaskId is required")))?;
    fed.ctx.idempotency_key = Some(format!("fed:{}:{origin}", fed.peer.peer_domain_id));

    let mut context_refs = vec![];
    if let Some(pack) = &req.context_pack {
        let policy = {
            let mut conn = s.domain.db.pool().acquire().await.db()?;
            s.domain.active_policy(&mut conn).await?
        };
        let mut inbound = pack_from_peer(pack, &fed.peer, &policy.scale(), s.domain.domain_id())
            .ok_or_else(|| FedError(Error::denied("context pack is not acceptable from this peer")))?;
        let remote_id = inbound["contextPackId"].as_str().unwrap_or_default().to_string();
        inbound["contextPackId"] = json!(format!("fed-{}-{remote_id}", fed.peer.peer_domain_id));
        inbound["version"] = json!(1);
        inbound.as_object_mut().map(|o| o.remove("digest"));
        inbound.as_object_mut().map(|o| o.remove("base"));
        let id = inbound["contextPackId"].as_str().unwrap_or_default().to_string();
        match s.domain.create_context_pack(&fed.ctx, inbound).await {
            Ok(_) => {}
            Err(e) if e.code == ErrorCode::Conflict => {}
            Err(e) => return Err(e.into()),
        }
        context_refs.push(ContextRef { context_pack_id: id, version: 1, sections: Some(fed.peer.policy.context_sections.clone()) });
    }

    let submit = SubmitTask {
        capability: Some(req.capability.clone()),
        input: Some(req.input.clone()),
        context_refs,
        deadline_at: req.deadline_at.clone(),
        idempotency_key: None,
        constraints: Some(json!({"sideEffectsAtMost": fed.peer.policy.side_effects_at_most.as_str()})),
        ..Default::default()
    };
    let response = s.domain.submit_task(&fed.ctx, submit).await?;
    let task = &response.task.task;
    sqlx::query("INSERT OR IGNORE INTO federated_tasks(internal_task_id, direction, peer_domain_id, external_task_id, remote_principal, protocol_version, status, created_at, updated_at) VALUES (?, 'ingress', ?, ?, ?, 'somework-federation/1', 'open', ?, ?)")
        .bind(&task.task_id)
        .bind(&fed.peer.peer_domain_id)
        .bind(&origin)
        .bind(fed.peer.principal_id())
        .bind(s.domain.now_ts())
        .bind(s.domain.now_ts())
        .execute(s.domain.db.writer())
        .await
        .db()?;
    json_response(StatusCode::CREATED, json!({"taskId": task.task_id, "state": peer_state(task.state.as_str()), "revision": task.revision}))
}

fn artifacts_for_peer(task: &TaskView, peer: &PeerRecord) -> Vec<Value> {
    if !peer.policy.allow_artifacts {
        return vec![];
    }
    let scale = somework_core::classification::ClassificationScale::default();
    let max = peer.classification_max();
    task.task
        .result_artifacts
        .iter()
        .filter(|a| scale.permits(&max, &a.classification))
        .map(|a: &ArtifactRef| json!({"artifactId": a.artifact_id, "version": a.version, "filename": a.filename, "mediaType": a.media_type, "sizeBytes": a.size_bytes, "digest": a.digest, "classification": a.classification}))
        .collect()
}

pub fn view_for_peer(task: &TaskView, peer: &PeerRecord) -> Value {
    let mut result = task.task.result.clone();
    if let Some(r) = result.as_mut() {
        redact_keys(r, &peer.policy.redact_output_keys);
    }
    let failure = task.task.failure.as_ref().map(|f| json!({"code": f.code, "message": "the task failed", "retryable": f.retryable}));
    json!({
        "taskId": task.task.task_id,
        "state": peer_state(task.task.state.as_str()),
        "revision": task.task.revision,
        "capability": task.task.capability,
        "result": result,
        "failure": failure,
        "artifacts": artifacts_for_peer(task, peer),
        "createdAt": task.task.created_at,
        "updatedAt": task.task.updated_at,
        "completedAt": task.task.completed_at,
    })
}

async fn get_task(State(s): State<IngressState>, Extension(cert): Extension<PeerCert>, headers: HeaderMap, Path(id): Path<String>) -> FedResult {
    let fed = authenticate(&s, &cert, &headers, Action::TaskRead, Some(&id)).await?;
    let task = s.domain.get_task(&fed.ctx, &id).await?;
    json_response(StatusCode::OK, view_for_peer(&task, &fed.peer))
}

#[derive(Deserialize)]
struct EventsQuery {
    after: Option<i64>,
}

fn event_for_peer(e: &somework_domain::tasks::TaskEventView) -> Value {
    let message = e.data.get("message").and_then(Value::as_str).map(|m| m.chars().take(500).collect::<String>());
    let kind = match e.kind.trim_start_matches("task.") {
        "claimed"
        | "running"
        | "progress"
        | "resumed"
        | "input_provided"
        | "blocked"
        | "ownership_transferred"
        | "requeued"
        | "lease_expired"
        | "reconciliation_required"
        | "reconciled_retry"
        | "reconciling" => "progress",
        other => other,
    };
    json!({"sequence": e.event_sequence, "type": kind, "state": e.to_state.as_deref().map(peer_state), "revision": e.revision, "at": e.created_at, "message": message, "percent": e.data.get("percent")})
}

async fn events(
    State(s): State<IngressState>,
    Extension(cert): Extension<PeerCert>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<EventsQuery>,
) -> FedResult {
    let fed = authenticate(&s, &cert, &headers, Action::TaskRead, Some(&id)).await?;
    let after = q.after.unwrap_or(0);
    let wants_sse = headers.get(header::ACCEPT).and_then(|v| v.to_str().ok()).is_some_and(|v| v.contains("text/event-stream"));
    if !wants_sse {
        let evs = s.domain.list_task_events(&fed.ctx, &id, after, 200).await?;
        return json_response(StatusCode::OK, json!({"events": evs.iter().map(event_for_peer).collect::<Vec<_>>()}));
    }
    s.domain.get_task(&fed.ctx, &id).await?;
    let domain = s.domain.clone();
    let ctx = fed.ctx.clone();
    let stream = async_stream::stream! {
        let mut cursor = after;
        loop {
            let Ok(evs) = domain.list_task_events(&ctx, &id, cursor, 200).await else { break };
            for e in &evs {
                cursor = cursor.max(e.event_sequence);
                yield Ok::<_, Infallible>(Event::default().id(e.event_sequence.to_string()).json_data(event_for_peer(e)).unwrap_or_default());
            }
            if let Ok(t) = domain.get_task(&ctx, &id).await
                && t.task.state.is_terminal() && evs.is_empty() { break; }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    };
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()).into_response())
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct CancelBody {
    reason: Option<String>,
}

async fn cancel(
    State(s): State<IngressState>,
    Extension(cert): Extension<PeerCert>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Option<Json<CancelBody>>,
) -> FedResult {
    let fed = authenticate(&s, &cert, &headers, Action::TaskCancel, Some(&id)).await?;
    let reason = body.and_then(|b| b.0.reason);
    let task = s.domain.cancel_task(&fed.ctx, &id, CancelRequest { reason, ..Default::default() }).await?;
    json_response(StatusCode::OK, view_for_peer(&task, &fed.peer))
}

/// Artifact bytes are proxied through the gateway: peers never receive object-store URLs or credentials.
async fn artifact(
    State(s): State<IngressState>,
    Extension(cert): Extension<PeerCert>,
    headers: HeaderMap,
    Path((id, artifact_id, version)): Path<(String, String, u64)>,
) -> FedResult {
    let fed = authenticate(&s, &cert, &headers, Action::ArtifactRead, Some(&id)).await?;
    let task = s.domain.get_task(&fed.ctx, &id).await?;
    let listed = artifacts_for_peer(&task, &fed.peer);
    if !listed.iter().any(|a| a["artifactId"] == artifact_id && a["version"] == version) {
        return Err(Error::not_found("artifact").into());
    }
    let grant = s.domain.artifact_download_grant(&fed.ctx, &artifact_id, version, DownloadRequest { task_id: Some(id), fencing_token: None }).await?;
    let bytes = reqwest::get(&grant.url)
        .await
        .map_err(|e| Error::unavailable(format!("object fetch: {e}")))?
        .bytes()
        .await
        .map_err(|e| Error::unavailable(format!("object read: {e}")))?;
    if sha256_hex(&bytes) != grant.artifact.digest.value {
        return Err(Error::new(ErrorCode::IntegrityFailure, "stored artifact does not match its digest").into());
    }
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(header::CONTENT_TYPE, "application/octet-stream".parse().expect("static header"));
    response.headers_mut().insert("x-artifact-sha256", grant.artifact.digest.value.parse().expect("hex header"));
    Ok(response)
}
