//! Mutual TLS for the federation listener and the outbound peer client. Peers authenticate by a *pinned* client
//! certificate (registered thumbprint) rather than a CA hierarchy, so revoking a peer takes effect at the next
//! handshake and again at every request.

use std::{collections::HashSet, sync::Arc, time::Duration};

use axum::Router;
use hyper_util::{
    rt::{TokioExecutor, TokioIo},
    server::conn::auto::Builder,
    service::TowerToHyperService,
};
use parking_lot::RwLock;
use rustls::{
    DigitallySignedStruct, DistinguishedName, Error as TlsError, RootCertStore, SignatureScheme,
    client::danger::HandshakeSignatureValid,
    crypto::{CryptoProvider, aws_lc_rs},
    pki_types::{CertificateDer, PrivateKeyDer, UnixTime, pem::PemObject},
    server::danger::{ClientCertVerified, ClientCertVerifier},
};
use sha2::{Digest, Sha256};
use somework_core::Error;
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tokio_util::sync::CancellationToken;
use tower::Layer;
use tower_http::add_extension::AddExtensionLayer;

use crate::peers::Peers;

/// SHA-256 thumbprint (lower-case hex) of the client certificate presented on the TLS connection.
#[derive(Debug, Clone)]
pub struct PeerCert(pub Option<String>);

pub fn thumbprint(der: &[u8]) -> String {
    hex::encode(Sha256::digest(der))
}

pub fn thumbprint_of_pem(pem: &str) -> Result<String, Error> {
    let cert = CertificateDer::pem_slice_iter(pem.as_bytes())
        .next()
        .ok_or_else(|| Error::invalid("no certificate in PEM"))?
        .map_err(|e| Error::invalid(format!("bad certificate PEM: {e}")))?;
    Ok(thumbprint(&cert))
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(aws_lc_rs::default_provider())
}

fn load_chain(pem: &str) -> Result<Vec<CertificateDer<'static>>, Error> {
    CertificateDer::pem_slice_iter(pem.as_bytes()).collect::<Result<Vec<_>, _>>().map_err(|e| Error::invalid(format!("bad certificate PEM: {e}")))
}

fn load_key(pem: &str) -> Result<PrivateKeyDer<'static>, Error> {
    PrivateKeyDer::from_pem_slice(pem.as_bytes()).map_err(|e| Error::invalid(format!("bad private key PEM: {e}")))
}

fn within_validity(der: &[u8], now: UnixTime) -> bool {
    match x509_parser::parse_x509_certificate(der) {
        Ok((_, cert)) => {
            let t = now.as_secs() as i64;
            cert.validity().not_before.timestamp() <= t && t <= cert.validity().not_after.timestamp()
        }
        Err(_) => false,
    }
}

/// Admits exactly the certificates whose thumbprints are registered for an active peer.
#[derive(Debug)]
pub struct PinnedClientVerifier {
    pinned: Arc<RwLock<HashSet<String>>>,
    provider: Arc<CryptoProvider>,
}

impl PinnedClientVerifier {
    pub fn new(pinned: Arc<RwLock<HashSet<String>>>) -> Self {
        Self { pinned, provider: provider() }
    }
}

impl ClientCertVerifier for PinnedClientVerifier {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }

    fn verify_client_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        now: UnixTime,
    ) -> Result<ClientCertVerified, TlsError> {
        if !self.pinned.read().contains(&thumbprint(end_entity)) {
            return Err(TlsError::General("client certificate is not pinned to an active peer".into()));
        }
        if !within_validity(end_entity, now) {
            return Err(TlsError::General("client certificate is outside its validity period".into()));
        }
        Ok(ClientCertVerified::assertion())
    }

    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, TlsError> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, TlsError> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

pub fn server_config(cert_pem: &str, key_pem: &str, pinned: Arc<RwLock<HashSet<String>>>) -> Result<Arc<rustls::ServerConfig>, Error> {
    let mut cfg = rustls::ServerConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .map_err(|e| Error::internal(format!("tls versions: {e}")))?
        .with_client_cert_verifier(Arc::new(PinnedClientVerifier::new(pinned)))
        .with_single_cert(load_chain(cert_pem)?, load_key(key_pem)?)
        .map_err(|e| Error::invalid(format!("gateway server identity: {e}")))?;
    cfg.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Ok(Arc::new(cfg))
}

/// HTTP client for calling a peer gateway: presents our client certificate and trusts only the peer's CA bundle.
pub fn peer_http_client(client_identity: Option<&(String, String)>, server_ca_pem: Option<&str>) -> Result<reqwest::Client, Error> {
    let mut roots = RootCertStore::empty();
    if let Some(pem) = server_ca_pem {
        for cert in load_chain(pem)? {
            roots.add(cert).map_err(|e| Error::invalid(format!("peer CA: {e}")))?;
        }
    }
    let builder = rustls::ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .map_err(|e| Error::internal(format!("tls versions: {e}")))?
        .with_root_certificates(roots);
    let cfg = match client_identity {
        Some((cert, key)) => {
            builder.with_client_auth_cert(load_chain(cert)?, load_key(key)?).map_err(|e| Error::invalid(format!("gateway client identity: {e}")))?
        }
        None => builder.with_no_client_auth(),
    };
    reqwest::Client::builder()
        .use_preconfigured_tls(cfg)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| Error::internal(format!("peer http client: {e}")))
}

/// Keeps the pinned set in step with the peer registry (and with revocations).
pub fn spawn_pin_refresher(peers: Peers, shutdown: CancellationToken) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            let _ = peers.refresh_pinned().await;
            tokio::select! {
                _ = shutdown.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_millis(250)) => {},
            }
        }
    })
}

/// Serves `app` over mutual TLS, attaching the presented certificate's thumbprint to every request.
pub async fn serve_mtls(app: Router, listener: TcpListener, tls: Arc<rustls::ServerConfig>, shutdown: CancellationToken) {
    let acceptor = TlsAcceptor::from(tls);
    loop {
        let (tcp, _) = tokio::select! {
            _ = shutdown.cancelled() => break,
            accepted = listener.accept() => match accepted { Ok(v) => v, Err(_) => continue },
        };
        let acceptor = acceptor.clone();
        let app = app.clone();
        let shutdown = shutdown.clone();
        tokio::spawn(async move {
            let Ok(stream) = acceptor.accept(tcp).await else { return };
            let peer = stream.get_ref().1.peer_certificates().and_then(|c| c.first()).map(|c| thumbprint(c));
            let service = TowerToHyperService::new(AddExtensionLayer::new(PeerCert(peer)).layer(app));
            let builder = Builder::new(TokioExecutor::new());
            let conn = builder.serve_connection_with_upgrades(TokioIo::new(stream), service);
            tokio::select! {
                _ = conn => {},
                _ = shutdown.cancelled() => {},
            }
        });
    }
}
