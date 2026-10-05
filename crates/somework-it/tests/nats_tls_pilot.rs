//! The pilot topology's transport: a TLS-only private broker, the domain and the worker both verifying it against the
//! private CA, and the rendered broker configuration actually enforcing TLS and bounded storage.

use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
    time::Duration,
};

use futures::FutureExt;
use serde_json::json;
use somework_core::{contracts::SideEffects, fsm::TaskState};
use somework_domain::policy::Permissions;
use somework_sidecar::{
    config::{TlsConfig, WakeMode, WorkerConfig},
    worker::{
        Worker,
        adapter::{AdapterOutcome, CallbackAdapter},
    },
};
use somework_testkit::{
    StackBuilder, capability,
    nats::{ADMIN_PASSWORD, ADMIN_USER, NatsServer},
    pki::Ca,
    process::{ChildGuard, eventually, free_port, repo_root, tool, wait_for_port},
};
use tokio_util::sync::CancellationToken;

fn read_perms() -> Permissions {
    let mut p = Permissions::default_agent();
    p.side_effects_at_most = Some(SideEffects::Read);
    p
}

fn worker_config(tls: TlsConfig) -> WorkerConfig {
    // reconciliation is pushed far out, so a completed task proves the TLS NATS path itself delivered the wake-up
    WorkerConfig {
        wake: WakeMode::Nats,
        reconcile_seconds: 100_000,
        poll_wait_seconds: 1,
        lease_seconds: 30,
        progress_throttle_ms: 50,
        tls,
        ..Default::default()
    }
}

fn approving_adapter() -> Arc<CallbackAdapter> {
    Arc::new(CallbackAdapter::new(|_job, _ctl| async { AdapterOutcome::Completed { result: json!({"verdict": "approve"}), artifacts: vec![] } }.boxed()))
}

#[tokio::test]
async fn domain_and_worker_exchange_wakes_over_a_tls_only_broker() {
    let ca = Ca::new("pilot ca");
    let nats = NatsServer::start_tls("development", &ca).await;
    let plane = nats.plane_config();
    let stack = StackBuilder::new().config(move |c| c.nats = Some(plane)).start().await;
    let worker = stack.worker("agent/reviewer", vec![capability("code.review", "2.1", "read", "Review pull requests")], read_perms()).await;
    let author = stack.requester("agent/author", &["code.review"], SideEffects::Read).await;

    let tls = TlsConfig { required: true, ca_file: Some(nats.ca_file()) };
    let running = Worker::new(worker.client.clone(), worker.id.clone(), worker_config(tls), approving_adapter());
    let stop = CancellationToken::new();
    let token = stop.clone();
    let ended: Arc<std::sync::Mutex<Option<String>>> = Arc::default();
    let report = ended.clone();
    let handle = tokio::spawn(async move {
        let outcome = running.run(token).await;
        *report.lock().unwrap() = Some(format!("{outcome:?}"));
    });

    let task = author
        .client
        .submit_task(&json!({"capability": {"id": "code.review", "version": "2.1"}, "input": {"repository": "billing/import-service"}}), None)
        .await
        .unwrap();
    eventually("the task to succeed over TLS NATS", Duration::from_secs(40), || async {
        if let Some(outcome) = ended.lock().unwrap().clone() {
            panic!("the worker stopped before the task completed: {outcome}");
        }
        (author.client.get_task(&task.task_id).await.ok()?.state == TaskState::Succeeded).then_some(())
    })
    .await;

    stop.cancel();
    let _ = handle.await;
    stack.stop().await;
}

#[tokio::test]
async fn a_worker_that_requires_nats_refuses_a_broker_it_cannot_verify() {
    let ca = Ca::new("pilot ca");
    let impostor_ca = Ca::new("somebody else");
    let nats = NatsServer::start_tls("development", &ca).await;
    let plane = nats.plane_config();
    let stack = StackBuilder::new().config(move |c| c.nats = Some(plane)).start().await;
    let worker = stack.worker("agent/reviewer", vec![capability("code.review", "2.1", "read", "Review pull requests")], read_perms()).await;

    let dir = tempfile::tempdir().unwrap();
    let wrong_ca = dir.path().join("wrong-ca.pem");
    std::fs::write(&wrong_ca, &impostor_ca.cert_pem).unwrap();
    let running =
        Worker::new(worker.client.clone(), worker.id.clone(), worker_config(TlsConfig { required: true, ca_file: Some(wrong_ca) }), approving_adapter());
    let outcome =
        tokio::time::timeout(Duration::from_secs(30), running.run(CancellationToken::new())).await.expect("wake = nats fails fast instead of limping along");
    assert!(outcome.is_err(), "the worker must not start on a broker whose certificate it cannot verify");
    stack.stop().await;
}

fn somework_binary() -> PathBuf {
    let status =
        Command::new(env!("CARGO")).args(["build", "-q", "-p", "somework-api", "--bin", "somework"]).current_dir(repo_root()).status().expect("cargo build");
    assert!(status.success(), "building the somework binary failed");
    let target = std::env::var_os("CARGO_TARGET_DIR").map(PathBuf::from).unwrap_or_else(|| repo_root().join("target"));
    target.join("debug/somework")
}

fn write(path: &Path, content: &str) {
    std::fs::write(path, content).unwrap();
}

#[tokio::test]
async fn the_rendered_broker_config_enforces_tls_and_bounded_storage() {
    let bin = somework_binary();
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    let ca = Ca::new("pilot ca");
    let leaf = ca.leaf("nats");
    write(&d.join("server.pem"), &leaf.cert_pem);
    write(&d.join("server.key"), &leaf.key_pem);
    write(&d.join("ca.pem"), &ca.cert_pem);
    let port = free_port();
    let config = d.join("somework.toml");
    write(
        &config,
        &format!(
            "[domain]\nid = \"development\"\ndb = \"{db}\"\nlisten = \"127.0.0.1:{http}\"\n[nats]\nurl = \"tls://127.0.0.1:{port}\"\nuser = \"{ADMIN_USER}\"\npassword = \"{ADMIN_PASSWORD}\"\nusers_file = \"{users}\"\ntls_required = true\ntls_ca_file = \"{ca}\"\n",
            db = d.join("somework.db").display(),
            http = free_port(),
            users = d.join("users.conf").display(),
            ca = d.join("ca.pem").display(),
        ),
    );
    let output = Command::new(&bin)
        .args(["admin", "--config"])
        .arg(&config)
        .args(["render-nats-conf", "--out-dir"])
        .arg(d)
        .args(["--host", "127.0.0.1", "--port", &port.to_string(), "--store-dir"])
        .arg(d.join("js"))
        .arg("--pid-file")
        .arg(d.join("nats.pid"))
        .arg("--tls-cert")
        .arg(d.join("server.pem"))
        .arg("--tls-key")
        .arg(d.join("server.key"))
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));

    let conf = std::fs::read_to_string(d.join("nats-server.conf")).unwrap();
    assert!(conf.contains("max_file_store: 5GB") && conf.contains("max_memory_store: 256MB"), "storage is bounded by default:\n{conf}");
    assert!(conf.contains("tls {"), "{conf}");
    let mode = std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(d.join("nats-server.conf")).unwrap().permissions()) & 0o777;
    assert_eq!(mode, 0o600, "the config holds credentials");

    let mut cmd = Command::new(tool("nats-server"));
    cmd.arg("-c").arg(d.join("nats-server.conf"));
    let _broker = ChildGuard::spawn("nats-server", cmd);
    wait_for_port(port, Duration::from_secs(10)).await;

    let url = format!("nats://127.0.0.1:{port}");
    somework_sidecar::tls::install_crypto_provider();
    let trusted = async_nats::ConnectOptions::with_user_and_password(ADMIN_USER.into(), ADMIN_PASSWORD.into())
        .require_tls(true)
        .add_root_certificates(d.join("ca.pem"))
        .connect(&url)
        .await
        .expect("the domain login works over TLS with the private CA");
    trusted.flush().await.unwrap();
    assert!(async_nats::jetstream::new(trusted).query_account().await.is_ok(), "JetStream is enabled for the domain account");

    let plaintext_attempt = tokio::time::timeout(
        Duration::from_secs(8),
        async_nats::ConnectOptions::with_user_and_password(ADMIN_USER.into(), ADMIN_PASSWORD.into())
            .no_echo()
            .connection_timeout(Duration::from_secs(3))
            .connect(&url),
    )
    .await;
    // without the private CA the platform trust store rejects the broker's certificate
    assert!(!matches!(plaintext_attempt, Ok(Ok(_))), "a client that does not trust the private CA must not get in");
}
