//! The sidecar links two rustls crypto providers (reqwest brings aws-lc-rs, async-nats brings ring), so rustls cannot
//! pick a process-wide default by itself and would panic on the first TLS handshake. Select one explicitly.

pub fn install_crypto_provider() {
    // already installed by another component: nothing to do
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
}
