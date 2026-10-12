//! A throwaway Postgres for the tests: `initdb` in a temporary directory, a random port on 127.0.0.1, removed when the guard drops.
//! Without the binaries a test says so on stderr (not captured by the harness) and does not run; `REQUIRE_POSTGRES=1` turns that into a failure.

use super::store::Store;
use std::{
    io::Write,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

pub struct TestPostgres {
    dir: PathBuf,
    bin: PathBuf,
    pub port: u16,
}

fn bin_dir() -> Option<PathBuf> {
    let has_all = |dir: &Path| ["initdb", "postgres", "pg_ctl"].iter().all(|name| dir.join(name).is_file());
    if let Ok(dir) = std::env::var("POSTGRES_BIN_DIR") {
        return has_all(Path::new(&dir)).then(|| PathBuf::from(dir));
    }
    let path = std::env::var("PATH").unwrap_or_default();
    let candidates = path.split(':').map(PathBuf::from).chain(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from)).chain(
        std::fs::read_dir("/usr/lib/postgresql").into_iter().flatten().flatten().map(|version| version.path().join("bin")),
    );
    candidates.into_iter().find(|dir| has_all(dir))
}

/// Starts a cluster, or says why a test cannot run. Panics only when `REQUIRE_POSTGRES=1`.
pub fn postgres(test: &str) -> Option<TestPostgres> {
    match TestPostgres::start() {
        Ok(cluster) => Some(cluster),
        Err(reason) => {
            let message = format!("SKIPPED {test}: no Postgres for the integration test ({reason}). Set POSTGRES_BIN_DIR or install postgres; REQUIRE_POSTGRES=1 makes this a failure.");
            assert!(std::env::var("REQUIRE_POSTGRES").map_or(true, |value| value != "1"), "{message}");
            let _ = writeln!(std::io::stderr(), "{message}");
            None
        }
    }
}

impl TestPostgres {
    fn start() -> Result<Self, String> {
        let bin = bin_dir().ok_or("initdb, postgres and pg_ctl were not found")?;
        let port = TcpListener::bind("127.0.0.1:0").and_then(|listener| listener.local_addr()).map_err(|error| error.to_string())?.port();
        let dir = std::env::temp_dir().join(format!("ops-pg-{}-{port}", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        let cluster = Self { dir, bin, port };
        let quiet = |command: &mut Command| command.stdout(Stdio::null()).stderr(Stdio::null()).status().map(|status| status.success()).unwrap_or(false);
        let data = cluster.dir.join("data");
        if !quiet(Command::new(cluster.bin.join("initdb")).args(["-D"]).arg(&data).args(["-U", "postgres", "-A", "trust", "--no-sync", "-E", "UTF8", "--locale=C"])) {
            return Err("initdb failed".into());
        }
        let options = format!("-p {port} -c listen_addresses=127.0.0.1 -c unix_socket_directories= -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=60");
        if !quiet(Command::new(cluster.bin.join("pg_ctl")).arg("-D").arg(&data).arg("-l").arg(cluster.dir.join("log")).args(["-w", "-t", "30", "-o", &options, "start"])) {
            return Err("the cluster did not start".into());
        }
        Ok(cluster)
    }

    pub fn url(&self, database: &str) -> String {
        format!("postgres://postgres@127.0.0.1:{}/{database}?sslmode=disable", self.port)
    }

    /// A migrated store on a database of its own.
    pub async fn store(&self, name: &str) -> Store {
        let admin = sqlx::PgPool::connect(&self.url("postgres")).await.expect("connect to the throwaway cluster");
        sqlx::query(&format!("CREATE DATABASE {name}")).execute(&admin).await.expect("create the test database");
        admin.close().await;
        let options = super::database_options(&self.url(name), None, true).expect("options");
        Store::connect(options).await.expect("migrate the test database")
    }
}

impl Drop for TestPostgres {
    fn drop(&mut self) {
        let _ = Command::new(self.bin.join("pg_ctl")).arg("-D").arg(self.dir.join("data")).args(["-m", "immediate", "-w", "stop"]).stdout(Stdio::null()).stderr(Stdio::null()).status();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

// ------------------------------------------------------------------------------------------------------------- fixtures

use super::{AuthMode, Ops, StubUser, delivery::Deliverer, reconcile::{Observations, Reconciler}, session::SignedCookies};
use crate::events::AgentTarget;
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    http::{HeaderMap, Request, StatusCode},
    routing::get,
};
use fleet_shared::operations::Role;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tokio::sync::{Notify, RwLock};
use tower::ServiceExt;

pub fn ops_with(store: &Store, auth: AuthMode, deliverer: Option<Arc<Deliverer>>, targets: Vec<AgentTarget>) -> Arc<Ops> {
    ops_with_services(store, auth, deliverer, targets, Vec::new())
}

pub fn ops_with_services(store: &Store, auth: AuthMode, deliverer: Option<Arc<Deliverer>>, targets: Vec<AgentTarget>, service_tokens: Vec<super::service::ServiceToken>) -> Arc<Ops> {
    let observations = Arc::new(Observations::default());
    let nudge = Arc::new(Notify::new());
    let sending_configured = deliverer.is_some();
    let reconciler = Arc::new(Reconciler::new(store.clone(), deliverer, targets.clone(), crate::events::agent_http_client().unwrap(), observations.clone(), nudge.clone()));
    Arc::new(Ops { store: store.clone(), auth, service_tokens, cookies: SignedCookies::new(b"test key test key test key test key"), observations, reconciler, sample: Arc::new(RwLock::new(Default::default())), targets, nudge, sending_configured })
}

pub fn stub_ops(store: &Store, role: Role, deliverer: Option<Arc<Deliverer>>, targets: Vec<AgentTarget>) -> Arc<Ops> {
    ops_with(store, AuthMode::Stub(StubUser { email: format!("{}@example.com", role.label()), role }), deliverer, targets)
}

/// One request against a router; the body is JSON and so is the answer (`Null` when it is not JSON).
pub async fn send(app: &Router, method: &str, path: &str, body: Option<Value>, headers: &[(&str, &str)]) -> (StatusCode, Value, HeaderMap) {
    let mut request = Request::builder().method(method).uri(path);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let request = match body {
        Some(body) => request.header("content-type", "application/json").body(Body::from(body.to_string())).unwrap(),
        None => request.body(Body::empty()).unwrap(),
    };
    let response = app.clone().oneshot(request).await.unwrap();
    let (status, headers) = (response.status(), response.headers().clone());
    let bytes = to_bytes(response.into_body(), 16 * 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null), headers)
}

/// A write as the console's page makes it.
pub const WRITE: &[(&str, &str)] = &[("x-operations-request", "1")];

/// An agent's health endpoint: `/status` answers, `/profile` answers with whatever the shared value holds (`None`: 503).
pub async fn fake_agent(id: &str, profile: Option<Value>) -> (AgentTarget, Arc<Mutex<Option<Value>>>) {
    let shared = Arc::new(Mutex::new(profile));
    let state = shared.clone();
    let app = Router::new().route("/status", get(|| async { Json(serde_json::json!({})) })).route(
        "/profile",
        get(move || {
            let state = state.clone();
            async move {
                match state.lock().unwrap().clone() {
                    Some(profile) => (StatusCode::OK, Json(profile)),
                    None => (StatusCode::SERVICE_UNAVAILABLE, Json(Value::Null)),
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/status", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (AgentTarget { id: id.into(), url, logs: None }, shared)
}

/// A profile as a kit agent that takes setup documents serves it.
pub fn profile(role: &str, override_revision: Option<u64>, limits_revision: Option<u64>) -> Value {
    serde_json::json!({
        "schema": 1, "role": role, "agentId": "agent/x", "version": "t", "hash": "abcdef0123456789",
        "setup": {
            "override": override_revision.map(|revision| serde_json::json!({"revision": revision, "hash": "h", "appliedAt": "2026-10-10T10:00:00.000Z"})),
            "limits": limits_revision.map(|revision| serde_json::json!({"revision": revision, "appliedAt": "2026-10-10T10:00:00.000Z"})),
        }
    })
}

/// A session payload for someone else, to show a cookie cannot be forged by changing it.
pub fn forged_payload(email: &str) -> String {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    URL_SAFE_NO_PAD.encode(format!(r#"{{"email":"{email}","issued":1,"expires":99999999999}}"#))
}
