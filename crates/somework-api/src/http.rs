//! HTTP plumbing: trace context middleware, problem+json errors, auth extractor and reply helpers.

use std::time::Instant;

use axum::{
    Json,
    extract::{FromRequest, FromRequestParts, MatchedPath, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header, request::Parts},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use somework_core::{Error, trace::TraceContext};
use somework_domain::{Ctx, domain::kind_str};

use crate::{oidc::OidcVerifier, state::AppState};

tokio::task_local! {
    static TRACE: TraceContext;
}

pub fn current_trace() -> TraceContext {
    TRACE.try_with(|t| t.clone()).unwrap_or_else(|_| TraceContext::new_root())
}

/// Wraps every request: continues (or starts) a W3C trace, echoes it on the response and records API metrics.
pub async fn trace_layer(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let incoming = req.headers().get("traceparent").and_then(|v| v.to_str().ok()).and_then(TraceContext::parse);
    let trace = incoming.map(|t| t.child()).unwrap_or_else(TraceContext::new_root);
    let route = req.extensions().get::<MatchedPath>().map(|p| p.as_str().to_string()).unwrap_or_else(|| "unmatched".into());
    let method = req.method().clone();
    let started = Instant::now();
    let mut response = TRACE.scope(trace.clone(), next.run(req)).await;
    let headers = response.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&trace.traceparent()) {
        headers.insert("traceparent", v);
    }
    if let Ok(v) = HeaderValue::from_str(&trace.trace_id) {
        headers.insert("x-trace-id", v);
    }
    let label = format!("{method} {route}");
    state.domain.metrics.api_requests.with_label_values(&[label.as_str(), response.status().as_str()]).inc();
    state.domain.metrics.api_latency.with_label_values(&[label.as_str()]).observe(started.elapsed().as_secs_f64());
    response
}

#[derive(Debug)]
pub struct ApiError(pub Error);

impl From<Error> for ApiError {
    fn from(e: Error) -> Self {
        ApiError(e)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let trace = current_trace();
        let status = StatusCode::from_u16(self.0.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let mut body = self.0.problem(&trace.trace_id);
        // internal details of denials (full decision payloads) stay in the audit trail, not in the response
        if let Some(details) = body.get_mut("details").and_then(Value::as_object_mut) {
            details.remove("decision");
        }
        let mut response = (status, Json(body)).into_response();
        response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/problem+json"));
        if status == StatusCode::UNAUTHORIZED {
            response.headers_mut().insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        }
        response
    }
}

pub type ApiResult = Result<Response, ApiError>;

/// JSON success reply carrying `traceId` (every response includes it).
pub fn ok<T: Serialize>(value: T) -> ApiResult {
    reply(StatusCode::OK, value)
}

pub fn created<T: Serialize>(value: T) -> ApiResult {
    reply(StatusCode::CREATED, value)
}

pub fn reply<T: Serialize>(status: StatusCode, value: T) -> ApiResult {
    let mut v = serde_json::to_value(value).map_err(|e| Error::internal(format!("serialize response: {e}")))?;
    let trace = current_trace();
    match v.as_object_mut() {
        Some(obj) => {
            obj.insert("traceId".into(), json!(trace.traceparent()));
        }
        None => v = json!({"items": v, "traceId": trace.traceparent()}),
    }
    Ok((status, Json(v)).into_response())
}

pub fn no_content() -> ApiResult {
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Strict JSON body: malformed input becomes a `validation_failed` problem rather than axum's plain-text rejection.
pub struct Body<T>(pub T);

impl<S, T> FromRequest<S> for Body<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let bytes = axum::body::Bytes::from_request(req, state).await.map_err(|e| ApiError(Error::invalid(format!("unreadable request body: {e}"))))?;
        let bytes = if bytes.is_empty() { axum::body::Bytes::from_static(b"{}") } else { bytes };
        let value = serde_json::from_slice(&bytes).map_err(|e| ApiError(Error::invalid(format!("invalid JSON body: {e}"))))?;
        Ok(Body(value))
    }
}

/// Authenticated request context (credentials -> actor, plus idempotency, revision and trace headers).
pub struct Auth(pub Ctx);

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

impl FromRequestParts<AppState> for Auth {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let actor = match header_str(&parts.headers, "authorization") {
            Some(auth) => {
                let token = auth
                    .strip_prefix("Bearer ")
                    .or_else(|| auth.strip_prefix("bearer "))
                    .ok_or_else(|| Error::unauthenticated("expected a Bearer token"))?
                    .trim();
                let meta = somework_domain::auth::AuthMeta { transport: "rest".into(), peer_cert_sha256: None };
                if let Some(oidc) = state.oidc.as_ref().filter(|_| OidcVerifier::looks_like_oidc(token)) {
                    let identity = oidc.verify(token).await?;
                    state.domain.actor_for_oidc(&identity.issuer, &identity.subject).await?
                } else {
                    state.domain.authenticate(token, &meta).await?
                }
            }
            None => session_actor(&parts.headers, &parts.method, state).await?,
        };
        let mut ctx = Ctx::new(actor).with_trace(current_trace()).with_transport("rest");
        if let Some(key) = header_str(&parts.headers, "idempotency-key") {
            if key.len() > 256 || key.is_empty() {
                return Err(ApiError(Error::invalid("Idempotency-Key must be 1-256 characters")));
            }
            ctx.idempotency_key = Some(key.to_string());
        }
        if let Some(m) = header_str(&parts.headers, "if-match") {
            let rev = m.trim().trim_matches('"').trim_start_matches("W/").trim_matches('"');
            ctx.if_match = Some(rev.parse().map_err(|_| ApiError(Error::invalid("If-Match must carry the task revision as an integer")))?);
        }
        Ok(Auth(ctx))
    }
}

pub fn actor_label(ctx: &Ctx) -> String {
    format!("{}:{}", kind_str(ctx.actor.kind), ctx.actor.id)
}

/// Cookie-session credentials (operations UI). Mutating requests must echo the session's CSRF token in a custom
/// header, which a cross-site form or `<img>` cannot set; the cookie itself is `SameSite=Strict` as well.
pub(crate) async fn session_actor(headers: &HeaderMap, method: &axum::http::Method, state: &AppState) -> Result<somework_domain::Actor, Error> {
    use crate::ui_session::{COOKIE_NAME, CSRF_HEADER, Identity, cookie_value};
    let ui = state.ui.as_ref().ok_or_else(|| Error::unauthenticated("missing Authorization header"))?;
    let session = header_str(headers, "cookie")
        .and_then(|c| cookie_value(c, COOKIE_NAME))
        .and_then(|id| ui.session(id))
        .ok_or_else(|| Error::unauthenticated("missing Authorization header or session"))?;
    let safe = matches!(*method, axum::http::Method::GET | axum::http::Method::HEAD | axum::http::Method::OPTIONS);
    if !safe && header_str(headers, CSRF_HEADER) != Some(session.csrf.as_str()) {
        return Err(Error::denied("missing or invalid CSRF token"));
    }
    match session.identity {
        Identity::Oidc { issuer, subject } => state.domain.actor_for_oidc(&issuer, &subject).await,
        Identity::Principal { principal_id } => {
            let mut conn = state.domain.db.pool().acquire().await.map_err(somework_domain::db::db_error)?;
            let principal = state
                .domain
                .principal_by_id(&mut conn, &principal_id)
                .await?
                .filter(|p| p.status == "active")
                .ok_or_else(|| Error::unauthenticated("principal is disabled"))?;
            Ok(state.domain.actor_for_principal(&principal, None).await)
        }
    }
}
