mod assertion;
mod auth;
mod certs;
mod events;
mod history;
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
    routing::{get, post},
};
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
    somework: RwLock<SomeWork>,
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
        somework: RwLock::new(SomeWork {
            error: Some("Waiting for the first SomeWork sample".into()),
            ..Default::default()
        }),
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
    let app = Router::new()
        .route(
            "/healthz",
            get(|| async { Json(serde_json::json!({"ok":true})) }),
        )
        .route("/ingest/pi", post(ingest))
        .nest("/fleet/", dashboard(public))
        .layer(DefaultBodyLimit::max(16 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), gateway))
        .with_state(state);
    let port = env::var("PORT").unwrap_or_else(|_| "8443".into()).parse()?;
    let address = SocketAddr::from((
        if preview {
            [127, 0, 0, 1]
        } else {
            [0, 0, 0, 0]
        },
        port,
    ));
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

fn dashboard(public: PathBuf) -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/fleet", get(fleet))
        .route("/api/somework", get(somework_view))
        .route_service("/", ServeFile::new(public.join("index.html")))
        .fallback_service(ServeDir::new(public))
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
            somework: RwLock::new(SomeWork::default()),
            heartbeat: Mutex::new(None),
            proxy_token: "test-proxy".into(),
            heartbeat_token: "test-heartbeat".into(),
            data: public.clone(),
            csp: HeaderValue::from_static("default-src 'self'"),
            preview: false,
        });
        let app = Router::new()
            .nest("/fleet/", dashboard(public.clone()))
            .layer(middleware::from_fn_with_state(state.clone(), gateway))
            .with_state(state);
        for (path, expected) in [
            ("/fleet/", "<main>Fleet</main>"),
            ("/fleet/style.css", "main { color: green; }"),
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
}
