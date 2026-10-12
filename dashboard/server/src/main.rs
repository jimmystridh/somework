mod assertion;
mod auth;
mod certs;
mod events;
mod history;
mod jobs;
mod ops;
mod prometheus;
mod proxmox;
mod setup;
mod somework;
mod usage;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{any, get, post},
};
use tower::ServiceExt as _;
use axum_server::tls_rustls::RustlsConfig;
use base64::{Engine, engine::general_purpose::STANDARD};
use fleet_shared::{Agent, Fleet, Heartbeat, somework::SomeWork, timestamp_ms};
use sha2::{Digest, Sha256};
use std::{
    env,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use tokio::{
    fs,
    sync::{Mutex, RwLock},
};
use tower_http::services::{ServeDir, ServeFile};

struct AppState {
    fleet: RwLock<Fleet>,
    somework: Arc<RwLock<SomeWork>>,
    heartbeat: Mutex<Option<Heartbeat>>,
    proxy_token: String,
    heartbeat_token: String,
    data: PathBuf,
    csp: HeaderValue,
    preview: bool,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    rustls::crypto::ring::default_provider()
        .install_default()
        .ok();
    let secrets = PathBuf::from(env::var("SECRETS_DIR").unwrap_or_else(|_| "/run/secrets".into()));
    let arguments: Vec<String> = env::args().collect();
    if arguments.iter().any(|arg| arg == "--operations-keygen") {
        println!("{}", ops::keygen::run(&arguments)?);
        return Ok(());
    }
    if env::args().any(|arg| arg == "--healthcheck") {
        let client = reqwest::Client::builder()
            .add_root_certificate(reqwest::Certificate::from_pem(
                &fs::read(secrets.join("ca.crt")).await?,
            )?)
            .resolve(
                "admin-cloud-services",
                SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 8443),
            )
            .timeout(Duration::from_secs(3))
            .build()?;
        client
            .get("https://admin-cloud-services:8443/healthz")
            .send()
            .await?
            .error_for_status()?;
        return Ok(());
    }
    let preview = env::var("FLEET_PREVIEW").is_ok_and(|value| value == "1");
    let data = PathBuf::from(env::var("DATA_DIR").unwrap_or_else(|_| "/data".into()));
    let public = PathBuf::from(env::var("PUBLIC_DIR").unwrap_or_else(|_| "/app/public".into()));
    fs::create_dir_all(&data).await?;
    let heartbeat = fs::read(data.join("pi.json"))
        .await
        .ok()
        .and_then(|body| serde_json::from_slice::<Heartbeat>(&body).ok());
    let index = fs::read_to_string(public.join("index.html")).await?;
    let state = Arc::new(AppState {
        fleet: RwLock::new(Fleet {
            error: Some("Waiting for the first hypervisor sample".into()),
            ..Default::default()
        }),
        somework: Arc::new(RwLock::new(SomeWork {
            error: Some("Waiting for the first SomeWork sample".into()),
            ..Default::default()
        })),
        heartbeat: Mutex::new(heartbeat),
        proxy_token: if preview {
            String::new()
        } else {
            credential(&secrets, "proxy-token").await?
        },
        heartbeat_token: if preview {
            "preview-heartbeat".into()
        } else {
            credential(&secrets, "heartbeat-token").await?
        },
        data,
        csp: HeaderValue::from_str(&content_policy(&index))?,
        preview,
    });
    if !preview {
        let client = proxmox::Proxmox::new(
            env::var("PVE_URL").unwrap_or_else(|_| "https://crazy-goldswine:8006".into()),
            credential(&secrets, "pve-token").await?,
            &fs::read(secrets.join("pve-ca.crt")).await?,
        )?;
        tokio::spawn(collect(state.clone(), client));
    }
    match somework_collector(&secrets, preview).await {
        Ok(Some(collector)) => {
            println!("SomeWork reader identity {}", collector.issuer());
            tokio::spawn(collect_somework(state.clone(), collector));
        }
        Ok(None) => {
            state.somework.write().await.error = Some("SomeWork integration is not configured on this dashboard".into());
        }
        Err(reason) => {
            eprintln!("SomeWork integration disabled: {reason}");
            state.somework.write().await.error = Some(format!("SomeWork integration is unavailable: {reason}"));
        }
    }
    let port = env::var("PORT").unwrap_or_else(|_| "8443".into()).parse()?;
    let address = SocketAddr::from((
        if preview {
            [127, 0, 0, 1]
        } else {
            [0, 0, 0, 0]
        },
        port,
    ));
    let operations = ops::start(ops::StartInputs {
        secrets: &secrets,
        loopback: address.ip().is_loopback(),
        sample: state.somework.clone(),
        targets: agent_targets(&secrets).await.unwrap_or_default(),
    })
    .await?;
    match &operations {
        Some(_) => println!("Operations is on"),
        None => println!("Operations is off (no DATABASE_URL)"),
    }
    let app = application(state, public, operations);
    println!("Fleet Rust/Dioxus service listening");
    if preview {
        axum::serve(tokio::net::TcpListener::bind(address).await?, app)
            .with_graceful_shutdown(shutdown())
            .await?;
    } else {
        let config =
            RustlsConfig::from_pem_file(secrets.join("server.crt"), secrets.join("server.key"))
                .await?;
        let handle = axum_server::Handle::new();
        let termination = handle.clone();
        tokio::spawn(async move {
            shutdown().await;
            termination.graceful_shutdown(Some(Duration::from_secs(5)));
        });
        axum_server::bind_rustls(address, config)
            .handle(handle)
            .serve(app.into_make_service())
            .await?;
    }
    Ok(())
}

fn application(state: Arc<AppState>, public: PathBuf, operations: Option<Arc<ops::Ops>>) -> Router {
    Router::new()
        .route(
            "/healthz",
            get(|| async { Json(serde_json::json!({"ok":true})) }),
        )
        .route("/ingest/pi", post(ingest))
        .nest("/fleet/", dashboard(public, operations))
        .layer(DefaultBodyLimit::max(16 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), gateway))
        .with_state(state)
}

/// The old read routes (`/api/fleet`, `/api/somework`) stay readable behind the gateway as before. The Operations routes under `/api/ops` and the
/// sign-in under `/auth` sit behind the gateway too and additionally need an Entra session; without a database they answer 503.
fn dashboard(public: PathBuf, operations: Option<Arc<ops::Ops>>) -> Router<Arc<AppState>> {
    let (api, auth) = match operations {
        Some(operations) => (ops::api::router(operations.clone()), ops::api::auth_router(operations)),
        None => (ops::api::off_router(), ops::api::off_router()),
    };
    Router::new()
        .route("/api/fleet", get(fleet))
        .route("/api/somework", get(somework_view))
        .nest_service("/api/ops", api)
        .nest_service("/auth", auth)
        .route_service("/", ServeFile::new(public.join("index.html")))
        .fallback(single_page(public))
}

/// A page the browser router knows (`/fleet/agents/qa/setup`) opens `index.html`; an unknown API or sign-in path stays a 404, not a page.
fn single_page(public: PathBuf) -> axum::routing::MethodRouter<Arc<AppState>> {
    let files = ServeDir::new(public.clone()).fallback(ServeFile::new(public.join("index.html")));
    any(move |request: Request| {
        let files = files.clone();
        async move {
            let path = request.uri().path();
            if path.starts_with("/api/") || path.starts_with("/auth/") {
                return StatusCode::NOT_FOUND.into_response();
            }
            files.oneshot(request).await.into_response()
        }
    })
}

/// `SOMEWORK_URL` switches the integration on; its key and CA are secrets-directory files. Plain HTTP is only possible in
/// preview mode (a local test against a fake domain), never in a deployment.
async fn somework_collector(secrets: &std::path::Path, preview: bool) -> Result<Option<somework::Collector>, String> {
    let Ok(base) = env::var("SOMEWORK_URL") else { return Ok(None) };
    let plain = preview && env::var("SOMEWORK_ALLOW_HTTP").is_ok_and(|value| value == "1");
    if !plain && !base.starts_with("https://") {
        return Err("SOMEWORK_URL must be https".into());
    }
    let key = fs::read(secrets.join("somework-key.json")).await.map_err(|_| "somework-key.json is missing from the secrets directory".to_string())?;
    let ca = if plain {
        String::new()
    } else {
        fs::read_to_string(secrets.join("somework-ca.pem")).await.map_err(|_| "somework-ca.pem is missing from the secrets directory".to_string())?
    };
    let mut collector = somework::Collector::new(base, ca, &key, plain)?;
    if let Ok(hub_url) = env::var("HUB_URL") {
        // The hub's metrics are open on the private network; the admin statistics need its bearer (file `hub-admin-token`).
        let bearer = fs::read_to_string(secrets.join("hub-admin-token")).await.ok().map(|token| token.trim().to_string()).filter(|token| !token.is_empty());
        let ca = fs::read_to_string(secrets.join("hub-ca.pem")).await.ok();
        collector = collector.with_hub(events::HubClient::new(hub_url, ca.as_deref(), bearer, plain)?);
    }
    collector = collector.with_grafana(env::var("GRAFANA_URL").ok().and_then(|url| events::grafana_base(&url)));
    if let Ok(metrics_url) = env::var("METRICS_URL") {
        // Model usage and cost: the central Prometheus through the read-only Grafana endpoint (a Viewer token and the CA that signed it).
        let token = fs::read_to_string(secrets.join("metrics-token")).await.map_err(|_| "METRICS_URL is set but metrics-token is missing from the secrets directory".to_string())?;
        let ca = fs::read_to_string(secrets.join("metrics-ca.pem")).await.map_err(|_| "METRICS_URL is set but metrics-ca.pem is missing from the secrets directory".to_string())?;
        let datasource = env::var("METRICS_DATASOURCE").unwrap_or_else(|_| "cluster-prometheus".into());
        collector = collector.with_usage(usage::UsageClient::new(metrics_url, token, &ca, datasource)?);
    }
    if let Ok(contents) = fs::read(secrets.join("agents-health.json")).await {
        collector = collector.with_agent_targets(events::parse_agent_targets(&contents)?);
    }
    Ok(Some(collector))
}

/// `agents-health.json` of the secrets directory: the agents whose health endpoints Operations reads and talks to. Missing is not an error.
async fn agent_targets(secrets: &std::path::Path) -> Result<Vec<events::AgentTarget>, String> {
    match fs::read(secrets.join("agents-health.json")).await {
        Ok(contents) => events::parse_agent_targets(&contents),
        Err(_) => Ok(Vec::new()),
    }
}

async fn collect_somework(state: Arc<AppState>, mut collector: somework::Collector) {
    // The domain is read once per tick whatever the number of viewers; viewers only read the cached sample.
    let mut interval = tokio::time::interval(Duration::from_secs(10));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        let sample = collector.sample().await;
        let mut current = state.somework.write().await;
        if sample.observed_at.is_some() || current.observed_at.is_none() {
            *current = sample;
        } else {
            // nothing could be read: keep the last good numbers, but say they are old
            current.error = Some(sample.error.unwrap_or_else(|| "SomeWork is unavailable — showing the last successful sample".into()));
        }
    }
}

async fn somework_view(State(state): State<Arc<AppState>>) -> Json<SomeWork> {
    let mut sample = state.somework.read().await.clone();
    sample.server_time = chrono::Utc::now().to_rfc3339();
    Json(sample)
}

async fn credential(directory: &std::path::Path, name: &str) -> Result<String, std::io::Error> {
    Ok(fs::read_to_string(directory.join(name))
        .await?
        .trim()
        .to_owned())
}

async fn collect(state: Arc<AppState>, mut client: proxmox::Proxmox) {
    let mut interval = tokio::time::interval(Duration::from_secs(15));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        match client.sample().await {
            Ok(sample) => *state.fleet.write().await = sample,
            Err(()) => {
                state.fleet.write().await.error =
                    Some("Hypervisor unavailable — showing the last successful sample".into());
                eprintln!("fleet hypervisor refresh failed");
            }
        }
    }
}

async fn gateway(State(state): State<Arc<AppState>>, request: Request, next: Next) -> Response {
    let path = request.uri().path();
    let bearer = request
        .headers()
        .get("Authorization")
        .and_then(|value| value.to_str().ok());
    let allowed = if path == "/healthz" {
        true
    } else if path == "/ingest/pi" {
        auth::authorized(bearer, &state.heartbeat_token)
    } else if path.starts_with("/fleet/api/ops/") && request.headers().contains_key(ops::SERVICE_TOKEN_HEADER) {
        // a service of the fleet (the Manager) calls Operations directly; the Operations routes check the token themselves and refuse an unknown one
        true
    } else {
        state.preview || auth::authorized(bearer, &state.proxy_token)
    };
    let mut response = if allowed {
        next.run(request).await
    } else {
        StatusCode::FORBIDDEN.into_response()
    };
    let headers = response.headers_mut();
    headers.insert("Cache-Control", HeaderValue::from_static("no-store"));
    headers.insert(
        "X-Content-Type-Options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("Referrer-Policy", HeaderValue::from_static("no-referrer"));
    headers.insert("Content-Security-Policy", state.csp.clone());
    response
}

async fn fleet(State(state): State<Arc<AppState>>) -> Json<Fleet> {
    let now = chrono::Utc::now();
    let mut sample = state.fleet.read().await.clone();
    sample.agents = vec![Agent::from_heartbeat(
        state.heartbeat.lock().await.clone(),
        now.timestamp_millis(),
    )];
    sample.server_time = now.to_rfc3339();
    Json(sample)
}

async fn ingest(
    State(state): State<Arc<AppState>>,
    Json(mut heartbeat): Json<Heartbeat>,
) -> StatusCode {
    if heartbeat
        .validate(chrono::Utc::now().timestamp_millis())
        .is_err()
    {
        return StatusCode::BAD_REQUEST;
    }
    let mut current = state.heartbeat.lock().await;
    if current
        .as_ref()
        .is_some_and(|old| timestamp_ms(&old.observed_at) > timestamp_ms(&heartbeat.observed_at))
    {
        return StatusCode::CONFLICT;
    }
    let body = match serde_json::to_vec(&heartbeat) {
        Ok(body) => body,
        Err(_) => return StatusCode::BAD_REQUEST,
    };
    let temporary = state.data.join("pi.json.tmp");
    let save = async {
        use tokio::io::AsyncWriteExt;
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true).mode(0o600);
        let mut file = options.open(&temporary).await?;
        file.write_all(&body).await?;
        file.sync_all().await?;
        fs::rename(&temporary, state.data.join("pi.json")).await
    };
    if save.await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    *current = Some(heartbeat);
    StatusCode::ACCEPTED
}

fn content_policy(index: &str) -> String {
    let hashes: Vec<_> = index
        .split("<script")
        .skip(1)
        .filter_map(|part| {
            let (attributes, rest) = part.split_once('>')?;
            if attributes.contains("src=") {
                return None;
            }
            let (body, _) = rest.split_once("</script>")?;
            Some(format!(
                "'sha256-{}'",
                STANDARD.encode(Sha256::digest(body.as_bytes()))
            ))
        })
        .collect();
    format!(
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' {}; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'",
        hashes.join(" ")
    )
}

async fn shutdown() {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("signal handler");
    tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, to_bytes};
    use tower::ServiceExt;

    #[tokio::test]
    async fn dashboard_root_and_assets_require_gateway_authentication() {
        let public = env::temp_dir().join(format!(
            "fleet-routing-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        fs::create_dir(&public).await.unwrap();
        fs::write(public.join("index.html"), "<main>Fleet</main>")
            .await
            .unwrap();
        fs::write(public.join("style.css"), "main { color: green; }")
            .await
            .unwrap();
        let state = Arc::new(AppState {
            fleet: RwLock::new(Fleet::default()),
            somework: Arc::new(RwLock::new(SomeWork::default())),
            heartbeat: Mutex::new(None),
            proxy_token: "test-proxy".into(),
            heartbeat_token: "test-heartbeat".into(),
            data: public.clone(),
            csp: HeaderValue::from_static("default-src 'self'"),
            preview: false,
        });
        let app = Router::new()
            .nest("/fleet/", dashboard(public.clone(), None))
            .layer(middleware::from_fn_with_state(state.clone(), gateway))
            .with_state(state);
        for (path, expected) in [
            ("/fleet/", "<main>Fleet</main>"),
            ("/fleet/style.css", "main { color: green; }"),
            ("/fleet/agents/qa/setup", "<main>Fleet</main>"),
        ] {
            let anonymous = app
                .clone()
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(anonymous.status(), StatusCode::FORBIDDEN);
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(path)
                        .header("Authorization", "Bearer test-proxy")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{path}");
            let body = to_bytes(response.into_body(), 1024).await.unwrap();
            assert_eq!(body, expected);
        }
        fs::remove_file(public.join("index.html")).await.unwrap();
        fs::remove_file(public.join("style.css")).await.unwrap();
        fs::remove_dir(public).await.unwrap();
    }

    #[test]
    fn policy_hashes_inline_bootstrap_without_unsafe_inline() {
        let policy = content_policy(
            "<script type=\"module\">bootstrap()</script><script src=\"external.js\"></script>",
        );
        assert!(policy.contains("sha256-"));
        assert!(!policy.contains("unsafe-inline"));
        assert_eq!(policy.matches("sha256-").count(), 1);
    }

    fn test_state(public: &std::path::Path) -> Arc<AppState> {
        Arc::new(AppState {
            fleet: RwLock::new(Fleet::default()),
            somework: Arc::new(RwLock::new(SomeWork::default())),
            heartbeat: Mutex::new(None),
            proxy_token: "test-proxy".into(),
            heartbeat_token: "test-heartbeat".into(),
            data: public.to_path_buf(),
            csp: HeaderValue::from_static("default-src 'self'"),
            preview: false,
        })
    }

    async fn public_dir() -> PathBuf {
        let public = env::temp_dir().join(format!("fleet-ops-routing-{}-{}", std::process::id(), chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        fs::create_dir(&public).await.unwrap();
        fs::write(public.join("index.html"), "<main>Fleet</main>").await.unwrap();
        public
    }

    async fn call(app: &Router, method: &str, path: &str, headers: &[(&str, &str)], body: String) -> (StatusCode, Vec<u8>) {
        let mut request = Request::builder().method(method).uri(path);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let response = app.clone().oneshot(request.body(Body::from(body)).unwrap()).await.unwrap();
        (response.status(), to_bytes(response.into_body(), 1024 * 1024).await.unwrap().to_vec())
    }

    #[tokio::test]
    async fn operations_routes_sit_behind_the_gateway_and_beside_the_old_routes() {
        let Some(pg) = ops::testing::postgres("operations_routes_sit_behind_the_gateway_and_beside_the_old_routes") else { return };
        let store = pg.store("routing").await;
        let public = public_dir().await;
        let state = test_state(&public);
        let operations = ops::testing::stub_ops(&store, fleet_shared::operations::Role::Editor, None, vec![]);
        let app = application(state, public.clone(), Some(operations));
        let gateway = [("Authorization", "Bearer test-proxy")];
        let signed_in = [("Authorization", "Bearer test-proxy"), ("x-operations-request", "1"), ("content-type", "application/json")];

        let (status, _) = call(&app, "GET", "/fleet/api/ops/me", &[], String::new()).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "the gateway still guards every route");
        let (status, body) = call(&app, "GET", "/fleet/api/ops/me", &gateway, String::new()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&body).unwrap()["email"], "editor@example.com");
        assert_eq!(call(&app, "GET", "/fleet/api/somework", &gateway, String::new()).await.0, StatusCode::OK, "the old read routes keep working behind the gateway alone");
        assert_eq!(call(&app, "GET", "/fleet/api/fleet", &gateway, String::new()).await.0, StatusCode::OK);
        let (status, body) = call(&app, "GET", "/fleet/", &gateway, String::new()).await;
        assert_eq!((status, body.as_slice()), (StatusCode::OK, &b"<main>Fleet</main>"[..]), "the page is still served");
        assert_eq!(call(&app, "GET", "/healthz", &[], String::new()).await.0, StatusCode::OK);

        let skill = serde_json::json!({"baseVersion": 0, "content": format!("---\ndescription: big\n---\n{}", "x".repeat(40 * 1024))}).to_string();
        assert!(skill.len() > 16 * 1024);
        let (status, body) = call(&app, "PUT", "/fleet/api/ops/library/big", &signed_in, skill).await;
        assert_eq!(status, StatusCode::OK, "ops bodies may be larger than the 16 KiB of the heartbeat route: {}", String::from_utf8_lossy(&body));
        let (status, _) = call(&app, "POST", "/ingest/pi", &[("Authorization", "Bearer test-heartbeat"), ("content-type", "application/json")], "x".repeat(20 * 1024)).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "the heartbeat route keeps its small limit");
        let too_big = serde_json::json!({"baseVersion": 0, "content": "x".repeat(2 * 1024 * 1024)}).to_string();
        assert_eq!(call(&app, "PUT", "/fleet/api/ops/library/huge", &signed_in, too_big).await.0, StatusCode::PAYLOAD_TOO_LARGE);
        let _ = fs::remove_dir_all(&public).await;
    }

    #[tokio::test]
    async fn a_service_token_reaches_only_the_operations_routes_without_the_proxy_token() {
        let Some(pg) = ops::testing::postgres("a_service_token_reaches_only_the_operations_routes_without_the_proxy_token") else { return };
        let store = pg.store("service_routing").await;
        let public = public_dir().await;
        let digest = ops::contract::sha256_hex(b"manager-token");
        let tokens = ops::service::parse(&format!(r#"[{{"name": "agent/manager", "sha256": "{digest}", "role": "editor"}}]"#)).unwrap();
        let stub = ops::AuthMode::Stub(ops::StubUser { email: "viewer@example.com".into(), role: fleet_shared::operations::Role::Viewer });
        let app = application(test_state(&public), public.clone(), Some(ops::testing::ops_with_services(&store, stub, None, vec![], tokens)));

        let (status, body) = call(&app, "GET", "/fleet/api/ops/me", &[("x-operations-service-token", "manager-token")], String::new()).await;
        assert_eq!(status, StatusCode::OK, "no proxy token is needed with a service token");
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&body).unwrap()["email"], "agent/manager");
        assert_eq!(call(&app, "GET", "/fleet/api/ops/me", &[("x-operations-service-token", "guess")], String::new()).await.0, StatusCode::UNAUTHORIZED);
        assert_eq!(call(&app, "GET", "/fleet/api/somework", &[("x-operations-service-token", "manager-token")], String::new()).await.0, StatusCode::FORBIDDEN, "the old routes still need the proxy token");
        assert_eq!(call(&app, "GET", "/fleet/api/ops/me", &[], String::new()).await.0, StatusCode::FORBIDDEN);
        let _ = fs::remove_dir_all(&public).await;
    }

    #[tokio::test]
    async fn without_a_database_the_operations_routes_say_so_and_the_rest_works() {
        let public = public_dir().await;
        let app = application(test_state(&public), public.clone(), None);
        let gateway = [("Authorization", "Bearer test-proxy")];
        for path in ["/fleet/api/ops/me", "/fleet/api/ops/agents", "/fleet/auth/login"] {
            let (status, body) = call(&app, "GET", path, &gateway, String::new()).await;
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{path}");
            assert_eq!(serde_json::from_slice::<serde_json::Value>(&body).unwrap()["code"], "unavailable");
        }
        assert_eq!(call(&app, "GET", "/fleet/api/somework", &gateway, String::new()).await.0, StatusCode::OK);
        let _ = fs::remove_dir_all(&public).await;
    }
}
