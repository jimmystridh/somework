//! Signed cookies and the signed-in user. A cookie is `base64url(json).base64url(HMAC-SHA256)`; it holds who and until when, never a role:
//! the role is read from the users table on every request, so removing someone takes effect at once.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::{
    hmac,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

pub const SESSION_COOKIE: &str = "__Host-ops_session";
pub const LOGIN_COOKIE: &str = "__Host-ops_login";
pub const SESSION_SECONDS: i64 = 8 * 3600;
pub const LOGIN_SECONDS: i64 = 600;

pub fn random_token(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    SystemRandom::new().fill(&mut buffer).expect("system randomness");
    URL_SAFE_NO_PAD.encode(buffer)
}

pub struct SignedCookies {
    key: hmac::Key,
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct SessionClaims {
    pub email: String,
    pub issued: i64,
    pub expires: i64,
}

/// What the browser keeps between redirecting to Entra and coming back: the values that bind the answer to this browser.
#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct LoginClaims {
    pub state: String,
    pub nonce: String,
    pub verifier: String,
    pub next: String,
    pub expires: i64,
}

impl SignedCookies {
    pub fn new(secret: &[u8]) -> Self {
        Self { key: hmac::Key::new(hmac::HMAC_SHA256, secret) }
    }

    /// A fresh random key: sessions end when the process restarts. Used when no key file is configured.
    pub fn random() -> Self {
        let mut secret = [0u8; 32];
        SystemRandom::new().fill(&mut secret).expect("system randomness");
        Self::new(&secret)
    }

    pub fn sign<T: Serialize>(&self, claims: &T) -> String {
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).expect("claims serialise"));
        let tag = hmac::sign(&self.key, payload.as_bytes());
        format!("{payload}.{}", URL_SAFE_NO_PAD.encode(tag.as_ref()))
    }

    /// The claims when the signature is ours; the caller still checks the expiry.
    pub fn open<T: DeserializeOwned>(&self, value: &str) -> Option<T> {
        let (payload, tag) = value.split_once('.')?;
        let tag = URL_SAFE_NO_PAD.decode(tag).ok()?;
        hmac::verify(&self.key, payload.as_bytes(), &tag).ok()?;
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()
    }
}

/// `Set-Cookie` value: host-only, HTTP-only, Secure, SameSite=Lax (Lax so the redirect back from Entra, a top-level GET, carries it).
pub fn set_cookie(name: &str, value: &str, max_age: i64) -> String {
    format!("{name}={value}; Path=/; Max-Age={max_age}; HttpOnly; Secure; SameSite=Lax")
}

pub fn clear_cookie(name: &str) -> String {
    set_cookie(name, "", 0)
}

pub fn cookie_value(header: &str, name: &str) -> Option<String> {
    header.split(';').filter_map(|pair| pair.trim().split_once('=')).find(|(key, _)| *key == name).map(|(_, value)| value.to_string())
}

/// Only a path on this site: `/fleet/` and below, no scheme, no host, no `//`.
pub fn safe_next(next: Option<&str>) -> String {
    match next {
        Some(path) if path.starts_with("/fleet/") && !path.starts_with("//") && !path.contains("://") && !path.contains('\\') && !path.chars().any(char::is_control) => path.to_string(),
        _ => "/fleet/".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_signed_cookie_opens_with_the_same_key_only() {
        let cookies = SignedCookies::new(b"0123456789abcdef0123456789abcdef");
        let claims = SessionClaims { email: "a@example.com".into(), issued: 1, expires: 2 };
        let value = cookies.sign(&claims);
        assert_eq!(cookies.open::<SessionClaims>(&value), Some(claims));
        assert!(SignedCookies::new(b"another key another key another!").open::<SessionClaims>(&value).is_none());
        assert!(SignedCookies::random().open::<SessionClaims>(&value).is_none());
    }

    #[test]
    fn a_tampered_cookie_does_not_open() {
        let cookies = SignedCookies::random();
        let value = cookies.sign(&SessionClaims { email: "a@example.com".into(), issued: 1, expires: 2 });
        let (payload, tag) = value.split_once('.').unwrap();
        let forged = URL_SAFE_NO_PAD.encode(br#"{"email":"admin@example.com","issued":1,"expires":9999999999}"#);
        assert!(cookies.open::<SessionClaims>(&format!("{forged}.{tag}")).is_none());
        assert!(cookies.open::<SessionClaims>(&format!("{payload}.")).is_none());
        assert!(cookies.open::<SessionClaims>("garbage").is_none());
        assert!(cookies.open::<SessionClaims>("").is_none());
    }

    #[test]
    fn the_session_cookie_is_host_only_http_only_secure_and_lax() {
        let header = set_cookie(SESSION_COOKIE, "v", 60);
        for part in ["__Host-ops_session=v", "Path=/", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=60"] {
            assert!(header.contains(part), "{header}");
        }
        assert!(!header.contains("Domain"), "a __Host- cookie has no Domain");
        assert!(clear_cookie(LOGIN_COOKIE).contains("Max-Age=0"));
    }

    #[test]
    fn cookies_are_found_by_name() {
        assert_eq!(cookie_value("a=1; __Host-ops_session=abc.def; b=2", SESSION_COOKIE).as_deref(), Some("abc.def"));
        assert_eq!(cookie_value("a=1", SESSION_COOKIE), None);
    }

    #[test]
    fn the_return_path_stays_on_this_site() {
        assert_eq!(safe_next(Some("/fleet/#agents")), "/fleet/#agents");
        for hostile in ["https://evil.example/", "//evil.example/", "/fleet/../x://y", "/other", "/fleet/\\evil", "javascript:alert(1)", "/fleet/\nx"] {
            assert_eq!(safe_next(Some(hostile)), "/fleet/", "{hostile}");
        }
        assert_eq!(safe_next(None), "/fleet/");
    }
}
