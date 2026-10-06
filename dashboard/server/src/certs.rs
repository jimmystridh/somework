//! Certificate expiry without a certificate library: the validity period is read straight from the DER, and the
//! domain's live certificate is fetched with a verifying TLS handshake against the private CA.

use base64::{Engine, engine::general_purpose::STANDARD};
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio_rustls::{
    TlsConnector,
    rustls::{ClientConfig, RootCertStore, pki_types::{CertificateDer, ServerName}},
};

/// All `CERTIFICATE` blocks of a PEM file, as DER.
pub fn pem_certificates(pem: &str) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut rest = pem;
    while let Some(start) = rest.find("-----BEGIN CERTIFICATE-----") {
        let after = &rest[start + 27..];
        let Some(end) = after.find("-----END CERTIFICATE-----") else { break };
        let body: String = after[..end].chars().filter(|c| !c.is_whitespace()).collect();
        if let Ok(der) = STANDARD.decode(body) {
            out.push(der);
        }
        rest = &after[end + 25..];
    }
    out
}

/// `(tag, content, remainder)` of the first DER element.
fn element(data: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let (&tag, rest) = data.split_first()?;
    let (&first, rest) = rest.split_first()?;
    let (length, rest) = if first < 0x80 {
        (first as usize, rest)
    } else {
        let count = (first & 0x7f) as usize;
        if count == 0 || count > 4 || rest.len() < count {
            return None;
        }
        (rest[..count].iter().fold(0usize, |acc, byte| (acc << 8) | *byte as usize), &rest[count..])
    };
    (rest.len() >= length).then(|| (tag, &rest[..length], &rest[length..]))
}

/// `notAfter` of a certificate as unix seconds.
pub fn not_after(der: &[u8]) -> Option<i64> {
    let (_, certificate, _) = element(der)?;
    let (_, tbs, _) = element(certificate)?;
    let mut rest = tbs;
    let (mut tag, mut content, mut next) = element(rest)?;
    if tag == 0xa0 {
        // explicit version
        (tag, content, next) = element(next)?;
    }
    // serial (INTEGER), then signature, issuer, validity
    debug_assert_eq!(tag, 0x02);
    let _ = content;
    rest = next;
    for _ in 0..2 {
        rest = element(rest)?.2;
    }
    let (_, validity, _) = element(rest)?;
    let (_, _, after_not_before) = element(validity)?;
    let (time_tag, time, _) = element(after_not_before)?;
    let text = std::str::from_utf8(time).ok()?;
    let parsed = match time_tag {
        0x17 => {
            let year: i32 = text.get(..2)?.parse().ok()?;
            let full = format!("{}{}", if year >= 50 { "19" } else { "20" }, text);
            chrono::NaiveDateTime::parse_from_str(&full, "%Y%m%d%H%M%SZ").ok()?
        }
        0x18 => chrono::NaiveDateTime::parse_from_str(text, "%Y%m%d%H%M%SZ").ok()?,
        _ => return None,
    };
    Some(parsed.and_utc().timestamp())
}

/// The leaf certificate the server presents, after a handshake that verifies it against `ca_pem`.
pub async fn presented_leaf(host: &str, port: u16, ca_pem: &str) -> Option<Vec<u8>> {
    let mut roots = RootCertStore::empty();
    for der in pem_certificates(ca_pem) {
        roots.add(CertificateDer::from(der)).ok()?;
    }
    let provider = Arc::new(tokio_rustls::rustls::crypto::ring::default_provider());
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .ok()?
        .with_root_certificates(roots)
        .with_no_client_auth();
    let name = ServerName::try_from(host.to_string()).ok()?;
    let tcp = tokio::time::timeout(std::time::Duration::from_secs(5), TcpStream::connect((host, port))).await.ok()?.ok()?;
    let tls = tokio::time::timeout(std::time::Duration::from_secs(5), TlsConnector::from(Arc::new(config)).connect(name, tcp)).await.ok()?.ok()?;
    tls.get_ref().1.peer_certificates()?.first().map(|der| der.as_ref().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CA: &str = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";

    #[test]
    fn reads_every_certificate_block() {
        let two = format!("{CA}\n{CA}");
        assert_eq!(pem_certificates(&two).len(), 2);
        assert!(pem_certificates("nothing here").is_empty());
    }

    #[test]
    fn reads_both_time_encodings() {
        // minimal certificate skeletons: version, serial, signature, issuer, validity, rest
        let tlv = |tag: u8, content: &[u8]| {
            let mut out = vec![tag, content.len() as u8];
            out.extend_from_slice(content);
            out
        };
        for (time_tag, text) in [(0x17u8, "361003120000Z"), (0x18, "20361003120000Z")] {
            let not_before = tlv(time_tag, text.replace("36", "26").as_bytes());
            let validity = tlv(0x30, &[not_before, tlv(time_tag, text.as_bytes())].concat());
            let tbs = tlv(
                0x30,
                &[tlv(0xa0, &tlv(0x02, &[2])), tlv(0x02, &[1]), tlv(0x30, &[]), tlv(0x30, &[]), validity].concat(),
            );
            let certificate = tlv(0x30, &[tbs, tlv(0x30, &[]), tlv(0x03, &[0])].concat());
            let seconds = not_after(&certificate).expect("a validity period");
            assert_eq!(chrono::DateTime::from_timestamp(seconds, 0).unwrap().format("%Y-%m-%d").to_string(), "2036-10-03");
        }
    }

    #[test]
    fn garbage_is_none() {
        assert_eq!(not_after(&[0x30, 0x03, 1, 2, 3]), None);
        assert_eq!(not_after(&[]), None);
    }
}
