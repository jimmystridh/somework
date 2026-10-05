//! Operations UI backend: OIDC login/session endpoints and operator read models used by the SPA.

use axum::{
    Router,
    extract::{Query, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use somework_core::Error;
use somework_domain::ops::PolicyDecisionFilter;

use crate::{
    http::*,
    state::AppState,
    ui_session::{COOKIE_NAME, Identity, UiState, cookie_value, pkce_challenge},
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/ui/config.json", get(config))
        .route("/ui/login", get(login))
        .route("/ui/callback", get(callback))
        .route("/ui/logout", post(logout))
        .route("/ui/dev-login", post(dev_login))
        .route("/ui/session", get(session))
        .route("/v1/admin/policy-decisions", get(policy_decisions))
        .route("/v1/admin/conversations", get(conversations))
        .route("/v1/admin/catalog", get(catalog))
        .route("/v1/admin/context-packs", get(context_packs))
        .route("/v1/admin/context-packs/{id}/{version}", get(context_manifest))
        .route("/v1/admin/artifacts", get(artifacts))
}

async fn config(State(s): State<AppState>) -> ApiResult {
    let ui = s.ui.as_deref();
    ok(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "domainId": s.domain.cfg.domain_id,
        "oidcLogin": ui.is_some_and(|u| u.login.is_some()),
        "devTokenLogin": ui.is_some_and(|u| u.dev_token_login),
    }))
}

fn page(status: StatusCode, title: &str, message: &str) -> Response {
    let esc = |t: &str| t.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let body = format!(
        "<!doctype html><meta charset=utf-8><title>{t}</title><meta name=viewport content=\"width=device-width,initial-scale=1\"><style>body{{font:16px/1.5 Georgia,serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;background:#13110e;color:#ece3d0}}h1{{font-weight:600}}a{{color:#e8b04a}}</style><main data-testid=\"login-error\"><h1>{t}</h1><p>{m}</p><p><a href=\"/ui/\">Back to the console</a></p></main>",
        t = esc(title),
        m = esc(message)
    );
    (status, [(header::CONTENT_TYPE, "text/html; charset=utf-8")], body).into_response()
}

fn session_cookie(ui: &UiState, value: &str, max_age: i64) -> HeaderValue {
    let secure = if ui.secure_cookies { "; Secure" } else { "" };
    HeaderValue::from_str(&format!("{COOKIE_NAME}={value}; HttpOnly; SameSite=Strict; Path=/; Max-Age={max_age}{secure}")).expect("cookie header")
}

fn ui_state(s: &AppState) -> Result<&UiState, ApiError> {
    s.ui.as_deref().ok_or_else(|| ApiError(Error::not_found("UI login")))
}

fn form(pairs: &[(&str, &str)]) -> String {
    pairs.iter().map(|(k, v)| format!("{}={}", urlencoding::encode(k), urlencoding::encode(v))).collect::<Vec<_>>().join("&")
}

async fn login(State(s): State<AppState>) -> Result<Response, ApiError> {
    let ui = ui_state(&s)?;
    let login = ui.login.as_ref().ok_or_else(|| Error::not_found("OIDC login"))?;
    let endpoints = ui.endpoints().await?;
    let (state, verifier, nonce) = ui.begin_login();
    let redirect_uri = format!("{}/ui/callback", s.public_url.trim_end_matches('/'));
    let query = form(&[
        ("response_type", "code"),
        ("client_id", &login.client_id),
        ("redirect_uri", &redirect_uri),
        ("scope", login.scopes.as_deref().unwrap_or("openid profile")),
        ("state", &state),
        ("nonce", &nonce),
        ("code_challenge", &pkce_challenge(&verifier)),
        ("code_challenge_method", "S256"),
    ]);
    let sep = if endpoints.authorization.contains('?') { '&' } else { '?' };
    Ok(Redirect::to(&format!("{}{sep}{query}", endpoints.authorization)).into_response())
}

#[derive(Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

async fn callback(State(s): State<AppState>, Query(q): Query<CallbackQuery>) -> Response {
    match finish_login(&s, q).await {
        Ok(response) => response,
        Err(err) => {
            let status = if err.0.code == somework_core::ErrorCode::Unauthenticated { StatusCode::FORBIDDEN } else { StatusCode::BAD_GATEWAY };
            page(status, "Sign-in failed", &err.0.message)
        }
    }
}

async fn finish_login(s: &AppState, q: CallbackQuery) -> Result<Response, ApiError> {
    let ui = ui_state(s)?;
    let login = ui.login.as_ref().ok_or_else(|| Error::not_found("OIDC login"))?;
    if let Some(e) = q.error {
        return Err(Error::unauthenticated(format!("the identity provider refused the sign-in: {e}")).into());
    }
    let pending = q.state.as_deref().and_then(|st| ui.take_pending(st)).ok_or_else(|| Error::unauthenticated("unknown or expired sign-in attempt"))?;
    let code = q.code.ok_or_else(|| Error::unauthenticated("no authorization code"))?;
    let endpoints = ui.endpoints().await?;
    let redirect_uri = format!("{}/ui/callback", s.public_url.trim_end_matches('/'));
    let body = form(&[
        ("grant_type", "authorization_code"),
        ("code", &code),
        ("redirect_uri", &redirect_uri),
        ("client_id", &login.client_id),
        ("client_secret", &login.client_secret),
        ("code_verifier", &pending.verifier),
    ]);
    let resp = ui
        .http
        .post(&endpoints.token)
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| Error::unavailable(format!("token endpoint unreachable: {e}")))?;
    let tokens: Value = resp.json().await.map_err(|e| Error::unavailable(format!("token response unreadable: {e}")))?;
    let id_token = tokens["id_token"].as_str().ok_or_else(|| Error::unauthenticated("the token response carries no id_token"))?;
    let verifier = s.oidc.as_ref().ok_or_else(|| Error::internal("OIDC verification is not configured"))?;
    let identity = verifier.verify(id_token).await?;
    let payload: Value = serde_json::from_slice(&somework_core::jws::unb64(id_token.split('.').nth(1).unwrap_or_default())?)
        .map_err(|_| Error::unauthenticated("malformed id_token"))?;
    if payload["nonce"].as_str() != Some(pending.nonce.as_str()) {
        return Err(Error::unauthenticated("id_token nonce mismatch").into());
    }
    // ID-04: only explicitly provisioned identities get a session
    s.domain.actor_for_oidc(&identity.issuer, &identity.subject).await.map_err(|_| {
        Error::unauthenticated(format!("The identity {} is not provisioned as a SomeWork principal. Ask an administrator to map it.", identity.subject))
    })?;
    let (session_id, _csrf) = ui.create_session(Identity::Oidc { issuer: identity.issuer, subject: identity.subject });
    let mut response = Redirect::to("/ui/").into_response();
    response.headers_mut().insert(header::SET_COOKIE, session_cookie(ui, &session_id, 8 * 3600));
    Ok(response)
}

async fn logout(State(s): State<AppState>, headers: HeaderMap) -> Result<Response, ApiError> {
    let ui = ui_state(&s)?;
    if let Some(id) = headers.get(header::COOKIE).and_then(|c| c.to_str().ok()).and_then(|c| cookie_value(c, COOKIE_NAME)) {
        if let Some(session) = ui.session(id)
            && headers.get(crate::ui_session::CSRF_HEADER).and_then(|v| v.to_str().ok()) != Some(session.csrf.as_str())
        {
            return Err(Error::denied("missing or invalid CSRF token").into());
        }
        ui.destroy(id);
    }
    let mut response = reply(StatusCode::OK, json!({"loggedOut": true}))?;
    response.headers_mut().insert(header::SET_COOKIE, session_cookie(ui, "", 0));
    Ok(response)
}

#[derive(Deserialize)]
struct DevLogin {
    token: String,
}

async fn dev_login(State(s): State<AppState>, Body(b): Body<DevLogin>) -> Result<Response, ApiError> {
    let ui = ui_state(&s)?;
    if !ui.dev_token_login {
        return Err(Error::not_found("dev token login").into());
    }
    let meta = somework_domain::auth::AuthMeta { transport: "ui".into(), peer_cert_sha256: None };
    let actor = s.domain.authenticate(b.token.trim(), &meta).await?;
    let (id, csrf) = ui.create_session(Identity::Principal { principal_id: actor.principal_id.clone() });
    let mut response = reply(StatusCode::OK, json!({"csrf": csrf, "actor": actor.actor_ref()}))?;
    response.headers_mut().insert(header::SET_COOKIE, session_cookie(ui, &id, 8 * 3600));
    Ok(response)
}

/// Always 200: tells the SPA whether a session exists, who it is and which CSRF token to send.
async fn session(State(s): State<AppState>, headers: HeaderMap) -> ApiResult {
    let Some(ui) = s.ui.as_deref() else { return ok(json!({"authenticated": false})) };
    let session = headers.get(header::COOKIE).and_then(|c| c.to_str().ok()).and_then(|c| cookie_value(c, COOKIE_NAME)).and_then(|id| ui.session(id));
    let Some(session) = session else { return ok(json!({"authenticated": false})) };
    match crate::http::session_actor(&headers, &Method::GET, &s).await {
        Ok(actor) => ok(json!({
            "authenticated": true,
            "csrf": session.csrf,
            "actor": actor.actor_ref(),
            "roles": actor.permissions.roles,
            "operator": actor.permissions.allows_action("ops.read"),
            "auditor": actor.permissions.allows_action("audit.read"),
            "canApprove": actor.permissions.allows_action("approval.grant"),
            "canAdminCatalog": actor.permissions.allows_action("catalog.approve"),
        })),
        Err(_) => ok(json!({"authenticated": false})),
    }
}

async fn policy_decisions(State(s): State<AppState>, Auth(ctx): Auth, Query(f): Query<PolicyDecisionFilter>) -> ApiResult {
    ok(json!({"decisions": s.domain.list_policy_decisions(&ctx, f).await?}))
}

#[derive(Deserialize)]
struct LimitQuery {
    limit: Option<i64>,
    #[serde(rename = "taskId")]
    task_id: Option<String>,
}

async fn conversations(State(s): State<AppState>, Auth(ctx): Auth, Query(q): Query<LimitQuery>) -> ApiResult {
    ok(json!({"conversations": s.domain.list_conversations_admin(&ctx, q.limit.unwrap_or(200)).await?}))
}

async fn catalog(State(s): State<AppState>, Auth(ctx): Auth) -> ApiResult {
    s.domain.enforce_read(&ctx, somework_domain::policy::AuthzRequest::new("catalog.approve")).await?;
    ok(json!({"entries": s.domain.list_catalog(&ctx).await?}))
}

async fn context_packs(State(s): State<AppState>, Auth(ctx): Auth, Query(q): Query<LimitQuery>) -> ApiResult {
    ok(json!({"contextPacks": s.domain.list_context_packs_admin(&ctx, q.limit.unwrap_or(200)).await?}))
}

async fn context_manifest(State(s): State<AppState>, Auth(ctx): Auth, axum::extract::Path((id, version)): axum::extract::Path<(String, i64)>) -> ApiResult {
    ok(s.domain.get_context_manifest_admin(&ctx, &id, version).await?)
}

async fn artifacts(State(s): State<AppState>, Auth(ctx): Auth, Query(q): Query<LimitQuery>) -> ApiResult {
    ok(json!({"artifacts": s.domain.list_artifacts_admin(&ctx, q.task_id.as_deref(), q.limit.unwrap_or(200)).await?}))
}
