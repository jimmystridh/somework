//! SomeWork client assertions: a short-lived, audience-bound EdDSA compact JWS, exactly what the TypeScript SDK
//! (`Identity.mintAssertion`) and the Rust client mint. The private key never leaves this process.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::{
    rand::{SecureRandom, SystemRandom},
    signature::Ed25519KeyPair,
};
use serde::Deserialize;

const TTL_SECONDS: i64 = 120;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyFile {
    kind: String,
    id: String,
    domain_id: String,
    private_key: String,
}

pub struct Identity {
    issuer: String,
    audience: String,
    key: Ed25519KeyPair,
}

impl Identity {
    /// Reads the key file written by `somework admin enroll-agent --key-out` (`kind`, `id`, `domainId`, `privateKey`).
    pub fn from_key_file(contents: &[u8]) -> Result<Self, String> {
        let file: KeyFile = serde_json::from_slice(contents).map_err(|_| "key file is not valid JSON".to_string())?;
        let seed = URL_SAFE_NO_PAD
            .decode(file.private_key.trim())
            .map_err(|_| "private key is not base64url".to_string())?;
        let key = Ed25519KeyPair::from_seed_unchecked(&seed).map_err(|_| "private key must be a 32 byte Ed25519 seed".to_string())?;
        Ok(Self {
            issuer: format!("{}:{}", file.kind, file.id),
            audience: format!("somework:{}", file.domain_id),
            key,
        })
    }

    pub fn issuer(&self) -> &str {
        &self.issuer
    }

    /// A fresh assertion for the current time with a random `jti`.
    pub fn mint(&self) -> String {
        let mut random = [0u8; 16];
        SystemRandom::new().fill(&mut random).expect("system randomness");
        let jti: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        self.mint_at(chrono::Utc::now().timestamp(), &jti)
    }

    /// Deterministic form, used by the tests against the TypeScript SDK's output. Field order matters for byte equality.
    pub fn mint_at(&self, now: i64, jti: &str) -> String {
        let quote = |value: &str| serde_json::to_string(value).expect("string serialisation");
        let header = format!(
            "{{\"alg\":\"EdDSA\",\"typ\":\"somework+assertion\",\"kid\":{}}}",
            quote(&self.issuer)
        );
        let claims = format!(
            "{{\"iss\":{issuer},\"sub\":{issuer},\"aud\":[{audience}],\"iat\":{iat},\"exp\":{exp},\"jti\":{jti}}}",
            issuer = quote(&self.issuer),
            audience = quote(&self.audience),
            iat = now,
            exp = now + TTL_SECONDS,
            jti = quote(jti),
        );
        let signing_input = format!("{}.{}", URL_SAFE_NO_PAD.encode(header), URL_SAFE_NO_PAD.encode(claims));
        let signature = self.key.sign(signing_input.as_bytes());
        format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(signature.as_ref()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Produced by the TypeScript SDK in this repository's sibling project: `Identity.mintAssertion(undefined, 120, 1_790_000_000_000)`
    /// for kind `agent`, id `agent/fleet-reader`, domain `development`, seed bytes 0..31 (jti taken from that run).
    const SEED: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    const SDK_ASSERTION: &str = "eyJhbGciOiJFZERTQSIsInR5cCI6InNvbWV3b3JrK2Fzc2VydGlvbiIsImtpZCI6ImFnZW50OmFnZW50L2ZsZWV0LXJlYWRlciJ9.eyJpc3MiOiJhZ2VudDphZ2VudC9mbGVldC1yZWFkZXIiLCJzdWIiOiJhZ2VudDphZ2VudC9mbGVldC1yZWFkZXIiLCJhdWQiOlsic29tZXdvcms6ZGV2ZWxvcG1lbnQiXSwiaWF0IjoxNzkwMDAwMDAwLCJleHAiOjE3OTAwMDAxMjAsImp0aSI6IjJkMjUwMGIwNDk5YTU3NWI5ODZmMmU4Yjk3MTNlY2YxIn0.3gBmpgGOr-OlHJGl_eLU5BcbyWeeY2Q_uNvFEVoqfs2mfMSi1-kk9roI8bTFWWJFc8csuELicLgq6TrDXraPAA";

    fn identity() -> Identity {
        let file = format!(
            "{{\"kind\":\"agent\",\"id\":\"agent/fleet-reader\",\"domainId\":\"development\",\"privateKey\":\"{SEED}\",\"publicKey\":\"unused\"}}"
        );
        Identity::from_key_file(file.as_bytes()).unwrap()
    }

    #[test]
    fn matches_the_typescript_sdk_byte_for_byte() {
        assert_eq!(identity().mint_at(1_790_000_000, "2d2500b0499a575b986f2e8b9713ecf1"), SDK_ASSERTION);
    }

    #[test]
    fn fresh_assertions_differ_and_carry_the_expected_claims() {
        let identity = identity();
        let (first, second) = (identity.mint(), identity.mint());
        assert_ne!(first, second, "each assertion has its own jti");
        let claims = String::from_utf8(URL_SAFE_NO_PAD.decode(first.split('.').nth(1).unwrap()).unwrap()).unwrap();
        assert!(claims.contains("\"iss\":\"agent:agent/fleet-reader\""));
        assert!(claims.contains("\"aud\":[\"somework:development\"]"));
        assert_eq!(identity.issuer(), "agent:agent/fleet-reader");
    }

    #[test]
    fn rejects_unusable_key_files() {
        for bad in [&b"not json"[..], br#"{"kind":"agent","id":"x","domainId":"d","privateKey":"AAAA"}"#] {
            assert!(Identity::from_key_file(bad).is_err());
        }
    }
}
