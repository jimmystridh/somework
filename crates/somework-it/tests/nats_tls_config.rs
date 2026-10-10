//! The pilot topology's transport: the rendered broker configuration actually enforces TLS and bounded storage.

use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use somework_testkit::{
    nats::{ADMIN_PASSWORD, ADMIN_USER},
    pki::Ca,
    process::{ChildGuard, free_port, repo_root, tool, wait_for_port},
};

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
    let _ = rustls::crypto::ring::default_provider().install_default();
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
