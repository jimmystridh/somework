use std::time::Duration;

use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::Method;
use serde_json::{Value, json};
use somework_client::{Client, ClientError};
use somework_core::ErrorCode;

use crate::worker::lease::{Leases, spawn_keepalive};

pub type McpResult = Result<Value, ClientError>;

fn invalid(message: impl Into<String>) -> ClientError {
    ClientError { status: 422, code: ErrorCode::ValidationFailed, message: message.into(), details: None, trace_id: None }
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, ClientError> {
    args.get(key).and_then(Value::as_str).ok_or_else(|| invalid(format!("`{key}` is required")))
}

fn enc(s: &str) -> String {
    urlencoding::encode(s).into_owned()
}

/// Everything the model must never see: tokens and presigned credentials stay inside the sidecar.
fn scrub(mut v: Value) -> Value {
    if let Some(o) = v.as_object_mut() {
        o.remove("authorizationToken");
    }
    v
}

fn without(args: &Value, keys: &[&str]) -> Value {
    let mut v = args.clone();
    if let Some(o) = v.as_object_mut() {
        for k in keys {
            o.remove(*k);
        }
    }
    v
}

pub async fn call(client: &Client, leases: &Leases, name: &str, args: Value) -> McpResult {
    match name {
        "collab_catalog_search" => search_with_contracts(client, &args).await,
        "collab_agent_get" => client.get_agent(str_arg(&args, "agentId")?).await,
        "collab_message_send" => {
            let mut body = without(&args, &["text"]);
            if let Some(text) = args.get("text").and_then(Value::as_str) {
                body["content"] = json!({"mediaType": "text/plain", "data": text});
            }
            client.send_message(&body).await
        }
        "collab_task_submit" => {
            let key = args.get("idempotencyKey").and_then(Value::as_str).map(String::from);
            let body = without(&args, &["idempotencyKey"]);
            let v = client.raw(Method::POST, "/v1/tasks", Some(&body), key.as_deref(), None).await?;
            Ok(v)
        }
        "collab_task_get" => {
            let id = str_arg(&args, "taskId")?;
            let wait = args.get("waitSeconds").and_then(Value::as_u64).unwrap_or(0).min(30);
            let deadline = tokio::time::Instant::now() + Duration::from_secs(wait);
            loop {
                let v = client.get(&format!("/v1/tasks/{}", enc(id))).await?;
                let terminal = matches!(v["state"].as_str(), Some("succeeded" | "failed" | "rejected" | "canceled" | "expired"));
                if terminal || tokio::time::Instant::now() >= deadline {
                    return Ok(v);
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        "collab_task_claim" => {
            let id = str_arg(&args, "taskId")?;
            let lease = args.get("leaseSeconds").and_then(Value::as_i64).unwrap_or(30);
            let claim = client.post(&format!("/v1/tasks/{}/claim", enc(id)), &json!({"leaseSeconds": lease})).await?;
            let fence = claim["fencingToken"].as_u64().unwrap_or_default();
            let handle = spawn_keepalive(client.clone(), id.to_string(), fence, lease, 0.33);
            if let Some(previous) = leases.lock().expect("lease map").insert(id.to_string(), handle) {
                previous.stop();
            }
            Ok(scrub(claim))
        }
        "collab_task_progress" => {
            let id = str_arg(&args, "taskId")?;
            client.post(&format!("/v1/tasks/{}/progress", enc(id)), &args).await
        }
        "collab_task_input" => {
            let id = str_arg(&args, "taskId")?;
            client.post(&format!("/v1/tasks/{}/input", enc(id)), &args).await
        }
        "collab_task_complete" | "collab_task_fail" => {
            let id = str_arg(&args, "taskId")?;
            let verb = if name.ends_with("complete") { "complete" } else { "fail" };
            let out = client.post(&format!("/v1/tasks/{}/{verb}", enc(id)), &args).await;
            if let Some(h) = leases.lock().expect("lease map").remove(id) {
                h.stop();
            }
            out
        }
        "collab_task_cancel" => {
            let id = str_arg(&args, "taskId")?;
            let out = client.post(&format!("/v1/tasks/{}/cancel", enc(id)), &args).await;
            if args.get("acknowledge").and_then(Value::as_bool).unwrap_or(false)
                && let Some(h) = leases.lock().expect("lease map").remove(id)
            {
                h.stop();
            }
            out
        }
        "collab_context_create" => {
            let pack = match args.get("pack") {
                Some(pack) => pack.clone(),
                None => context_pack_from_shorthand(client, &args).await?,
            };
            client.post("/v1/context-packs", &pack).await
        }
        "collab_context_offer" => {
            let id = str_arg(&args, "contextPackId")?;
            let version = args.get("version").and_then(Value::as_u64).ok_or_else(|| invalid("`version` is required"))?;
            client.post(&format!("/v1/context-packs/{}/{version}/offer", enc(id)), &without(&args, &["contextPackId", "version"])).await
        }
        "collab_context_accept" => {
            let id = str_arg(&args, "contextPackId")?;
            let version = args.get("version").and_then(Value::as_u64).ok_or_else(|| invalid("`version` is required"))?;
            let out = client.post(&format!("/v1/context-packs/{}/{version}/accept", enc(id)), &without(&args, &["contextPackId", "version"])).await?;
            if let (Some(task_id), Some(fence)) = (out["task"]["taskId"].as_str(), out["fencingToken"].as_u64()) {
                let lease = out["lease"]["leaseId"].as_str().map(|_| 30).unwrap_or(30);
                let handle = spawn_keepalive(client.clone(), task_id.to_string(), fence, lease, 0.33);
                leases.lock().expect("lease map").insert(task_id.to_string(), handle);
            }
            Ok(scrub(out))
        }
        "collab_artifact_begin_upload" => begin_upload(client, args).await,
        "collab_artifact_complete_upload" => {
            let id = str_arg(&args, "artifactId")?;
            client.post(&format!("/v1/artifacts/{}/complete", enc(id)), &without(&args, &["artifactId"])).await
        }
        "collab_artifact_get" => artifact_get(client, args).await,
        "collab_subscribe" => match str_arg(&args, "action")? {
            "create" => client.post("/v1/subscriptions", &without(&args, &["action", "subscriptionId"])).await,
            "list" => client.get("/v1/subscriptions").await,
            "delete" => {
                let id = str_arg(&args, "subscriptionId")?;
                client.raw(Method::DELETE, &format!("/v1/subscriptions/{}", enc(id)), None, None, None).await.map(|_| json!({"deleted": id}))
            }
            other => Err(invalid(format!("unknown subscribe action {other}"))),
        },
        other => Err(ClientError { status: 404, code: ErrorCode::NotFound, message: format!("unknown tool {other}"), details: None, trace_id: None }),
    }
}

fn transport(message: String) -> ClientError {
    ClientError { status: 0, code: ErrorCode::Unavailable, message, details: None, trace_id: None }
}

/// Searches, then attaches each matched capability's contract (description, schemas, side effects) so the model can
/// build a valid `input` without reading anything else.
async fn search_with_contracts(client: &Client, args: &Value) -> McpResult {
    let mut found = client.catalog_search(args).await?;
    if let Some(matches) = found.get_mut("matches").and_then(Value::as_array_mut) {
        for m in matches.iter_mut().take(5) {
            let mut contracts = vec![];
            for cap in m["matchedCapabilities"].as_array().cloned().unwrap_or_default() {
                let (id, version) = (cap["id"].as_str().unwrap_or_default(), cap["version"].as_str().unwrap_or_default());
                if let Ok(c) = client.get(&format!("/v1/capabilities/{}/{}", enc(id), enc(version))).await {
                    contracts.push(json!({
                        "id": c["id"], "version": c["version"], "name": c["name"], "description": c["description"],
                        "sideEffects": c["sideEffects"], "inputSchema": c["inputSchema"], "outputSchema": c["outputSchema"],
                    }));
                }
            }
            m["capabilities"] = json!(contracts);
        }
    }
    Ok(found)
}

/// `collab_context_create` shorthand: the model supplies the story, the sidecar supplies the contract boilerplate.
async fn context_pack_from_shorthand(client: &Client, args: &Value) -> Result<Value, ClientError> {
    let objective = str_arg(args, "objective").map_err(|_| invalid("provide either `pack` (a full ContextPack) or `objective` (shorthand)"))?;
    let who = client.get("/v1/admin/whoami").await?;
    let domain = who["actor"]["domainId"].as_str().unwrap_or_default().to_string();
    let mut pack = json!({
        "objective": objective,
        "currentState": {
            "summary": args.get("summary").and_then(Value::as_str).unwrap_or(objective),
            "completed": args.get("completed").cloned().unwrap_or_else(|| json!([])),
            "remaining": args.get("remaining").cloned().unwrap_or_else(|| json!([])),
        },
        "requestedContinuation": {
            "mode": args.get("mode").and_then(Value::as_str).unwrap_or("consultation"),
            "instruction": args.get("instruction").and_then(Value::as_str).unwrap_or(objective),
        },
        "security": {
            "classification": args.get("classification").and_then(Value::as_str).unwrap_or("internal"),
            "allowedDomains": [domain],
            "instructionsTrusted": false,
        },
    });
    if let Some(facts) = args.get("facts").and_then(Value::as_array) {
        pack["facts"] = facts.iter().map(|fact| fact_from_shorthand(fact, &who["actor"])).collect();
    }
    for key in ["acceptanceCriteria", "hypotheses", "decisions", "openQuestions", "artifacts", "workspace"] {
        if let Some(v) = args.get(key) {
            pack[key] = v.clone();
        }
    }
    if let Some(cap) = args.get("expectedOutputCapability").and_then(Value::as_str) {
        pack["requestedContinuation"]["expectedOutputCapability"] = json!(cap);
    }
    Ok(pack)
}

/// A plain string becomes a fact asserted by the caller with neutral confidence; objects pass through untouched.
fn fact_from_shorthand(fact: &Value, actor: &Value) -> Value {
    match fact.as_str() {
        Some(statement) => json!({"statement": statement, "confidence": 0.5, "assertedBy": actor}),
        None => fact.clone(),
    }
}

/// Uploads content for the model: with `text` or `contentBase64` the sidecar computes size and SHA-256, uploads the
/// bytes and completes (verifies) the artifact in one call. Without content it just returns an upload grant.
async fn begin_upload(client: &Client, args: Value) -> McpResult {
    use sha2::{Digest, Sha256};
    let bytes: Option<Vec<u8>> = match (args.get("text").and_then(Value::as_str), args.get("contentBase64").and_then(Value::as_str)) {
        (Some(text), _) => Some(text.as_bytes().to_vec()),
        (None, Some(b64)) => Some(STANDARD.decode(b64).map_err(|e| invalid(format!("contentBase64 is not valid base64: {e}")))?),
        (None, None) => None,
    };
    let mut body = without(&args, &["contentBase64", "text"]);
    if let Some(bytes) = &bytes {
        body["sizeBytes"] = json!(bytes.len());
        body["sha256"] = json!(hex::encode(Sha256::digest(bytes)));
        if body.get("mediaType").is_none() {
            body["mediaType"] = json!(if args.get("text").is_some() { "text/plain" } else { "application/octet-stream" });
        }
    }
    let grant = client.post("/v1/artifacts/uploads", &body).await?;
    let Some(bytes) = bytes else { return Ok(grant) };

    let http = reqwest::Client::new();
    let mut parts = vec![];
    if let Some(mp) = grant.get("multipart").filter(|m| !m.is_null()) {
        let part_size = mp["partSize"].as_u64().unwrap_or(5 << 20) as usize;
        for part in mp["parts"].as_array().cloned().unwrap_or_default() {
            let n = part["partNumber"].as_u64().unwrap_or(1) as usize;
            let start = (n - 1) * part_size;
            let end = (start + part_size).min(bytes.len());
            let resp =
                http.put(part["url"].as_str().unwrap_or_default()).body(bytes[start..end].to_vec()).send().await.map_err(|e| transport(e.to_string()))?;
            let etag = resp.headers().get("etag").and_then(|v| v.to_str().ok()).unwrap_or_default().trim_matches('"').to_string();
            parts.push(json!({"partNumber": n, "etag": etag}));
        }
    } else {
        let mut put = http.put(grant["url"].as_str().unwrap_or_default()).body(bytes);
        for (k, v) in grant["headers"].as_object().cloned().unwrap_or_default() {
            put = put.header(k, v.as_str().unwrap_or_default());
        }
        let resp = put.send().await.map_err(|e| transport(e.to_string()))?;
        if !resp.status().is_success() {
            return Err(transport(format!("object upload failed: {}", resp.status())));
        }
    }
    let artifact_id = grant["artifactId"].as_str().unwrap_or_default();
    client.post(&format!("/v1/artifacts/{}/complete", enc(artifact_id)), &json!({"version": grant["version"], "parts": parts})).await
}

async fn artifact_get(client: &Client, args: Value) -> McpResult {
    let id = str_arg(&args, "artifactId")?;
    let version = args.get("version").and_then(Value::as_u64).ok_or_else(|| invalid("`version` is required"))?;
    let task = args.get("taskId").and_then(Value::as_str);
    let path = match task {
        Some(t) => format!("/v1/artifacts/{}/{version}?taskId={}", enc(id), enc(t)),
        None => format!("/v1/artifacts/{}/{version}", enc(id)),
    };
    let mut meta = client.get(&path).await?;
    if args.get("includeContent").and_then(Value::as_bool).unwrap_or(false) {
        if meta["sizeBytes"].as_u64().unwrap_or(0) > 1 << 20 {
            return Err(ClientError {
                status: 413,
                code: ErrorCode::PayloadTooLarge,
                message: "artifact is larger than 1 MiB; download it outside MCP".into(),
                details: None,
                trace_id: None,
            });
        }
        let bytes = client.download_artifact(id, version, None).await?;
        meta["contentBase64"] = json!(STANDARD.encode(bytes));
    }
    Ok(meta)
}
