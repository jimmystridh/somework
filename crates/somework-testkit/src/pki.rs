//! Throw-away certificates for mTLS tests (rcgen).

use std::net::IpAddr;

use rcgen::{BasicConstraints, CertificateParams, DnType, IsCa, Issuer, KeyPair, SanType};

pub struct Identity {
    pub cert_pem: String,
    pub key_pem: String,
    pub thumbprint: String,
}

pub struct Ca {
    pub cert_pem: String,
    issuer: Issuer<'static, KeyPair>,
}

impl Ca {
    pub fn new(name: &str) -> Self {
        let key = KeyPair::generate().expect("ca key");
        let mut params = CertificateParams::new(Vec::<String>::new()).expect("ca params");
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.distinguished_name.push(DnType::CommonName, name);
        let cert = params.self_signed(&key).expect("ca cert");
        Self { cert_pem: cert.pem(), issuer: Issuer::new(params, key) }
    }

    /// A server leaf that is valid only for the DNS name `dns` (so connecting by IP address must fail verification).
    pub fn leaf_for_dns(&self, dns: &str) -> Identity {
        let key = KeyPair::generate().expect("leaf key");
        let mut params = CertificateParams::new(vec![dns.to_string()]).expect("leaf params");
        params.distinguished_name.push(DnType::CommonName, dns);
        let cert = params.signed_by(&key, &self.issuer).expect("leaf cert");
        let cert_pem = cert.pem();
        let thumbprint = somework_gateway::tls::thumbprint_of_pem(&cert_pem).expect("thumbprint");
        Identity { cert_pem, key_pem: key.serialize_pem(), thumbprint }
    }

    /// A leaf for `127.0.0.1`/`localhost`, usable as TLS server and client certificate.
    pub fn leaf(&self, name: &str) -> Identity {
        let key = KeyPair::generate().expect("leaf key");
        let mut params = CertificateParams::new(vec!["localhost".to_string()]).expect("leaf params");
        params.subject_alt_names.push(SanType::IpAddress(IpAddr::from([127, 0, 0, 1])));
        params.distinguished_name.push(DnType::CommonName, name);
        let cert = params.signed_by(&key, &self.issuer).expect("leaf cert");
        let cert_pem = cert.pem();
        let thumbprint = somework_gateway::tls::thumbprint_of_pem(&cert_pem).expect("thumbprint");
        Identity { cert_pem, key_pem: key.serialize_pem(), thumbprint }
    }
}
