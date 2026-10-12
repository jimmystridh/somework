//! Operations (ADR 0004): the operators' console of the fleet. This module is the backend of the editors for an agent's setup, the MCP
//! catalog, the skill library and the fleet limits: Postgres, Entra sign-in, the `/fleet/api/ops` routes and the delivery of documents to
//! agents. The dashboard's "metadata only" rule still holds for everything read from agents; operator wording flows the other way, on purpose.

pub mod api;
pub mod contract;
pub mod delivery;
pub mod diff;
pub mod keygen;
pub mod oidc;
pub mod reconcile;
pub mod service;
pub mod session;
pub mod store;
#[cfg(test)]
pub mod testing;

use crate::events::AgentTarget;
use axum::{
    extract::FromRequestParts,
    http::{HeaderMap, Method, StatusCode, request::Parts},
};
use fleet_shared::{
    operations::{ApiError, Role},
    somework::SomeWork,
};
use reconcile::{Observations, Reconciler};
use session::{SESSION_COOKIE, SessionClaims, SignedCookies};
use std::{path::Path, sync::Arc};
use store::Store;
use tokio::sync::{Notify, RwLock};

/// The header every write must carry. A cross-site form or fetch cannot add it without a CORS preflight, which this server never allows.
pub const WRITE_HEADER: &str = "x-operations-request";

/// How a service of the fleet identifies itself instead of signing in (`OPERATIONS_SERVICE_TOKENS_FILE`). `Authorization` stays with the dashboard's
/// own gateway, so this travels in a header of its own; the gateway lets such a request through to `/fleet/api/ops` only, where it is checked.
pub const SERVICE_TOKEN_HEADER: &str = "x-operations-service-token";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StubUser {
    pub email: String,
    pub role: Role,
}

pub enum AuthMode {
    /// A developer's machine: everybody is this one user. Never reachable from another machine unless an unsafe flag says so.
    Stub(StubUser),
    Entra(Box<oidc::Oidc>),
}

pub struct Ops {
    pub store: Store,
    pub auth: AuthMode,
    /// Services that call with a bearer token instead of a session (`OPERATIONS_SERVICE_TOKENS_FILE`).
    pub service_tokens: Vec<service::ServiceToken>,
    pub cookies: SignedCookies,
    pub observations: Arc<Observations>,
    pub reconciler: Arc<Reconciler>,
    /// The dashboard's cached SomeWork sample: the existing readers for jobs, history, usage and the setup card.
    pub sample: Arc<RwLock<SomeWork>>,
    pub targets: Vec<AgentTarget>,
    pub nudge: Arc<Notify>,
    pub sending_configured: bool,
}

// ------------------------------------------------------------------------------------------------------------- settings

/// How the console authenticates, decided from the environment before anything listens.
pub enum AuthSettings {
    Stub(StubUser),
    Entra(oidc::OidcConfig),
}

fn truthy(value: Option<String>) -> bool {
    value.is_some_and(|value| value == "1")
}

/// `OPERATIONS_AUTH=stub` with `OPERATIONS_STUB_USER=email:role` is for development. It makes every request the stub user, so it must not
/// be reachable from other machines: it needs a loopback listener, or `OPERATIONS_UNSAFE_STUB=1` to say that this is meant.
pub fn auth_settings(get: &dyn Fn(&str) -> Option<String>, read_secret: &dyn Fn(&str) -> Result<String, String>, loopback: bool) -> Result<AuthSettings, String> {
    if get("OPERATIONS_AUTH").as_deref() == Some("stub") {
        if !loopback && !truthy(get("OPERATIONS_UNSAFE_STUB")) {
            return Err("OPERATIONS_AUTH=stub signs everybody in and is only allowed on a loopback listener (set FLEET_PREVIEW=1 for a local run); OPERATIONS_UNSAFE_STUB=1 overrides this and must never be set on a deployment".into());
        }
        let spec = get("OPERATIONS_STUB_USER").ok_or("OPERATIONS_AUTH=stub needs OPERATIONS_STUB_USER=email:role")?;
        let (email, role) = spec.rsplit_once(':').ok_or("OPERATIONS_STUB_USER must be email:role")?;
        let role = Role::parse(role.trim()).ok_or("OPERATIONS_STUB_USER's role must be viewer, editor or admin")?;
        if !email.contains('@') {
            return Err("OPERATIONS_STUB_USER must start with an email address".into());
        }
        return Ok(AuthSettings::Stub(StubUser { email: email.trim().to_lowercase(), role }));
    }
    if let Some(other) = get("OPERATIONS_AUTH").filter(|mode| mode != "entra") {
        return Err(format!("OPERATIONS_AUTH={other} is not a mode (entra or stub)"));
    }
    let required = |name: &str| get(name).filter(|value| !value.is_empty()).ok_or_else(|| format!("{name} is required for Entra sign-in"));
    let secret_file = required("OIDC_CLIENT_SECRET_FILE")?;
    let client_secret = read_secret(&secret_file)?.trim().to_string();
    Ok(AuthSettings::Entra(oidc::OidcConfig { issuer: required("OIDC_ISSUER")?, client_id: required("OIDC_CLIENT_ID")?, client_secret, redirect_url: required("OIDC_REDIRECT_URL")? }))
}

/// The connection options: TLS is required unless `OPERATIONS_DATABASE_ALLOW_PLAINTEXT=1` (a developer's own database). The error never
/// repeats the URL, which holds a password.
pub fn database_options(url: &str, ca_file: Option<&str>, allow_plaintext: bool) -> Result<sqlx::postgres::PgConnectOptions, String> {
    use sqlx::postgres::PgSslMode;
    let mut options: sqlx::postgres::PgConnectOptions = url.trim().parse().map_err(|_| "DATABASE_URL is not a postgres URL".to_string())?;
    if !allow_plaintext && !matches!(options.get_ssl_mode(), PgSslMode::Require | PgSslMode::VerifyCa | PgSslMode::VerifyFull) {
        return Err("the database connection must use TLS: add sslmode=verify-full (or require) to DATABASE_URL; OPERATIONS_DATABASE_ALLOW_PLAINTEXT=1 is for a developer's own database only".into());
    }
    if let Some(ca) = ca_file.filter(|ca| !ca.is_empty()) {
        options = options.ssl_root_cert(ca);
    }
    Ok(options)
}

pub struct StartInputs<'a> {
    pub secrets: &'a Path,
    pub loopback: bool,
    pub sample: Arc<RwLock<SomeWork>>,
    pub targets: Vec<AgentTarget>,
}

fn read_secret_file(path: &str) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|_| format!("cannot read the secret file {path}"))
}

/// Starts Operations when `DATABASE_URL` (or `DATABASE_URL_FILE`) is set; without it the console stays off and the dashboard works as before.
/// Refuses to start (an error) when it is half configured, when the database is ahead of this build or when TLS to it is not set up.
pub async fn start(inputs: StartInputs<'_>) -> Result<Option<Arc<Ops>>, String> {
    let get = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
    let url = match (get("DATABASE_URL"), get("DATABASE_URL_FILE")) {
        (Some(_), Some(_)) => return Err("set DATABASE_URL or DATABASE_URL_FILE, not both".into()),
        (Some(url), None) => url,
        (None, Some(file)) => read_secret_file(&file)?.trim().to_string(),
        (None, None) => return Ok(None),
    };
    let auth = match auth_settings(&get, &read_secret_file, inputs.loopback)? {
        AuthSettings::Stub(user) => {
            eprintln!("OPERATIONS_AUTH=stub: every request is signed in as {} ({}). This is for development only.", user.email, user.role.label());
            AuthMode::Stub(user)
        }
        AuthSettings::Entra(config) => AuthMode::Entra(Box::new(oidc::Oidc::new(config, false)?)),
    };
    let options = database_options(&url, get("DATABASE_CA_FILE").as_deref(), truthy(get("OPERATIONS_DATABASE_ALLOW_PLAINTEXT")))?;
    let store = Store::connect(options).await?;
    if let Some(email) = get("OPERATIONS_FIRST_ADMIN")
        && store.ensure_first_admin(&email).await.map_err(|_| "cannot add the first administrator".to_string())?
    {
        println!("Operations: {} is the first administrator", email.to_lowercase());
    }
    let cookies = match get("OPERATIONS_SESSION_KEY_FILE") {
        Some(file) => {
            let key = read_secret_file(&file)?;
            if key.trim().len() < 32 {
                return Err("OPERATIONS_SESSION_KEY_FILE must hold at least 32 characters".into());
            }
            SignedCookies::new(key.trim().as_bytes())
        }
        None => {
            eprintln!("OPERATIONS_SESSION_KEY_FILE is not set: sessions end whenever the server restarts");
            SignedCookies::random()
        }
    };
    let service_tokens = match get("OPERATIONS_SERVICE_TOKENS_FILE") {
        Some(file) => service::parse(&read_secret_file(&file)?)?,
        None => Vec::new(),
    };
    let deliverer = deliverer_from_env(inputs.secrets, &get).await?;
    let sending_configured = deliverer.is_some();
    let observations = Arc::new(Observations::default());
    let nudge = Arc::new(Notify::new());
    let reconciler = Arc::new(Reconciler::new(store.clone(), deliverer, inputs.targets.clone(), crate::events::agent_http_client()?, observations.clone(), nudge.clone()));
    tokio::spawn(reconciler.clone().run());
    Ok(Some(Arc::new(Ops { store, auth, service_tokens, cookies, observations, reconciler, sample: inputs.sample, targets: inputs.targets, nudge, sending_configured })))
}

/// The `operations` service principal's key and the domain it signs for. `None` when there is no key or no `SOMEWORK_URL`.
async fn deliverer_from_env(secrets: &Path, get: &dyn Fn(&str) -> Option<String>) -> Result<Option<Arc<delivery::Deliverer>>, String> {
    let key_path = get("OPERATIONS_KEY_FILE").map(std::path::PathBuf::from).unwrap_or_else(|| secrets.join("operations-key.json"));
    let (Some(base), Ok(contents)) = (get("SOMEWORK_URL"), tokio::fs::read(&key_path).await) else {
        eprintln!("Operations will not deliver setup: it needs SOMEWORK_URL and the operations key file");
        return Ok(None);
    };
    let ca = get("SOMEWORK_CA_FILE").map(std::path::PathBuf::from).unwrap_or_else(|| secrets.join("somework-ca.pem"));
    let client = client_from_key(&base, &contents, get("OPERATIONS_DOMAIN_ID").as_deref(), base.starts_with("https://").then_some(ca.as_path()))?;
    Ok(Some(Arc::new(delivery::Deliverer::new(client))))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyFile {
    kind: String,
    id: String,
    domain_id: Option<String>,
    private_key: String,
}

/// A domain client that signs as `service:operations`. A key file of any other principal is refused: it would send setup nobody accepts.
pub fn client_from_key(base: &str, key_file: &[u8], domain_id: Option<&str>, ca: Option<&Path>) -> Result<somework_client::Client, String> {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    let file: KeyFile = serde_json::from_slice(key_file).map_err(|_| "the operations key file is not valid JSON".to_string())?;
    if (file.kind.as_str(), file.id.as_str()) != (fleet_shared::operations::OPERATIONS_PRINCIPAL_KIND, fleet_shared::operations::OPERATIONS_PRINCIPAL_ID) {
        return Err("the operations key file is not the key of service:operations".into());
    }
    let seed: [u8; 32] = URL_SAFE_NO_PAD.decode(file.private_key.trim()).ok().and_then(|bytes| bytes.try_into().ok()).ok_or("the operations key is not a 32 byte Ed25519 seed")?;
    let domain = domain_id.map(str::to_string).or(file.domain_id).ok_or("set OPERATIONS_DOMAIN_ID: the key file names no domain")?;
    let mut client = somework_client::Client::assertion(base, ed25519_dalek::SigningKey::from_bytes(&seed), &file.kind, &file.id, &domain);
    if let Some(ca) = ca {
        client = client.with_ca_file(ca)?;
    }
    Ok(client)
}

// -------------------------------------------------------------------------------------------------------------- sessions

/// Who is making the request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Session {
    pub email: String,
    pub role: Role,
    pub auth: &'static str,
}

/// An error response: the status and the body of `ApiError`.
#[derive(Debug)]
pub struct Failure(pub StatusCode, pub ApiError);

impl Failure {
    pub fn new(status: StatusCode, code: &str, message: impl Into<String>) -> Self {
        Self(status, ApiError { code: code.into(), message: message.into(), ..Default::default() })
    }

    pub fn unavailable() -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "unavailable", "the database is unavailable")
    }
}

impl Ops {
    /// Cookie, expiry and allow list. The role is read now, not from the cookie.
    pub async fn session(&self, headers: &HeaderMap) -> Result<Session, Failure> {
        if let Some(presented) = headers.get(SERVICE_TOKEN_HEADER) {
            return match presented.to_str().ok().and_then(|presented| service::find(&self.service_tokens, presented.trim())) {
                Some(token) => Ok(Session { email: token.name.clone(), role: token.role, auth: "service" }),
                None => Err(Failure::new(StatusCode::UNAUTHORIZED, "unauthorized", "the service token is not one of this console's")),
            };
        }
        match &self.auth {
            AuthMode::Stub(user) => Ok(Session { email: user.email.clone(), role: user.role, auth: "stub" }),
            AuthMode::Entra(_) => {
                let not_signed_in = || Failure(StatusCode::UNAUTHORIZED, ApiError { code: "not_signed_in".into(), message: "sign in first".into(), login: Some("/fleet/auth/login".into()), ..Default::default() });
                let cookie = headers.get(axum::http::header::COOKIE).and_then(|value| value.to_str().ok()).and_then(|header| session::cookie_value(header, SESSION_COOKIE)).ok_or_else(not_signed_in)?;
                let claims: SessionClaims = self.cookies.open(&cookie).ok_or_else(not_signed_in)?;
                if claims.expires <= chrono::Utc::now().timestamp() {
                    return Err(not_signed_in());
                }
                match self.store.user(&claims.email).await {
                    Ok(Some(user)) => Ok(Session { email: user.email, role: user.role, auth: "entra" }),
                    Ok(None) => Err(Failure::new(StatusCode::FORBIDDEN, "forbidden", "you are not on the allow list")),
                    Err(_) => Err(Failure::unavailable()),
                }
            }
        }
    }
}

/// A request from a signed-in user whose role is at least the one the const stands for (0 viewer, 1 editor, 2 admin). Writes also need
/// the `X-Operations-Request: 1` header.
pub struct Authed<const MINIMUM: u8>(pub Session);

pub type AsViewer = Authed<0>;
pub type AsEditor = Authed<1>;
pub type AsAdmin = Authed<2>;

pub fn minimum_role(level: u8) -> Role {
    match level {
        0 => Role::Viewer,
        1 => Role::Editor,
        _ => Role::Admin,
    }
}

impl<const MINIMUM: u8> FromRequestParts<Arc<Ops>> for Authed<MINIMUM> {
    type Rejection = Failure;

    async fn from_request_parts(parts: &mut Parts, ops: &Arc<Ops>) -> Result<Self, Failure> {
        let session = ops.session(&parts.headers).await?;
        let reading = matches!(parts.method, Method::GET | Method::HEAD);
        if !reading && parts.headers.get(WRITE_HEADER).and_then(|value| value.to_str().ok()) != Some("1") {
            return Err(Failure::new(StatusCode::FORBIDDEN, "forbidden", "writes need the header X-Operations-Request: 1"));
        }
        if session.role < minimum_role(MINIMUM) {
            return Err(Failure::new(StatusCode::FORBIDDEN, "forbidden", format!("this needs the {} role", minimum_role(MINIMUM).label())));
        }
        Ok(Self(session))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn settings(env: &[(&str, &str)], loopback: bool) -> Result<AuthSettings, String> {
        let env: HashMap<String, String> = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        auth_settings(&|name| env.get(name).cloned(), &|path| if path == "/run/secrets/oidc" { Ok("  s3cret\n".into()) } else { Err("no such file".into()) }, loopback)
    }

    #[test]
    fn the_stub_cannot_be_enabled_with_a_listener_other_machines_can_reach() {
        let stub = [("OPERATIONS_AUTH", "stub"), ("OPERATIONS_STUB_USER", "dev@example.com:admin")];
        assert!(matches!(settings(&stub, true), Ok(AuthSettings::Stub(StubUser { role: Role::Admin, .. }))));
        let refused = settings(&stub, false).err().unwrap();
        assert!(refused.contains("loopback"), "{refused}");
        let mut unsafe_flag = stub.to_vec();
        unsafe_flag.push(("OPERATIONS_UNSAFE_STUB", "1"));
        assert!(settings(&unsafe_flag, false).is_ok(), "the explicit unsafe flag is the only way");
        unsafe_flag[2] = ("OPERATIONS_UNSAFE_STUB", "yes");
        assert!(settings(&unsafe_flag[..3], false).is_err(), "only 1 counts");
    }

    #[test]
    fn the_stub_user_is_checked() {
        for bad in ["dev@example.com", "dev@example.com:root", "nobody:admin", ":admin"] {
            assert!(settings(&[("OPERATIONS_AUTH", "stub"), ("OPERATIONS_STUB_USER", bad)], true).is_err(), "{bad}");
        }
        assert!(settings(&[("OPERATIONS_AUTH", "stub")], true).is_err());
    }

    #[test]
    fn entra_needs_all_four_settings_and_reads_the_secret_from_its_file() {
        let full = [("OIDC_ISSUER", "https://login.microsoftonline.com/t/v2.0"), ("OIDC_CLIENT_ID", "id"), ("OIDC_CLIENT_SECRET_FILE", "/run/secrets/oidc"), ("OIDC_REDIRECT_URL", "https://x/fleet/auth/callback")];
        let Ok(AuthSettings::Entra(config)) = settings(&full, false) else { panic!("entra settings") };
        assert_eq!(config.client_secret, "s3cret");
        for missing in 0..full.len() {
            let mut partial = full.to_vec();
            partial.remove(missing);
            assert!(settings(&partial, false).is_err(), "without {}", full[missing].0);
        }
        assert!(settings(&[("OPERATIONS_AUTH", "magic")], false).is_err());
        let mut unreadable = full.to_vec();
        unreadable[2] = ("OIDC_CLIENT_SECRET_FILE", "/nowhere");
        assert!(settings(&unreadable, false).is_err());
    }

    #[test]
    fn the_database_connection_needs_tls_unless_a_developer_says_otherwise() {
        let base = "postgres://operations:pw@db.example:5432/operations";
        for mode in ["require", "verify-ca", "verify-full"] {
            assert!(database_options(&format!("{base}?sslmode={mode}"), None, false).is_ok(), "{mode}");
        }
        for mode in ["", "?sslmode=disable", "?sslmode=prefer", "?sslmode=allow"] {
            let reason = database_options(&format!("{base}{mode}"), None, false).err().unwrap();
            assert!(reason.contains("TLS") && !reason.contains("pw"), "{mode}: {reason}");
        }
        assert!(database_options(&format!("{base}?sslmode=disable"), None, true).is_ok());
        let bad = database_options("not a url with secret pw", None, false).err().unwrap();
        assert!(!bad.contains("secret"), "{bad}");
    }

    #[test]
    fn only_the_operations_key_can_sign_for_operations() {
        let key = |kind: &str, id: &str| format!(r#"{{"kind":"{kind}","id":"{id}","domainId":"development","privateKey":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}}"#);
        assert!(client_from_key("http://127.0.0.1:1", key("service", "operations").as_bytes(), None, None).is_ok());
        assert!(client_from_key("http://127.0.0.1:1", key("agent", "agent/fleet-reader").as_bytes(), None, None).is_err());
        assert!(client_from_key("http://127.0.0.1:1", key("service", "operations").as_bytes(), Some("other"), None).is_ok(), "the environment names the domain");
        assert!(client_from_key("http://127.0.0.1:1", br#"{"kind":"service","id":"operations","privateKey":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}"#, None, None).is_err(), "no domain anywhere");
        assert!(client_from_key("http://127.0.0.1:1", b"nope", None, None).is_err());
    }
}
