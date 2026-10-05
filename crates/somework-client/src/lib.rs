//! SomeWork SDK: a typed-enough HTTP client with workload-credential handling, used by sidecars, tools and tests.
//! The SDK never sees NATS, Matrix or object-store credentials.

use std::{sync::Arc, time::Duration};

use chrono::Utc;
use ed25519_dalek::SigningKey;
use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use somework_core::{ErrorCode, contracts::*, fsm::TaskState, jws};

#[derive(Clone)]
pub enum Credentials {
    /// Mint a fresh short-lived assertion per request from the principal's private key.
    Assertion { key: Arc<SigningKey>, issuer: String, audience: String, runtime_instance_id: Option<String> },
    /// A pre-obtained bearer token (OIDC token, task grant).
    Bearer(String),
}

#[derive(Debug, Clone, thiserror::Error)]
#[error("{status} {code:?}: {message}")]
pub struct ClientError {
    pub status: u16,
    pub code: ErrorCode,
    pub message: String,
    pub details: Option<Value>,
    pub trace_id: Option<String>,
}

impl ClientError {
    fn transport(message: String) -> Self {
        Self { status: 0, code: ErrorCode::Unavailable, message, details: None, trace_id: None }
    }

    pub fn is_retryable(&self) -> bool {
        self.status == 0 || matches!(self.status, 502 | 503 | 504 | 429)
    }
}

impl From<ClientError> for somework_core::Error {
    fn from(e: ClientError) -> Self {
        let mut err = somework_core::Error::new(e.code, e.message);
        err.details = e.details;
        err
    }
}

pub type Result<T> = std::result::Result<T, ClientError>;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    pub task_id: String,
    pub state: TaskState,
    pub revision: u64,
    pub attempt: u64,
    #[serde(default)]
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub parent_task_id: Option<String>,
    pub capability: CapabilityRef,
    #[serde(default)]
    pub input: Value,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub failure: Option<Failure>,
    #[serde(default)]
    pub lease: Option<Lease>,
    #[serde(default)]
    pub assignee: Option<ActorRef>,
    #[serde(default)]
    pub context_refs: Vec<ContextRef>,
    #[serde(default)]
    pub result_artifacts: Vec<ArtifactRef>,
    #[serde(default)]
    pub blocker: Option<Value>,
    #[serde(default)]
    pub approval_id: Option<String>,
    #[serde(default)]
    pub pending_approval: Option<Value>,
    #[serde(default)]
    pub trace_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimInfo {
    pub task: TaskInfo,
    pub lease: Lease,
    pub fencing_token: u64,
    pub authorization_token: String,
    pub capability: Capability,
    #[serde(default)]
    pub authority: Value,
}

#[derive(Clone)]
pub struct Client {
    base: String,
    http: reqwest::Client,
    creds: Credentials,
    retries: u32,
}

impl Client {
    pub fn new(base_url: impl Into<String>, creds: Credentials) -> Self {
        let http = reqwest::Client::builder().timeout(Duration::from_secs(60)).build().expect("http client");
        Self { base: base_url.into().trim_end_matches('/').to_string(), http, creds, retries: 3 }
    }

    pub fn assertion(base_url: impl Into<String>, key: SigningKey, kind: &str, id: &str, domain_id: &str) -> Self {
        Self::new(
            base_url,
            Credentials::Assertion { key: Arc::new(key), issuer: format!("{kind}:{id}"), audience: format!("somework:{domain_id}"), runtime_instance_id: None },
        )
    }

    pub fn with_runtime(mut self, runtime_instance_id: impl Into<String>) -> Self {
        if let Credentials::Assertion { runtime_instance_id: rt, .. } = &mut self.creds {
            *rt = Some(runtime_instance_id.into());
        }
        self
    }

    /// Trusts only the CA certificates in this PEM bundle for the domain's HTTPS endpoint (a private CA), instead of the
    /// platform trust store. Fails if the file cannot be read or holds no certificate.
    pub fn with_ca_file(mut self, path: &std::path::Path) -> std::result::Result<Self, String> {
        let pem = std::fs::read(path).map_err(|e| format!("cannot read CA file {}: {e}", path.display()))?;
        let certs = reqwest::Certificate::from_pem_bundle(&pem).map_err(|e| format!("invalid CA bundle {}: {e}", path.display()))?;
        if certs.is_empty() {
            return Err(format!("CA bundle {} contains no certificate", path.display()));
        }
        self.http =
            reqwest::Client::builder().timeout(Duration::from_secs(60)).tls_certs_only(certs).build().map_err(|e| format!("cannot build HTTPS client: {e}"))?;
        Ok(self)
    }

    pub fn with_retries(mut self, retries: u32) -> Self {
        self.retries = retries;
        self
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    pub fn runtime_instance_id(&self) -> Option<String> {
        match &self.creds {
            Credentials::Assertion { runtime_instance_id, .. } => runtime_instance_id.clone(),
            Credentials::Bearer(_) => None,
        }
    }

    fn bearer(&self) -> String {
        match &self.creds {
            Credentials::Bearer(t) => t.clone(),
            Credentials::Assertion { key, issuer, audience, runtime_instance_id } => {
                jws::mint_assertion(key, issuer, audience, runtime_instance_id.as_deref(), Utc::now(), chrono::Duration::seconds(120))
            }
        }
    }

    /// Raw request with retries on transport errors and 502/503/504/429. `idempotency_key` makes mutations safe to retry.
    pub async fn raw(&self, method: Method, path: &str, body: Option<&Value>, idempotency_key: Option<&str>, if_match: Option<u64>) -> Result<Value> {
        let url = format!("{}{}", self.base, path);
        let mut attempt = 0;
        loop {
            let mut req = self
                .http
                .request(method.clone(), &url)
                .bearer_auth(self.bearer())
                .header("traceparent", somework_core::trace::TraceContext::new_root().traceparent());
            if let Some(key) = idempotency_key {
                req = req.header("Idempotency-Key", key);
            }
            if let Some(rev) = if_match {
                req = req.header("If-Match", format!("\"{rev}\""));
            }
            if let Some(b) = body {
                req = req.json(b);
            }
            let outcome = match req.send().await {
                Ok(resp) => self.decode(resp).await,
                Err(e) => Err(ClientError::transport(e.to_string())),
            };
            match outcome {
                Err(e) if e.is_retryable() && attempt < self.retries && (idempotency_key.is_some() || method == Method::GET || e.status == 0) => {
                    attempt += 1;
                    tokio::time::sleep(Duration::from_millis(100 * 2u64.pow(attempt))).await;
                }
                other => return other,
            }
        }
    }

    async fn decode(&self, resp: reqwest::Response) -> Result<Value> {
        let status = resp.status();
        let trace_id = resp.headers().get("x-trace-id").and_then(|v| v.to_str().ok()).map(String::from);
        let bytes = resp.bytes().await.map_err(|e| ClientError::transport(e.to_string()))?;
        let value: Value =
            if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({"raw": String::from_utf8_lossy(&bytes)})) };
        if status.is_success() {
            return Ok(value);
        }
        let code = value.get("code").and_then(Value::as_str).and_then(ErrorCode::from_str_code).unwrap_or(if status == StatusCode::UNAUTHORIZED {
            ErrorCode::Unauthenticated
        } else {
            ErrorCode::Internal
        });
        Err(ClientError {
            status: status.as_u16(),
            code,
            message: value.get("detail").and_then(Value::as_str).unwrap_or("request failed").to_string(),
            details: value.get("details").cloned(),
            trace_id: trace_id.or_else(|| value.get("traceId").and_then(Value::as_str).map(String::from)),
        })
    }

    pub async fn get(&self, path: &str) -> Result<Value> {
        self.raw(Method::GET, path, None, None, None).await
    }

    pub async fn post(&self, path: &str, body: &Value) -> Result<Value> {
        self.raw(Method::POST, path, Some(body), None, None).await
    }

    pub async fn post_idem(&self, path: &str, body: &Value, key: &str) -> Result<Value> {
        self.raw(Method::POST, path, Some(body), Some(key), None).await
    }

    pub async fn put(&self, path: &str, body: &Value) -> Result<Value> {
        self.raw(Method::PUT, path, Some(body), None, None).await
    }

    pub async fn typed<T: DeserializeOwned>(&self, mut v: Value) -> Result<T> {
        // `traceId` is an API envelope field; strict contract types (ArtifactRef...) must not see it
        if let Some(obj) = v.as_object_mut() {
            obj.remove("traceId");
        }
        serde_json::from_value(v).map_err(|e| ClientError::transport(format!("unexpected response shape: {e}")))
    }

    // ---- catalog ------------------------------------------------------------------------------------------------------
    pub async fn catalog_search(&self, req: &Value) -> Result<Value> {
        self.post("/v1/catalog/search", req).await
    }

    pub async fn get_agent(&self, agent_id: &str) -> Result<Value> {
        self.get(&format!("/v1/agents/{}", urlencoding(agent_id))).await
    }

    pub async fn register_agent(&self, card: &Value) -> Result<Value> {
        let id = card["agentId"].as_str().unwrap_or_default().to_string();
        self.put(&format!("/v1/agents/{}", urlencoding(&id)), &json!({"card": card})).await
    }

    // ---- runtimes -----------------------------------------------------------------------------------------------------
    pub async fn register_runtime(&self, meta: Value) -> Result<Value> {
        self.post("/v1/runtimes", &json!({"runtimeInstanceId": self.runtime_instance_id(), "meta": meta})).await
    }

    pub async fn runtime_heartbeat(&self) -> Result<Value> {
        self.post("/v1/runtimes/heartbeat", &json!({})).await
    }

    // ---- tasks --------------------------------------------------------------------------------------------------------
    pub async fn submit_task(&self, req: &Value, idempotency_key: Option<&str>) -> Result<TaskInfo> {
        let v = self.raw(Method::POST, "/v1/tasks", Some(req), idempotency_key, None).await?;
        self.typed(v).await
    }

    pub async fn get_task(&self, task_id: &str) -> Result<TaskInfo> {
        let v = self.get(&format!("/v1/tasks/{task_id}")).await?;
        self.typed(v).await
    }

    pub async fn claim_task(&self, task_id: &str, lease_seconds: Option<i64>) -> Result<ClaimInfo> {
        let v = self.post(&format!("/v1/tasks/{task_id}/claim"), &json!({"leaseSeconds": lease_seconds})).await?;
        self.typed(v).await
    }

    pub async fn heartbeat_task(&self, task_id: &str, fencing_token: u64, lease_seconds: Option<i64>) -> Result<Value> {
        self.post(&format!("/v1/tasks/{task_id}/heartbeat"), &json!({"fencingToken": fencing_token, "leaseSeconds": lease_seconds})).await
    }

    pub async fn progress_task(&self, task_id: &str, body: &Value) -> Result<TaskInfo> {
        let v = self.post(&format!("/v1/tasks/{task_id}/progress"), body).await?;
        self.typed(v).await
    }

    pub async fn complete_task(&self, task_id: &str, fencing_token: u64, result: &Value, artifacts: &[ArtifactRef]) -> Result<TaskInfo> {
        let v = self.post(&format!("/v1/tasks/{task_id}/complete"), &json!({"fencingToken": fencing_token, "result": result, "artifacts": artifacts})).await?;
        self.typed(v).await
    }

    pub async fn fail_task(&self, task_id: &str, fencing_token: u64, failure: &Failure) -> Result<TaskInfo> {
        let v = self.post(&format!("/v1/tasks/{task_id}/fail"), &json!({"fencingToken": fencing_token, "failure": failure})).await?;
        self.typed(v).await
    }

    pub async fn cancel_task(&self, task_id: &str, reason: Option<&str>) -> Result<TaskInfo> {
        let v = self.post(&format!("/v1/tasks/{task_id}/cancel"), &json!({"reason": reason})).await?;
        self.typed(v).await
    }

    pub async fn ack_cancel(&self, task_id: &str, fencing_token: u64) -> Result<TaskInfo> {
        let v = self.post(&format!("/v1/tasks/{task_id}/cancel"), &json!({"acknowledge": true, "fencingToken": fencing_token})).await?;
        self.typed(v).await
    }

    pub async fn provide_input(&self, task_id: &str, data: &Value) -> Result<TaskInfo> {
        let v = self.post(&format!("/v1/tasks/{task_id}/input"), &json!({"data": data})).await?;
        self.typed(v).await
    }

    pub async fn next_tasks(&self, wait_seconds: u64) -> Result<Vec<Value>> {
        let v = self.get(&format!("/v1/tasks/next?wait={wait_seconds}")).await?;
        Ok(v["tasks"].as_array().cloned().unwrap_or_default())
    }

    /// Polls until the task reaches a terminal state or `timeout` elapses.
    pub async fn wait_terminal(&self, task_id: &str, timeout: Duration) -> Result<TaskInfo> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let t = self.get_task(task_id).await?;
            if t.state.is_terminal() || tokio::time::Instant::now() >= deadline {
                return Ok(t);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    // ---- messages & events --------------------------------------------------------------------------------------------
    pub async fn send_message(&self, req: &Value) -> Result<Value> {
        self.post("/v1/messages", req).await
    }

    pub async fn events(&self, after: i64, wait_seconds: u64) -> Result<(Vec<Value>, i64)> {
        let v = self.get(&format!("/v1/events?after={after}&wait={wait_seconds}")).await?;
        let cursor = v["cursor"].as_i64().unwrap_or(after);
        Ok((v["events"].as_array().cloned().unwrap_or_default(), cursor))
    }

    pub async fn ack_events(&self, cursor: i64) -> Result<()> {
        self.post("/v1/events/ack", &json!({"cursor": cursor})).await.map(|_| ())
    }

    // ---- artifacts ----------------------------------------------------------------------------------------------------
    /// Full upload flow: begin -> PUT bytes with the grant -> complete (digest verification). Returns the verified ref.
    pub async fn upload_artifact(
        &self,
        filename: &str,
        media_type: &str,
        classification: &str,
        bytes: &[u8],
        source_task_id: Option<&str>,
    ) -> Result<ArtifactRef> {
        use sha2::{Digest, Sha256};
        let sha = hex::encode(Sha256::digest(bytes));
        let grant = self
            .post("/v1/artifacts/uploads", &json!({"filename": filename, "mediaType": media_type, "sizeBytes": bytes.len(), "sha256": sha, "classification": classification, "sourceTaskId": source_task_id}))
            .await?;
        let artifact_id = grant["artifactId"].as_str().unwrap_or_default().to_string();
        let version = grant["version"].as_u64().unwrap_or(1);
        let mut completed_parts = vec![];
        if let Some(multipart) = grant.get("multipart").filter(|m| !m.is_null()) {
            let part_size = multipart["partSize"].as_u64().unwrap_or(5 * 1024 * 1024) as usize;
            for part in multipart["parts"].as_array().cloned().unwrap_or_default() {
                let n = part["partNumber"].as_u64().unwrap_or(1) as usize;
                let start = (n - 1) * part_size;
                let end = (start + part_size).min(bytes.len());
                let resp = self
                    .http
                    .put(part["url"].as_str().unwrap_or_default())
                    .body(bytes[start..end].to_vec())
                    .send()
                    .await
                    .map_err(|e| ClientError::transport(e.to_string()))?;
                if !resp.status().is_success() {
                    return Err(ClientError {
                        status: resp.status().as_u16(),
                        code: ErrorCode::Unavailable,
                        message: "part upload failed".into(),
                        details: None,
                        trace_id: None,
                    });
                }
                let etag = resp.headers().get("etag").and_then(|v| v.to_str().ok()).unwrap_or_default().trim_matches('"').to_string();
                completed_parts.push(json!({"partNumber": n, "etag": etag}));
            }
        } else {
            let mut put = self.http.put(grant["url"].as_str().unwrap_or_default()).body(bytes.to_vec());
            for (k, v) in grant["headers"].as_object().cloned().unwrap_or_default() {
                put = put.header(k, v.as_str().unwrap_or_default());
            }
            let resp = put.send().await.map_err(|e| ClientError::transport(e.to_string()))?;
            if !resp.status().is_success() {
                return Err(ClientError {
                    status: resp.status().as_u16(),
                    code: ErrorCode::Unavailable,
                    message: format!("object upload failed: {}", resp.status()),
                    details: None,
                    trace_id: None,
                });
            }
        }
        let done = self.post(&format!("/v1/artifacts/{artifact_id}/complete"), &json!({"version": version, "parts": completed_parts})).await?;
        self.typed(done).await
    }

    /// Downloads and digest-verifies an artifact (the caller never trusts the transport).
    pub async fn download_artifact(&self, artifact_id: &str, version: u64, task: Option<(&str, u64)>) -> Result<Vec<u8>> {
        use sha2::{Digest, Sha256};
        let grant = self
            .post(&format!("/v1/artifacts/{artifact_id}/{version}/download-grants"), &json!({"taskId": task.map(|t| t.0), "fencingToken": task.map(|t| t.1)}))
            .await?;
        let resp = self.http.get(grant["url"].as_str().unwrap_or_default()).send().await.map_err(|e| ClientError::transport(e.to_string()))?;
        let bytes = resp.bytes().await.map_err(|e| ClientError::transport(e.to_string()))?;
        let expected = grant["artifact"]["digest"]["value"].as_str().unwrap_or_default();
        if hex::encode(Sha256::digest(&bytes)) != expected {
            return Err(ClientError {
                status: 0,
                code: ErrorCode::IntegrityFailure,
                message: "downloaded bytes do not match the artifact digest".into(),
                details: None,
                trace_id: None,
            });
        }
        Ok(bytes.to_vec())
    }
}

fn urlencoding(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

#[derive(Serialize)]
pub struct Unused;
