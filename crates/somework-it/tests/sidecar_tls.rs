//! Transport security of the connections the sidecar opens itself: a worker that requires TLS must refuse plaintext, an
//! untrusted CA and a certificate for the wrong name, for both NATS and the domain's HTTPS endpoint.

use std::{path::Path, process::Command, sync::Arc, time::Duration};

use rustls::pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};
use serde_json::json;
use somework_client::Client;
use somework_sidecar::{config::TlsConfig, worker::wake::NatsInfo};
use somework_testkit::{
    pki::{Ca, Identity},
    process::{ChildGuard, free_port, repo_root, tool, wait_for_port},
};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct TlsNats {
    _dir: TempDir,
    _child: ChildGuard,
    port: u16,
}

async fn nats_server(identity: Option<&Identity>) -> TlsNats {
    let dir = TempDir::new().unwrap();
    let port = free_port();
    let mut conf = format!("host: 127.0.0.1\nport: {port}\n");
    if let Some(id) = identity {
        std::fs::write(dir.path().join("server.pem"), &id.cert_pem).unwrap();
        std::fs::write(dir.path().join("server.key"), &id.key_pem).unwrap();
        conf += &format!("tls {{\n  cert_file: \"{0}/server.pem\"\n  key_file: \"{0}/server.key\"\n  timeout: 3\n}}\n", dir.path().display());
    }
    let conf_file = dir.path().join("nats.conf");
    std::fs::write(&conf_file, conf).unwrap();
    let mut cmd = Command::new(tool("nats-server"));
    cmd.arg("-c").arg(&conf_file);
    let child = ChildGuard::spawn("nats-server", cmd);
    wait_for_port(port, Duration::from_secs(10)).await;
    TlsNats { _dir: dir, _child: child, port }
}

fn info(port: u16) -> NatsInfo {
    NatsInfo {
        url: format!("nats://127.0.0.1:{port}"),
        user: None,
        password: None,
        token: None,
        work_stream: "w".into(),
        inbox_stream: "i".into(),
        pool_consumers: vec![],
        inbox_consumer: None,
    }
}

fn write_ca(dir: &Path, name: &str, ca: &Ca) -> std::path::PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, &ca.cert_pem).unwrap();
    path
}

fn tls(required: bool, ca: Option<std::path::PathBuf>) -> TlsConfig {
    TlsConfig { required, ca_file: ca }
}

async fn connects(server: &TlsNats, tls: &TlsConfig) -> bool {
    match tokio::time::timeout(Duration::from_secs(8), info(server.port).connect(tls)).await {
        Ok(Ok(client)) => client.flush().await.is_ok(),
        _ => false,
    }
}

#[tokio::test]
async fn nats_accepts_only_a_trusted_certificate_for_the_right_name() {
    let work = TempDir::new().unwrap();
    let ca = Ca::new("somework test ca");
    let other_ca = Ca::new("some other ca");
    let ca_file = write_ca(work.path(), "ca.pem", &ca);
    let other_file = write_ca(work.path(), "other.pem", &other_ca);

    let good = nats_server(Some(&ca.leaf("nats"))).await;
    assert!(connects(&good, &tls(true, Some(ca_file.clone()))).await, "the private CA and a matching certificate are accepted");
    assert!(!connects(&good, &tls(true, Some(other_file))).await, "a certificate from an untrusted CA is rejected");
    assert!(!connects(&good, &tls(true, None)).await, "without the private CA the platform trust store does not vouch for it");

    let wrong_name = nats_server(Some(&ca.leaf_for_dns("nats.elsewhere.internal"))).await;
    assert!(!connects(&wrong_name, &tls(true, Some(ca_file.clone()))).await, "a certificate for another name is rejected even from the trusted CA");

    let plaintext = nats_server(None).await;
    assert!(!connects(&plaintext, &tls(true, Some(ca_file))).await, "a plaintext server is refused when TLS is required");
    assert!(connects(&plaintext, &tls(false, None)).await, "control: without the requirement the same plaintext server works");
}

/// A one-endpoint HTTPS server: answers every request with `{}`.
async fn https_server(identity: &Identity) -> u16 {
    somework_sidecar::tls::install_crypto_provider();
    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(identity.cert_pem.as_bytes()).collect::<Result<_, _>>().unwrap();
    let key = PrivateKeyDer::from_pem_slice(identity.key_pem.as_bytes()).unwrap();
    let config = rustls::ServerConfig::builder().with_no_client_auth().with_single_cert(certs, key).unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = listener.accept().await else { return };
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let Ok(mut stream) = acceptor.accept(tcp).await else { return };
                let mut buf = vec![0u8; 8192];
                let _ = stream.read(&mut buf).await;
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}").await;
                let _ = stream.shutdown().await;
            });
        }
    });
    port
}

fn client_for(port: u16, host: &str) -> Client {
    Client::assertion(format!("https://{host}:{port}"), somework_core::jws::new_signing_key(), "agent", "agent/worker", "development").with_retries(0)
}

#[tokio::test]
async fn the_domain_https_endpoint_is_trusted_only_through_the_configured_ca() {
    let work = TempDir::new().unwrap();
    let ca = Ca::new("somework test ca");
    let other_ca = Ca::new("some other ca");
    let ca_file = write_ca(work.path(), "ca.pem", &ca);
    let other_file = write_ca(work.path(), "other.pem", &other_ca);
    let port = https_server(&ca.leaf("domain")).await;

    let trusted = client_for(port, "127.0.0.1").with_ca_file(&ca_file).unwrap();
    assert_eq!(trusted.get("/healthz").await.expect("trusted CA and matching name"), json!({}));

    let untrusted = client_for(port, "127.0.0.1").with_ca_file(&other_file).unwrap();
    assert!(untrusted.get("/healthz").await.is_err(), "a different CA must not be trusted");

    let platform_only = client_for(port, "127.0.0.1");
    assert!(platform_only.get("/healthz").await.is_err(), "a private CA is unknown to the platform trust store");

    let wrong_name_port = https_server(&ca.leaf_for_dns("domain.elsewhere.internal")).await;
    let wrong_name = client_for(wrong_name_port, "127.0.0.1").with_ca_file(&ca_file).unwrap();
    assert!(wrong_name.get("/healthz").await.is_err(), "a certificate for another name is rejected");

    assert!(client_for(port, "127.0.0.1").with_ca_file(&work.path().join("missing.pem")).is_err(), "an unreadable CA file is a startup error");
    std::fs::write(work.path().join("empty.pem"), "not a certificate").unwrap();
    assert!(client_for(port, "127.0.0.1").with_ca_file(&work.path().join("empty.pem")).is_err(), "a bundle without certificates is a startup error");
}

#[tokio::test]
async fn certificates_from_the_pilot_ca_script_are_accepted_by_the_sidecar() {
    let dir = TempDir::new().unwrap();
    let script = repo_root().join("deploy/scripts/make-private-ca.sh");
    let status = Command::new(&script)
        .arg(dir.path())
        .arg("nats=127.0.0.1,localhost")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "make-private-ca.sh failed");

    let port = free_port();
    let conf = dir.path().join("nats.conf");
    std::fs::write(
        &conf,
        format!("host: 127.0.0.1\nport: {port}\ntls {{\n  cert_file: \"{0}/nats.pem\"\n  key_file: \"{0}/nats.key\"\n  timeout: 3\n}}\n", dir.path().display()),
    )
    .unwrap();
    let mut cmd = Command::new(tool("nats-server"));
    cmd.arg("-c").arg(&conf);
    let server = TlsNats { _dir: TempDir::new().unwrap(), _child: ChildGuard::spawn("nats-server", cmd), port };
    wait_for_port(port, Duration::from_secs(10)).await;

    assert!(connects(&server, &tls(true, Some(dir.path().join("ca.pem")))).await, "the sidecar trusts certificates issued by the script's CA");
    assert!(!connects(&server, &tls(true, None)).await, "and only through that CA");
}
