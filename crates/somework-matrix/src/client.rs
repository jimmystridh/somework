//! Minimal Matrix client-server API client used with Application Service credentials (masquerading with `user_id`).

use std::{sync::Arc, time::Duration};

use parking_lot::RwLock;
use serde_json::{Value, json};

use crate::config::MatrixConfig;

#[derive(Debug, Clone)]
pub struct MatrixError {
    pub status: u16,
    pub errcode: String,
    pub message: String,
}

impl MatrixError {
    /// Outages, rate limits and token rotation windows are retried; semantic rejections are not.
    pub fn is_transient(&self) -> bool {
        self.status == 0 || self.status >= 500 || self.status == 429 || self.errcode == "M_UNKNOWN_TOKEN" || self.errcode == "M_LIMIT_EXCEEDED"
    }
}

impl std::fmt::Display for MatrixError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "matrix {} {}: {}", self.status, self.errcode, self.message)
    }
}

#[derive(Clone)]
pub struct Tokens {
    inner: Arc<RwLock<(String, String, Vec<String>)>>,
}

impl Tokens {
    pub fn new(cfg: &MatrixConfig) -> Self {
        Self { inner: Arc::new(RwLock::new((cfg.as_token.clone(), cfg.hs_token.clone(), cfg.previous_hs_tokens.clone()))) }
    }

    pub fn as_token(&self) -> String {
        self.inner.read().0.clone()
    }

    pub fn hs_token_matches(&self, presented: &str) -> bool {
        let guard = self.inner.read();
        let mut ok = constant_time_eq(presented.as_bytes(), guard.1.as_bytes());
        for previous in &guard.2 {
            ok |= constant_time_eq(presented.as_bytes(), previous.as_bytes());
        }
        ok
    }

    /// Rotates both tokens; the old hs_token keeps working only if `keep_previous_hs` is set (grace window).
    pub fn rotate(&self, as_token: String, hs_token: String, keep_previous_hs: bool) {
        let mut guard = self.inner.write();
        let old_hs = std::mem::replace(&mut guard.1, hs_token);
        guard.0 = as_token;
        guard.2.clear();
        if keep_previous_hs {
            guard.2.push(old_hs);
        }
    }
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff = (a.len() ^ b.len()) as u8;
    for i in 0..a.len().max(b.len()) {
        diff |= a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0xff);
    }
    diff == 0
}

fn enc(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

#[derive(Clone)]
pub struct MatrixClient {
    base: String,
    http: reqwest::Client,
    tokens: Tokens,
}

impl MatrixClient {
    pub fn new(cfg: &MatrixConfig, tokens: Tokens) -> Self {
        let http = reqwest::Client::builder().timeout(Duration::from_millis(cfg.request_timeout_ms)).build().expect("http client");
        Self { base: cfg.homeserver_url.trim_end_matches('/').to_string(), http, tokens }
    }

    async fn call(&self, method: reqwest::Method, path: &str, as_user: Option<&str>, body: Option<Value>) -> Result<Value, MatrixError> {
        self.call_device(method, path, as_user, None, body).await
    }

    /// Like [`Self::call`], additionally masquerading as one of the user's devices (MSC3202 `device_id`).
    async fn call_device(
        &self,
        method: reqwest::Method,
        path: &str,
        as_user: Option<&str>,
        device_id: Option<&str>,
        body: Option<Value>,
    ) -> Result<Value, MatrixError> {
        let mut url = format!("{}/_matrix/client/v3{}", self.base, path);
        if let Some(user) = as_user {
            url.push(if url.contains('?') { '&' } else { '?' });
            url.push_str(&format!("user_id={}", enc(user)));
        }
        if let Some(device) = device_id {
            url.push(if url.contains('?') { '&' } else { '?' });
            url.push_str(&format!("device_id={}", enc(device)));
        }
        let mut req = self.http.request(method, &url).bearer_auth(self.tokens.as_token());
        if let Some(b) = body {
            req = req.json(&b);
        }
        let resp = req.send().await.map_err(|e| MatrixError { status: 0, errcode: "M_UNREACHABLE".into(), message: e.to_string() })?;
        let status = resp.status().as_u16();
        let value: Value = resp.json().await.unwrap_or(Value::Null);
        if (200..300).contains(&status) {
            Ok(value)
        } else {
            Err(MatrixError {
                status,
                errcode: value["errcode"].as_str().unwrap_or("M_UNKNOWN").into(),
                message: value["error"].as_str().unwrap_or("request failed").into(),
            })
        }
    }

    pub async fn register_virtual_user(&self, localpart: &str) -> Result<(), MatrixError> {
        match self.call(reqwest::Method::POST, "/register", None, Some(json!({"type": "m.login.application_service", "username": localpart}))).await {
            Ok(_) => Ok(()),
            Err(e) if e.errcode == "M_USER_IN_USE" => Ok(()),
            Err(e) => Err(e),
        }
    }

    pub async fn set_displayname(&self, user_id: &str, name: &str) -> Result<(), MatrixError> {
        self.call(reqwest::Method::PUT, &format!("/profile/{}/displayname", enc(user_id)), Some(user_id), Some(json!({"displayname": name}))).await.map(|_| ())
    }

    pub async fn create_room(&self, as_user: &str, body: Value) -> Result<String, MatrixError> {
        let v = self.call(reqwest::Method::POST, "/createRoom", Some(as_user), Some(body)).await?;
        Ok(v["room_id"].as_str().unwrap_or_default().to_string())
    }

    pub async fn resolve_alias(&self, alias: &str) -> Result<Option<String>, MatrixError> {
        match self.call(reqwest::Method::GET, &format!("/directory/room/{}", enc(alias)), None, None).await {
            Ok(v) => Ok(v["room_id"].as_str().map(String::from)),
            Err(e) if e.status == 404 => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub async fn invite(&self, room_id: &str, inviter: &str, invitee: &str) -> Result<(), MatrixError> {
        self.call(reqwest::Method::POST, &format!("/rooms/{}/invite", enc(room_id)), Some(inviter), Some(json!({"user_id": invitee}))).await.map(|_| ())
    }

    pub async fn join(&self, room_id: &str, user_id: &str) -> Result<(), MatrixError> {
        self.call(reqwest::Method::POST, &format!("/rooms/{}/join", enc(room_id)), Some(user_id), Some(json!({}))).await.map(|_| ())
    }

    /// Idempotent per `(room, txn_id)`: replays return the original event id, so retries never duplicate.
    pub async fn send_event(&self, room_id: &str, as_user: &str, event_type: &str, txn_id: &str, content: &Value) -> Result<String, MatrixError> {
        let v = self
            .call(reqwest::Method::PUT, &format!("/rooms/{}/send/{}/{}", enc(room_id), enc(event_type), enc(txn_id)), Some(as_user), Some(content.clone()))
            .await?;
        Ok(v["event_id"].as_str().unwrap_or_default().to_string())
    }

    pub async fn put_state(&self, room_id: &str, as_user: &str, event_type: &str, state_key: &str, content: &Value) -> Result<(), MatrixError> {
        self.call(reqwest::Method::PUT, &format!("/rooms/{}/state/{}/{}", enc(room_id), enc(event_type), enc(state_key)), Some(as_user), Some(content.clone()))
            .await
            .map(|_| ())
    }

    // ---- end-to-end encryption endpoints ----------------------------------------------------------------------------

    /// `POST /keys/upload` as the device `device_id` of `user_id`; returns the homeserver's one-time key counts.
    pub async fn keys_upload(&self, user_id: &str, device_id: &str, body: Value) -> Result<Value, MatrixError> {
        self.call_device(reqwest::Method::POST, "/keys/upload", Some(user_id), Some(device_id), Some(body)).await
    }

    pub async fn keys_query(&self, as_user: &str, users: &[String]) -> Result<Value, MatrixError> {
        let mut device_keys = serde_json::Map::new();
        for u in users {
            device_keys.insert(u.clone(), json!([]));
        }
        self.call(reqwest::Method::POST, "/keys/query", Some(as_user), Some(json!({"device_keys": device_keys}))).await
    }

    pub async fn keys_claim(&self, as_user: &str, wanted: &[(String, String)]) -> Result<Value, MatrixError> {
        let mut otks: serde_json::Map<String, Value> = serde_json::Map::new();
        for (user, device) in wanted {
            otks.entry(user.clone()).or_insert_with(|| json!({}))[device] = json!("signed_curve25519");
        }
        self.call(reqwest::Method::POST, "/keys/claim", Some(as_user), Some(json!({"one_time_keys": otks, "timeout": 5000}))).await
    }

    pub async fn send_to_device(&self, as_user: &str, device_id: &str, event_type: &str, txn_id: &str, messages: Value) -> Result<(), MatrixError> {
        self.call_device(
            reqwest::Method::PUT,
            &format!("/sendToDevice/{}/{}", enc(event_type), enc(txn_id)),
            Some(as_user),
            Some(device_id),
            Some(json!({"messages": messages})),
        )
        .await
        .map(|_| ())
    }

    pub async fn joined_members(&self, room_id: &str, as_user: &str) -> Result<Vec<String>, MatrixError> {
        let v = self.call(reqwest::Method::GET, &format!("/rooms/{}/joined_members", enc(room_id)), Some(as_user), None).await?;
        Ok(v["joined"].as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default())
    }

    pub async fn delete_devices(&self, user_id: &str, devices: &[String]) -> Result<(), MatrixError> {
        self.call(reqwest::Method::POST, "/delete_devices", Some(user_id), Some(json!({"devices": devices}))).await.map(|_| ())
    }
}
