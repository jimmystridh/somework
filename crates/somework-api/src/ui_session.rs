//! Server-side session state for the operations UI: OIDC authorization-code + PKCE login (confidential client)
//! and HttpOnly session cookies. Sessions hold only an identity reference; permissions are always re-read from
//! the principal on each request, so revoking a principal takes effect immediately.

use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use parking_lot::Mutex;
use serde::Deserialize;
use somework_core::{Error, jws};

pub const COOKIE_NAME: &str = "somework_session";
pub const CSRF_HEADER: &str = "x-somework-csrf";
const SESSION_TTL: Duration = Duration::from_secs(8 * 3600);
const PENDING_TTL: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct UiLogin {
    pub issuer: String,
    pub client_id: String,
    pub client_secret: String,
    /// Discovered from `<issuer>/.well-known/openid-configuration` when absent.
    pub authorization_endpoint: Option<String>,
    pub token_endpoint: Option<String>,
    pub scopes: Option<String>,
}

#[derive(Debug, Clone)]
pub enum Identity {
    Oidc { issuer: String, subject: String },
    Principal { principal_id: String },
}

#[derive(Debug, Clone)]
pub struct Session {
    pub identity: Identity,
    pub csrf: String,
    expires: Instant,
}

pub struct Pending {
    pub verifier: String,
    pub nonce: String,
    created: Instant,
}

#[derive(Debug, Clone)]
pub struct Endpoints {
    pub authorization: String,
    pub token: String,
}

pub struct UiState {
    pub login: Option<UiLogin>,
    pub dev_token_login: bool,
    pub secure_cookies: bool,
    sessions: Mutex<HashMap<String, Session>>,
    pending: Mutex<HashMap<String, Pending>>,
    endpoints: Mutex<Option<Endpoints>>,
    pub http: reqwest::Client,
}

fn random_token() -> String {
    jws::b64(&rand::random::<[u8; 32]>())
}

impl UiState {
    pub fn new(login: Option<UiLogin>, dev_token_login: bool, secure_cookies: bool) -> Self {
        Self {
            login,
            dev_token_login,
            secure_cookies,
            sessions: Mutex::default(),
            pending: Mutex::default(),
            endpoints: Mutex::default(),
            http: reqwest::Client::new(),
        }
    }

    pub fn create_session(&self, identity: Identity) -> (String, String) {
        let id = random_token();
        let csrf = random_token();
        let mut sessions = self.sessions.lock();
        sessions.retain(|_, s| s.expires > Instant::now());
        sessions.insert(id.clone(), Session { identity, csrf: csrf.clone(), expires: Instant::now() + SESSION_TTL });
        (id, csrf)
    }

    pub fn session(&self, id: &str) -> Option<Session> {
        let sessions = self.sessions.lock();
        sessions.get(id).filter(|s| s.expires > Instant::now()).cloned()
    }

    pub fn destroy(&self, id: &str) {
        self.sessions.lock().remove(id);
    }

    pub fn begin_login(&self) -> (String, String, String) {
        let state = random_token();
        let verifier = random_token();
        let nonce = random_token();
        let mut pending = self.pending.lock();
        pending.retain(|_, p| p.created.elapsed() < PENDING_TTL);
        pending.insert(state.clone(), Pending { verifier: verifier.clone(), nonce: nonce.clone(), created: Instant::now() });
        (state, verifier, nonce)
    }

    pub fn take_pending(&self, state: &str) -> Option<Pending> {
        self.pending.lock().remove(state).filter(|p| p.created.elapsed() < PENDING_TTL)
    }

    pub async fn endpoints(&self) -> Result<Endpoints, Error> {
        if let Some(e) = self.endpoints.lock().clone() {
            return Ok(e);
        }
        let login = self.login.as_ref().ok_or_else(|| Error::not_found("OIDC login"))?;
        let resolved = match (&login.authorization_endpoint, &login.token_endpoint) {
            (Some(a), Some(t)) => Endpoints { authorization: a.clone(), token: t.clone() },
            _ => {
                let url = format!("{}/.well-known/openid-configuration", login.issuer.trim_end_matches('/'));
                let doc: serde_json::Value = self
                    .http
                    .get(&url)
                    .send()
                    .await
                    .map_err(|e| Error::unavailable(format!("OIDC discovery failed: {e}")))?
                    .json()
                    .await
                    .map_err(|e| Error::unavailable(format!("OIDC discovery decode failed: {e}")))?;
                Endpoints {
                    authorization: doc["authorization_endpoint"]
                        .as_str()
                        .ok_or_else(|| Error::unavailable("discovery lacks authorization_endpoint"))?
                        .to_string(),
                    token: doc["token_endpoint"].as_str().ok_or_else(|| Error::unavailable("discovery lacks token_endpoint"))?.to_string(),
                }
            }
        };
        *self.endpoints.lock() = Some(resolved.clone());
        Ok(resolved)
    }
}

pub fn pkce_challenge(verifier: &str) -> String {
    use sha2::{Digest, Sha256};
    jws::b64(&Sha256::digest(verifier.as_bytes()))
}

pub fn cookie_value<'a>(header: &'a str, name: &str) -> Option<&'a str> {
    header.split(';').filter_map(|p| p.trim().split_once('=')).find(|(k, _)| *k == name).map(|(_, v)| v)
}
