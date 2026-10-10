//! Transport security of the connection the sidecar (and every Rust client) opens to the domain: a client that requires TLS
//! must refuse an untrusted CA and a certificate for the wrong name.

use std::{path::Path, sync::Arc};

use rustls::pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};
use serde_json::json;
use somework_client::Client;
use somework_testkit::pki::{Ca, Identity};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn write_ca(dir: &Path, name: &str, ca: &Ca) -> std::path::PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, &ca.cert_pem).unwrap();
    path
}

/// A one-endpoint HTTPS server: answers every request with `{}`.
async fn https_server(identity: &Identity) -> u16 {
    let _ = rustls::crypto::ring::default_provider().install_default();
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
