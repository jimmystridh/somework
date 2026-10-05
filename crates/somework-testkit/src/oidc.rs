//! Minimal mock OpenID Provider (discovery, JWKS, authorization-code + PKCE with an auto-login user picker and a
//! token endpoint issuing EdDSA ID tokens). Stands in for the organisation's IdP in UI login tests.

use std::{collections::HashMap, net::SocketAddr, sync::Arc};

use axum::{
    Form, Json, Router,
    extract::{Query, State},
    http::StatusCode,
    response::{Html, IntoResponse, Redirect, Response},
    routing::{get, post},
};
use ed25519_dalek::SigningKey;
use parking_lot::Mutex;
use serde_json::{Value, json};
use somework_core::jws;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
struct IdpState {
    issuer: String,
    client_id: String,
    client_secret: String,
    key: Arc<SigningKey>,
    kid: String,
    users: Vec<String>,
    codes: Arc<Mutex<HashMap<String, PendingCode>>>,
}

struct PendingCode {
    user: String,
    nonce: String,
    challenge: String,
    redirect_uri: String,
}

pub struct MockIdp {
    pub issuer: String,
    pub client_id: String,
    pub client_secret: String,
    pub addr: SocketAddr,
    jwks: Value,
    shutdown: CancellationToken,
}

impl MockIdp {
    pub async fn start(port: u16, users: &[&str]) -> MockIdp {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.expect("bind mock idp");
        let addr = listener.local_addr().expect("addr");
        let issuer = format!("http://127.0.0.1:{}", addr.port());
        let key = jws::new_signing_key();
        let kid = "mock-idp-1".to_string();
        let jwks = json!({"keys": [{"kty": "OKP", "crv": "Ed25519", "x": jws::b64(key.verifying_key().as_bytes()), "kid": kid, "alg": "EdDSA", "use": "sig"}]});
        let state = IdpState {
            issuer: issuer.clone(),
            client_id: "somework-console".into(),
            client_secret: "console-secret".into(),
            key: Arc::new(key),
            kid,
            users: users.iter().map(|u| u.to_string()).collect(),
            codes: Arc::default(),
        };
        let app = Router::new()
            .route("/.well-known/openid-configuration", get(discovery))
            .route("/jwks", get(jwks_doc))
            .route("/authorize", get(authorize))
            .route("/authorize/submit", post(submit))
            .route("/token", post(token))
            .with_state(state.clone());
        let shutdown = CancellationToken::new();
        let token = shutdown.clone();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).with_graceful_shutdown(async move { token.cancelled().await }).await;
        });
        MockIdp { issuer, client_id: state.client_id, client_secret: state.client_secret, addr, jwks, shutdown }
    }

    pub fn jwks(&self) -> Value {
        self.jwks.clone()
    }

    pub fn stop(&self) {
        self.shutdown.cancel();
    }
}

async fn discovery(State(s): State<IdpState>) -> Json<Value> {
    Json(json!({
        "issuer": s.issuer,
        "authorization_endpoint": format!("{}/authorize", s.issuer),
        "token_endpoint": format!("{}/token", s.issuer),
        "jwks_uri": format!("{}/jwks", s.issuer),
        "response_types_supported": ["code"],
        "id_token_signing_alg_values_supported": ["EdDSA"],
        "code_challenge_methods_supported": ["S256"],
    }))
}

async fn jwks_doc(State(s): State<IdpState>) -> Json<Value> {
    let pk = s.key.verifying_key();
    Json(json!({"keys": [{"kty": "OKP", "crv": "Ed25519", "x": jws::b64(pk.as_bytes()), "kid": s.kid, "alg": "EdDSA", "use": "sig"}]}))
}

async fn authorize(State(s): State<IdpState>, Query(q): Query<HashMap<String, String>>) -> Response {
    if q.get("client_id") != Some(&s.client_id) {
        return (StatusCode::BAD_REQUEST, "unknown client").into_response();
    }
    let hidden = ["redirect_uri", "state", "nonce", "code_challenge"]
        .iter()
        .map(|k| format!("<input type=hidden name={k} value=\"{}\">", q.get(*k).cloned().unwrap_or_default().replace('"', "&quot;")))
        .collect::<String>();
    let buttons = s.users.iter().map(|u| format!("<button name=user value=\"{u}\" data-testid=\"idp-user-{u}\">Continue as {u}</button>")).collect::<String>();
    Html(format!("<!doctype html><title>Mock IdP</title><body style=\"font-family:sans-serif;max-width:28rem;margin:10vh auto\"><h1>Mock identity provider</h1><form method=post action=\"/authorize/submit\">{hidden}{buttons}</form>")).into_response()
}

async fn submit(State(s): State<IdpState>, Form(f): Form<HashMap<String, String>>) -> Response {
    let code = jws::b64(&rand::random::<[u8; 16]>());
    let redirect_uri = f.get("redirect_uri").cloned().unwrap_or_default();
    s.codes.lock().insert(
        code.clone(),
        PendingCode {
            user: f.get("user").cloned().unwrap_or_default(),
            nonce: f.get("nonce").cloned().unwrap_or_default(),
            challenge: f.get("code_challenge").cloned().unwrap_or_default(),
            redirect_uri: redirect_uri.clone(),
        },
    );
    let sep = if redirect_uri.contains('?') { '&' } else { '?' };
    Redirect::to(&format!("{redirect_uri}{sep}code={code}&state={}", urlencoding::encode(f.get("state").map(String::as_str).unwrap_or_default())))
        .into_response()
}

async fn token(State(s): State<IdpState>, Form(f): Form<HashMap<String, String>>) -> Response {
    let bad = |m: &str| (StatusCode::BAD_REQUEST, Json(json!({"error": "invalid_grant", "error_description": m}))).into_response();
    if f.get("client_id") != Some(&s.client_id) || f.get("client_secret") != Some(&s.client_secret) {
        return bad("client authentication failed");
    }
    let Some(pending) = f.get("code").and_then(|c| s.codes.lock().remove(c)) else { return bad("unknown or used code") };
    if f.get("redirect_uri") != Some(&pending.redirect_uri) {
        return bad("redirect_uri mismatch");
    }
    use sha2::{Digest, Sha256};
    let verifier = f.get("code_verifier").cloned().unwrap_or_default();
    if jws::b64(&Sha256::digest(verifier.as_bytes())) != pending.challenge {
        return bad("PKCE verification failed");
    }
    let now = chrono::Utc::now().timestamp();
    let claims = json!({"iss": s.issuer, "sub": pending.user, "aud": s.client_id, "iat": now, "exp": now + 600, "nonce": pending.nonce});
    let id_token = jws::sign("JWT", &s.kid, &s.key, &claims);
    Json(json!({"id_token": id_token, "access_token": "unused", "token_type": "Bearer", "expires_in": 600})).into_response()
}
