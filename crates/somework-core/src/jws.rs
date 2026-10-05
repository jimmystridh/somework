//! Compact JWS (EdDSA / Ed25519) used for authorization grants and workload client assertions.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, Utc};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde_json::{Value, json};

use crate::error::Error;

pub const TYP_GRANT: &str = "somework+grant";
pub const TYP_ASSERTION: &str = "somework+assertion";
/// Tolerated clock skew when checking `nbf`/`exp`.
pub const LEEWAY_SECONDS: i64 = 30;

pub fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn unb64(raw: &str) -> Result<Vec<u8>, Error> {
    URL_SAFE_NO_PAD.decode(raw).map_err(|_| Error::unauthenticated("malformed base64url segment"))
}

pub fn new_signing_key() -> SigningKey {
    SigningKey::from_bytes(&rand::random::<[u8; 32]>())
}

pub fn signing_key_from_b64(raw: &str) -> Result<SigningKey, Error> {
    let bytes: [u8; 32] = unb64(raw)?.try_into().map_err(|_| Error::internal("signing key must be 32 bytes"))?;
    Ok(SigningKey::from_bytes(&bytes))
}

pub fn signing_key_to_b64(key: &SigningKey) -> String {
    b64(&key.to_bytes())
}

pub fn verifying_key_from_b64(raw: &str) -> Result<VerifyingKey, Error> {
    let bytes: [u8; 32] = unb64(raw)?.try_into().map_err(|_| Error::unauthenticated("public key must be 32 bytes"))?;
    VerifyingKey::from_bytes(&bytes).map_err(|_| Error::unauthenticated("invalid public key"))
}

pub fn verifying_key_to_b64(key: &VerifyingKey) -> String {
    b64(key.as_bytes())
}

/// Stable identifier of a public key (SHA-256 of the raw key bytes, base64url).
pub fn key_thumbprint(key: &VerifyingKey) -> String {
    use sha2::{Digest, Sha256};
    b64(&Sha256::digest(key.as_bytes()))
}

pub fn sign(typ: &str, kid: &str, key: &SigningKey, claims: &Value) -> String {
    let header = json!({"alg": "EdDSA", "typ": typ, "kid": kid});
    let signing_input = format!("{}.{}", b64(header.to_string().as_bytes()), b64(claims.to_string().as_bytes()));
    let signature = key.sign(signing_input.as_bytes());
    format!("{signing_input}.{}", b64(&signature.to_bytes()))
}

#[derive(Debug, Clone)]
pub struct Unverified {
    pub header: Value,
    pub claims: Value,
    signing_input: String,
    signature: Vec<u8>,
}

impl Unverified {
    pub fn kid(&self) -> Option<&str> {
        self.header.get("kid").and_then(Value::as_str)
    }

    pub fn typ(&self) -> Option<&str> {
        self.header.get("typ").and_then(Value::as_str)
    }

    pub fn issuer(&self) -> Option<&str> {
        self.claims.get("iss").or_else(|| self.claims.get("issuer")).and_then(Value::as_str)
    }

    pub fn verify(&self, key: &VerifyingKey) -> Result<(), Error> {
        let sig_bytes: [u8; 64] = self.signature.clone().try_into().map_err(|_| Error::unauthenticated("bad signature length"))?;
        let signature = Signature::from_bytes(&sig_bytes);
        key.verify(self.signing_input.as_bytes(), &signature).map_err(|_| Error::unauthenticated("signature verification failed"))
    }
}

/// Splits and decodes a token without trusting it. Callers must call [`Unverified::verify`] before using claims.
pub fn parse(token: &str) -> Result<Unverified, Error> {
    let mut parts = token.split('.');
    let (h, p, s) = match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(h), Some(p), Some(s), None) => (h, p, s),
        _ => return Err(Error::unauthenticated("token is not a compact JWS")),
    };
    let header: Value = serde_json::from_slice(&unb64(h)?).map_err(|_| Error::unauthenticated("bad token header"))?;
    if header.get("alg").and_then(Value::as_str) != Some("EdDSA") {
        return Err(Error::unauthenticated("unsupported token algorithm"));
    }
    let claims: Value = serde_json::from_slice(&unb64(p)?).map_err(|_| Error::unauthenticated("bad token payload"))?;
    Ok(Unverified { header, claims, signing_input: format!("{h}.{p}"), signature: unb64(s)? })
}

pub fn check_time_window(not_before: DateTime<Utc>, expires_at: DateTime<Utc>, now: DateTime<Utc>) -> Result<(), Error> {
    let leeway = Duration::seconds(LEEWAY_SECONDS);
    if now + leeway < not_before {
        return Err(Error::unauthenticated("token is not yet valid"));
    }
    if now - leeway >= expires_at {
        return Err(Error::unauthenticated("token has expired"));
    }
    Ok(())
}

/// Mint a workload client assertion (private_key_jwt style): short-lived, audience-bound, signed with the
/// principal's own registered key. `iss` is `<kind>:<principal id>`, e.g. `agent:agent/reviewer`.
pub fn mint_assertion(key: &SigningKey, issuer: &str, audience: &str, runtime_instance_id: Option<&str>, now: DateTime<Utc>, ttl: Duration) -> String {
    let mut claims = json!({
        "iss": issuer,
        "sub": issuer,
        "aud": [audience],
        "iat": now.timestamp(),
        "exp": (now + ttl).timestamp(),
        "jti": crate::ids::jti(),
    });
    if let Some(rt) = runtime_instance_id {
        claims["runtimeInstanceId"] = json!(rt);
    }
    sign(TYP_ASSERTION, issuer, key, &claims)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_verify_roundtrip_and_tamper_detection() {
        let key = new_signing_key();
        let token = sign(TYP_GRANT, "k1", &key, &json!({"iss": "domain:dev", "n": 1}));
        let parsed = parse(&token).unwrap();
        assert_eq!(parsed.kid(), Some("k1"));
        assert_eq!(parsed.typ(), Some(TYP_GRANT));
        parsed.verify(&key.verifying_key()).unwrap();

        let other = new_signing_key();
        assert!(parsed.verify(&other.verifying_key()).is_err());

        let mut parts: Vec<String> = token.split('.').map(String::from).collect();
        parts[1] = b64(json!({"iss": "domain:dev", "n": 2}).to_string().as_bytes());
        let forged = parse(&parts.join(".")).unwrap();
        assert!(forged.verify(&key.verifying_key()).is_err());
    }

    #[test]
    fn rejects_non_eddsa() {
        let header = b64(json!({"alg": "none"}).to_string().as_bytes());
        let payload = b64(b"{}");
        assert!(parse(&format!("{header}.{payload}.")).is_err());
    }

    #[test]
    fn key_encoding_roundtrip() {
        let key = new_signing_key();
        let again = signing_key_from_b64(&signing_key_to_b64(&key)).unwrap();
        assert_eq!(key.to_bytes(), again.to_bytes());
        let vk = verifying_key_from_b64(&verifying_key_to_b64(&key.verifying_key())).unwrap();
        assert_eq!(vk, key.verifying_key());
    }
}
