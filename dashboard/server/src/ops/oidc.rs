//! Entra ID sign-in: OpenID Connect authorization code with PKCE for one tenant. The id_token is checked here (signature against the
//! tenant's JWKS, issuer, audience, nonce, expiry); nothing from it but the email is kept, and the role comes from the users table.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::Url;
use ring::signature::{RSA_PKCS1_2048_8192_SHA256, RsaPublicKeyComponents};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

const LEEWAY_SECONDS: i64 = 60;
const KEYS_MAX_AGE: Duration = Duration::from_secs(3600);
const KEYS_MIN_REFRESH: Duration = Duration::from_secs(30);

#[derive(Clone, Debug)]
pub struct OidcConfig {
    /// `https://login.microsoftonline.com/<tenant id>/v2.0`
    pub issuer: String,
    pub client_id: String,
    pub client_secret: String,
    /// `https://<host>/fleet/auth/callback`
    pub redirect_url: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Jwk {
    pub kty: String,
    #[serde(default)]
    pub kid: Option<String>,
    #[serde(default)]
    pub n: Option<String>,
    #[serde(default)]
    pub e: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdentityClaims {
    pub email: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TokenError {
    Malformed,
    Algorithm,
    UnknownKey,
    Signature,
    Issuer,
    Audience,
    Nonce,
    Expired,
    NotYetValid,
    NoEmail,
}

impl TokenError {
    pub fn describe(&self) -> &'static str {
        match self {
            Self::Malformed => "the id_token is not a well-formed token",
            Self::Algorithm => "the id_token is not signed with RS256",
            Self::UnknownKey => "the id_token is signed with a key the tenant does not publish",
            Self::Signature => "the id_token signature is wrong",
            Self::Issuer => "the id_token is from another issuer",
            Self::Audience => "the id_token is for another application",
            Self::Nonce => "the id_token does not belong to this sign-in",
            Self::Expired => "the id_token has expired",
            Self::NotYetValid => "the id_token is not valid yet",
            Self::NoEmail => "the id_token names no email address",
        }
    }
}

fn part(token: &str, index: usize) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(token.split('.').nth(index)?).ok()
}

/// `{issuer}/.well-known/openid-configuration` is the standard place; its `issuer` must be the configured one.
pub fn verify_id_token(token: &str, keys: &[Jwk], config: &OidcConfig, nonce: &str, now: i64) -> Result<IdentityClaims, TokenError> {
    if token.split('.').count() != 3 {
        return Err(TokenError::Malformed);
    }
    let header: Value = serde_json::from_slice(&part(token, 0).ok_or(TokenError::Malformed)?).map_err(|_| TokenError::Malformed)?;
    if header.get("alg").and_then(Value::as_str) != Some("RS256") {
        return Err(TokenError::Algorithm);
    }
    let kid = header.get("kid").and_then(Value::as_str).ok_or(TokenError::UnknownKey)?;
    let key = keys.iter().find(|key| key.kty == "RSA" && key.kid.as_deref() == Some(kid)).ok_or(TokenError::UnknownKey)?;
    let (n, e) = (
        URL_SAFE_NO_PAD.decode(key.n.as_deref().ok_or(TokenError::UnknownKey)?).map_err(|_| TokenError::UnknownKey)?,
        URL_SAFE_NO_PAD.decode(key.e.as_deref().ok_or(TokenError::UnknownKey)?).map_err(|_| TokenError::UnknownKey)?,
    );
    let signature = part(token, 2).ok_or(TokenError::Malformed)?;
    let (signing_input, _) = token.rsplit_once('.').ok_or(TokenError::Malformed)?;
    RsaPublicKeyComponents { n: &n, e: &e }.verify(&RSA_PKCS1_2048_8192_SHA256, signing_input.as_bytes(), &signature).map_err(|_| TokenError::Signature)?;
    let claims: Value = serde_json::from_slice(&part(token, 1).ok_or(TokenError::Malformed)?).map_err(|_| TokenError::Malformed)?;
    if claims.get("iss").and_then(Value::as_str) != Some(config.issuer.as_str()) {
        return Err(TokenError::Issuer);
    }
    let audience_ok = match claims.get("aud") {
        Some(Value::String(audience)) => audience == &config.client_id,
        Some(Value::Array(list)) => list.iter().any(|audience| audience.as_str() == Some(config.client_id.as_str())),
        _ => false,
    };
    if !audience_ok {
        return Err(TokenError::Audience);
    }
    if claims.get("nonce").and_then(Value::as_str) != Some(nonce) || nonce.is_empty() {
        return Err(TokenError::Nonce);
    }
    let exp = claims.get("exp").and_then(Value::as_i64).ok_or(TokenError::Expired)?;
    if exp + LEEWAY_SECONDS < now {
        return Err(TokenError::Expired);
    }
    if claims.get("nbf").and_then(Value::as_i64).is_some_and(|nbf| nbf - LEEWAY_SECONDS > now) || claims.get("iat").and_then(Value::as_i64).is_some_and(|iat| iat - LEEWAY_SECONDS > now) {
        return Err(TokenError::NotYetValid);
    }
    let email = ["email", "preferred_username", "upn"]
        .iter()
        .filter_map(|name| claims.get(*name).and_then(Value::as_str))
        .find(|value| value.contains('@') && value.len() <= 254 && !value.chars().any(|c| c.is_control() || c.is_whitespace()))
        .ok_or(TokenError::NoEmail)?;
    Ok(IdentityClaims { email: email.to_lowercase() })
}

pub fn code_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

#[derive(Clone, Debug)]
struct Discovery {
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
}

pub struct Oidc {
    pub config: OidcConfig,
    http: reqwest::Client,
    discovery: RwLock<Option<Discovery>>,
    keys: RwLock<Option<(Instant, Vec<Jwk>)>>,
    allow_http: bool,
}

impl Oidc {
    pub fn new(config: OidcConfig, allow_http: bool) -> Result<Self, String> {
        let scheme_ok = |url: &str| url.starts_with("https://") || (allow_http && url.starts_with("http://"));
        if !scheme_ok(&config.issuer) || !scheme_ok(&config.redirect_url) {
            return Err("OIDC_ISSUER and OIDC_REDIRECT_URL must be https".into());
        }
        if config.client_id.is_empty() || config.client_secret.is_empty() {
            return Err("OIDC_CLIENT_ID and the client secret must not be empty".into());
        }
        let redirect = Url::parse(&config.redirect_url).map_err(|_| "OIDC_REDIRECT_URL is not a URL".to_string())?;
        if redirect.path() != "/fleet/auth/callback" {
            return Err("OIDC_REDIRECT_URL must end in /fleet/auth/callback".into());
        }
        let http = reqwest::Client::builder().timeout(Duration::from_secs(10)).connect_timeout(Duration::from_secs(5)).build().map_err(|_| "cannot build the HTTP client".to_string())?;
        Ok(Self { config, http, discovery: RwLock::new(None), keys: RwLock::new(None), allow_http })
    }

    async fn discovery(&self) -> Result<Discovery, String> {
        if let Some(found) = self.discovery.read().await.clone() {
            return Ok(found);
        }
        let url = format!("{}/.well-known/openid-configuration", self.config.issuer.trim_end_matches('/'));
        let document: Value = self.http.get(&url).send().await.map_err(|_| "the identity provider is unreachable".to_string())?.error_for_status().map_err(|_| "the identity provider's discovery document is unavailable".to_string())?.json().await.map_err(|_| "the discovery document is not JSON".to_string())?;
        if document.get("issuer").and_then(Value::as_str) != Some(self.config.issuer.as_str()) {
            return Err("the discovery document names another issuer than OIDC_ISSUER".into());
        }
        let endpoint = |name: &str| -> Result<String, String> {
            let value = document.get(name).and_then(Value::as_str).ok_or_else(|| format!("the discovery document has no {name}"))?;
            if value.starts_with("https://") || (self.allow_http && value.starts_with("http://")) { Ok(value.to_string()) } else { Err(format!("the discovery document's {name} is not https")) }
        };
        let found = Discovery { authorization_endpoint: endpoint("authorization_endpoint")?, token_endpoint: endpoint("token_endpoint")?, jwks_uri: endpoint("jwks_uri")? };
        *self.discovery.write().await = Some(found.clone());
        Ok(found)
    }

    pub async fn authorization_url(&self, state: &str, nonce: &str, verifier: &str) -> Result<String, String> {
        let discovery = self.discovery().await?;
        let mut url = Url::parse(&discovery.authorization_endpoint).map_err(|_| "the authorization endpoint is not a URL".to_string())?;
        url.query_pairs_mut()
            .append_pair("client_id", &self.config.client_id)
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", &self.config.redirect_url)
            .append_pair("response_mode", "query")
            .append_pair("scope", "openid profile email")
            .append_pair("state", state)
            .append_pair("nonce", nonce)
            .append_pair("code_challenge", &code_challenge(verifier))
            .append_pair("code_challenge_method", "S256");
        Ok(url.into())
    }

    async fn signing_keys(&self, force: bool) -> Result<Vec<Jwk>, String> {
        if let Some((fetched, keys)) = self.keys.read().await.as_ref() {
            let fresh = fetched.elapsed() < KEYS_MAX_AGE;
            if (!force && fresh) || fetched.elapsed() < KEYS_MIN_REFRESH {
                return Ok(keys.clone());
            }
        }
        let discovery = self.discovery().await?;
        let document: Value = self.http.get(&discovery.jwks_uri).send().await.map_err(|_| "the tenant's signing keys are unreachable".to_string())?.error_for_status().map_err(|_| "the tenant's signing keys are unavailable".to_string())?.json().await.map_err(|_| "the signing keys are not JSON".to_string())?;
        let keys: Vec<Jwk> = document.get("keys").and_then(Value::as_array).map(|list| list.iter().filter_map(|key| serde_json::from_value(key.clone()).ok()).collect()).unwrap_or_default();
        *self.keys.write().await = Some((Instant::now(), keys.clone()));
        Ok(keys)
    }

    /// Trades the code for tokens and checks the id_token. The error text is safe to log; it never holds a token.
    pub async fn complete(&self, code: &str, verifier: &str, nonce: &str, now: i64) -> Result<IdentityClaims, String> {
        let discovery = self.discovery().await?;
        let response = self
            .http
            .post(&discovery.token_endpoint)
            .form(&[
                ("grant_type", "authorization_code"),
                ("client_id", self.config.client_id.as_str()),
                ("client_secret", self.config.client_secret.as_str()),
                ("code", code),
                ("redirect_uri", self.config.redirect_url.as_str()),
                ("code_verifier", verifier),
            ])
            .send()
            .await
            .map_err(|_| "the token endpoint is unreachable".to_string())?;
        if !response.status().is_success() {
            return Err(format!("the token endpoint refused the code (HTTP {})", response.status().as_u16()));
        }
        let body: Value = response.json().await.map_err(|_| "the token response is not JSON".to_string())?;
        let token = body.get("id_token").and_then(Value::as_str).ok_or("the token response has no id_token")?;
        let mut keys = self.signing_keys(false).await?;
        let mut outcome = verify_id_token(token, &keys, &self.config, nonce, now);
        if outcome == Err(TokenError::UnknownKey) {
            keys = self.signing_keys(true).await?;
            outcome = verify_id_token(token, &keys, &self.config, nonce, now);
        }
        outcome.map_err(|error| error.describe().to_string())
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use ring::{rand::SystemRandom, signature::RsaKeyPair};

    /// A throwaway 2048-bit RSA key made for these tests with `openssl genpkey`. It protects nothing and is used for nothing else.
    const TEST_KEY: &str = include_str!("test_rsa_key.b64");

    pub struct TestIdp {
        pair: RsaKeyPair,
        pub kid: String,
    }

    pub const ISSUER: &str = "https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0";
    pub const CLIENT: &str = "client-id-0001";

    impl TestIdp {
        pub fn new(kid: &str) -> Self {
            let der = base64::engine::general_purpose::STANDARD.decode(TEST_KEY.trim()).unwrap();
            Self { pair: RsaKeyPair::from_der(&der).unwrap(), kid: kid.into() }
        }

        pub fn jwk(&self) -> Jwk {
            let public: RsaPublicKeyComponents<Vec<u8>> = RsaPublicKeyComponents::from(self.pair.public());
            Jwk { kty: "RSA".into(), kid: Some(self.kid.clone()), n: Some(URL_SAFE_NO_PAD.encode(&public.n)), e: Some(URL_SAFE_NO_PAD.encode(&public.e)) }
        }

        pub fn token(&self, header: Value, claims: Value) -> String {
            let signing_input = format!("{}.{}", URL_SAFE_NO_PAD.encode(header.to_string()), URL_SAFE_NO_PAD.encode(claims.to_string()));
            let mut signature = vec![0u8; self.pair.public().modulus_len()];
            self.pair.sign(&ring::signature::RSA_PKCS1_SHA256, &SystemRandom::new(), signing_input.as_bytes(), &mut signature).unwrap();
            format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(signature))
        }

        pub fn good(&self, now: i64, email: &str, nonce: &str) -> String {
            self.good_for(ISSUER, CLIENT, now, email, nonce)
        }

        pub fn good_for(&self, issuer: &str, client: &str, now: i64, email: &str, nonce: &str) -> String {
            self.token(
                serde_json::json!({"alg": "RS256", "typ": "JWT", "kid": self.kid}),
                serde_json::json!({"iss": issuer, "aud": client, "nonce": nonce, "exp": now + 3600, "iat": now, "nbf": now, "preferred_username": email, "tid": "11111111-2222-3333-4444-555555555555"}),
            )
        }
    }

    pub fn config() -> OidcConfig {
        OidcConfig { issuer: ISSUER.into(), client_id: CLIENT.into(), client_secret: "not-a-real-secret".into(), redirect_url: "https://ops.example.test/fleet/auth/callback".into() }
    }

    const NOW: i64 = 1_790_000_000;

    #[test]
    fn a_valid_token_gives_the_lowercased_email() {
        let idp = TestIdp::new("k1");
        let token = idp.good(NOW, "Jane.Doe@Example.com", "nonce-1");
        let claims = verify_id_token(&token, &[idp.jwk()], &config(), "nonce-1", NOW).unwrap();
        assert_eq!(claims.email, "jane.doe@example.com");
    }

    #[test]
    fn every_other_check_refuses_the_token() {
        let idp = TestIdp::new("k1");
        let keys = [idp.jwk()];
        let claims = |change: &dyn Fn(&mut Value)| {
            let mut value = serde_json::json!({"iss": ISSUER, "aud": CLIENT, "nonce": "n", "exp": NOW + 60, "iat": NOW, "preferred_username": "a@example.com"});
            change(&mut value);
            idp.token(serde_json::json!({"alg": "RS256", "kid": "k1"}), value)
        };
        let check = |token: String| verify_id_token(&token, &keys, &config(), "n", NOW);
        assert!(check(claims(&|_| {})).is_ok());
        assert_eq!(check(claims(&|c| c["aud"] = "someone-else".into())), Err(TokenError::Audience));
        assert!(check(claims(&|c| c["aud"] = serde_json::json!(["x", CLIENT]))).is_ok(), "an audience list may hold ours");
        assert_eq!(check(claims(&|c| c["iss"] = "https://login.microsoftonline.com/other-tenant/v2.0".into())), Err(TokenError::Issuer));
        assert_eq!(check(claims(&|c| c["nonce"] = "other".into())), Err(TokenError::Nonce));
        assert_eq!(check(claims(&|c| { c.as_object_mut().unwrap().remove("nonce"); })), Err(TokenError::Nonce));
        assert_eq!(check(claims(&|c| c["exp"] = (NOW - 61).into())), Err(TokenError::Expired));
        assert!(check(claims(&|c| c["exp"] = (NOW - 30).into())).is_ok(), "a minute of clock skew is allowed");
        assert_eq!(check(claims(&|c| c["nbf"] = (NOW + 600).into())), Err(TokenError::NotYetValid));
        assert_eq!(check(claims(&|c| { c.as_object_mut().unwrap().remove("preferred_username"); })), Err(TokenError::NoEmail));
        assert_eq!(check(claims(&|c| c["preferred_username"] = "not an address".into())), Err(TokenError::NoEmail));
    }

    #[test]
    fn a_wrong_key_algorithm_or_signature_is_refused() {
        let idp = TestIdp::new("k1");
        let keys = [idp.jwk()];
        let good = idp.good(NOW, "a@example.com", "n");
        assert_eq!(verify_id_token(&good, &[], &config(), "n", NOW), Err(TokenError::UnknownKey));
        let other = TestIdp::new("other");
        assert_eq!(verify_id_token(&good, &[other.jwk()], &config(), "n", NOW), Err(TokenError::UnknownKey));
        let mut stranger = idp.jwk();
        stranger.n = Some(URL_SAFE_NO_PAD.encode([0xC3u8; 256]));
        assert_eq!(verify_id_token(&good, &[stranger], &config(), "n", NOW), Err(TokenError::Signature));
        let (head, rest) = good.split_once('.').unwrap();
        let (_, tail) = rest.split_once('.').unwrap();
        let forged_claims = URL_SAFE_NO_PAD.encode(serde_json::json!({"iss": ISSUER, "aud": CLIENT, "nonce": "n", "exp": NOW + 60, "preferred_username": "admin@example.com"}).to_string());
        assert_eq!(verify_id_token(&format!("{head}.{forged_claims}.{tail}"), &keys, &config(), "n", NOW), Err(TokenError::Signature), "changed claims break the signature");
        let none = idp.token(serde_json::json!({"alg": "none", "kid": "k1"}), serde_json::json!({}));
        assert_eq!(verify_id_token(&none, &keys, &config(), "n", NOW), Err(TokenError::Algorithm));
        let hs = idp.token(serde_json::json!({"alg": "HS256", "kid": "k1"}), serde_json::json!({}));
        assert_eq!(verify_id_token(&hs, &keys, &config(), "n", NOW), Err(TokenError::Algorithm));
        assert_eq!(verify_id_token("a.b", &keys, &config(), "n", NOW), Err(TokenError::Malformed));
        assert_eq!(verify_id_token("", &keys, &config(), "n", NOW), Err(TokenError::Malformed));
    }

    #[test]
    fn the_pkce_challenge_is_the_s256_of_the_verifier() {
        // the example of RFC 7636 appendix B
        assert_eq!(code_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn the_configuration_is_checked() {
        assert!(Oidc::new(config(), false).is_ok());
        assert!(Oidc::new(OidcConfig { issuer: "http://x".into(), ..config() }, false).is_err());
        assert!(Oidc::new(OidcConfig { redirect_url: "https://ops.example.test/elsewhere".into(), ..config() }, false).is_err());
        assert!(Oidc::new(OidcConfig { client_secret: String::new(), ..config() }, false).is_err());
    }
}
