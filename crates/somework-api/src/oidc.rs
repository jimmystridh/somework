//! OIDC bearer-token verification for human callers (ID-04). Tokens are verified against the issuer's JWKS and the
//! `(iss, sub)` pair must be explicitly mapped to an internal human principal; display names or e-mail addresses
//! are never used for identity.

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use jsonwebtoken::{Algorithm, DecodingKey, Validation, jwk::JwkSet};
use parking_lot::RwLock;
use serde::Deserialize;
use serde_json::Value;
use somework_core::Error;

#[derive(Debug, Clone, Deserialize)]
pub struct OidcProvider {
    pub issuer: String,
    pub audience: String,
    /// Inline JWKS (tests, air-gapped deployments).
    #[serde(default)]
    pub jwks: Option<JwkSet>,
    /// JWKS endpoint, fetched and cached.
    #[serde(default)]
    pub jwks_url: Option<String>,
}

struct Cached {
    set: JwkSet,
    fetched: Instant,
}

pub struct OidcVerifier {
    providers: Vec<OidcProvider>,
    cache: RwLock<std::collections::HashMap<String, Cached>>,
    http: reqwest::Client,
}

#[derive(Debug, Clone)]
pub struct VerifiedIdentity {
    pub issuer: String,
    pub subject: String,
}

impl OidcVerifier {
    pub fn new(providers: Vec<OidcProvider>) -> Arc<Self> {
        Arc::new(Self { providers, cache: RwLock::new(Default::default()), http: reqwest::Client::new() })
    }

    pub fn providers(&self) -> &[OidcProvider] {
        &self.providers
    }

    async fn key_set(&self, provider: &OidcProvider, force: bool) -> Result<JwkSet, Error> {
        if let Some(set) = &provider.jwks {
            return Ok(set.clone());
        }
        let url = provider.jwks_url.as_deref().ok_or_else(|| Error::internal("OIDC provider has neither jwks nor jwksUrl"))?;
        if !force
            && let Some(c) = self.cache.read().get(url)
            && c.fetched.elapsed() < Duration::from_secs(300)
        {
            return Ok(c.set.clone());
        }
        let set: JwkSet = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|e| Error::unavailable(format!("JWKS fetch failed: {e}")))?
            .json()
            .await
            .map_err(|e| Error::unavailable(format!("JWKS decode failed: {e}")))?;
        self.cache.write().insert(url.to_string(), Cached { set: set.clone(), fetched: Instant::now() });
        Ok(set)
    }

    /// Cheap check used to route a bearer token to this verifier instead of the workload-token path.
    pub fn looks_like_oidc(token: &str) -> bool {
        match jsonwebtoken::decode_header(token) {
            Ok(h) => h.alg != Algorithm::EdDSA || h.typ.as_deref() != Some("somework+assertion") && h.typ.as_deref() != Some("somework+grant"),
            Err(_) => false,
        }
    }

    pub async fn verify(&self, token: &str) -> Result<VerifiedIdentity, Error> {
        let header = jsonwebtoken::decode_header(token).map_err(|_| Error::unauthenticated("malformed token"))?;
        let unverified: Value = {
            let payload = token.split('.').nth(1).ok_or_else(|| Error::unauthenticated("malformed token"))?;
            serde_json::from_slice(&somework_core::jws::unb64(payload)?).map_err(|_| Error::unauthenticated("malformed token payload"))?
        };
        let issuer = unverified.get("iss").and_then(Value::as_str).ok_or_else(|| Error::unauthenticated("token has no issuer"))?;
        let provider = self.providers.iter().find(|p| p.issuer == issuer).ok_or_else(|| Error::unauthenticated("untrusted token issuer"))?;
        for force in [false, true] {
            let set = self.key_set(provider, force).await?;
            let jwk = match header.kid.as_deref() {
                Some(kid) => set.find(kid),
                None => set.keys.first(),
            };
            let Some(jwk) = jwk else { continue };
            let key = DecodingKey::from_jwk(jwk).map_err(|e| Error::unauthenticated(format!("unusable signing key: {e}")))?;
            let mut validation = Validation::new(header.alg);
            validation.set_issuer(&[provider.issuer.as_str()]);
            validation.set_audience(&[provider.audience.as_str()]);
            validation.set_required_spec_claims(&["exp", "iss", "sub", "aud"]);
            match jsonwebtoken::decode::<Value>(token, &key, &validation) {
                Ok(data) => {
                    let subject = data.claims.get("sub").and_then(Value::as_str).ok_or_else(|| Error::unauthenticated("token has no subject"))?;
                    return Ok(VerifiedIdentity { issuer: provider.issuer.clone(), subject: subject.to_string() });
                }
                Err(e) if force || provider.jwks.is_some() => return Err(Error::unauthenticated(format!("token rejected: {e}"))),
                Err(_) => continue,
            }
        }
        Err(Error::unauthenticated("token signing key is unknown"))
    }
}
