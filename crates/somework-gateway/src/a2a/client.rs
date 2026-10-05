//! Outbound A2A: Agent Card import (CAT-06) and an egress backend for external A2A agents.

use async_trait::async_trait;
use chrono::Duration as ChronoDuration;
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use somework_core::{
    Error,
    canonical::digest_json,
    contracts::{ApprovalStatus, Capability, SideEffects, Source, SourceType, TrustTier, Visibility},
    jws,
};
use somework_domain::{
    Ctx, Domain,
    catalog::{ApproveEntry, RegisterAgent},
    db::{DbResultExt, scol, scol_opt},
    tasks::TaskView,
};

use super::model::{BINDING, PROTOCOL_VERSION};
use crate::egress::{AgentInfo, BackendError, RemoteArtifact, RemoteBackend, RemoteRef, RemoteSnapshot, RemoteState, SubmitOutcome};

pub const SCHEMA_EXTENSION_URI: &str = "urn:somework:a2a:skill-schemas:v1";
pub const SKILL_LABEL_PREFIX: &str = "a2a.skill:";

fn slug(raw: &str) -> String {
    let s: String = raw.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '-' }).collect();
    let s = s.trim_matches(|c| c == '-' || c == '.').to_string();
    if s.is_empty() { "agent".into() } else { s }
}

pub fn origin_of(url: &str) -> String {
    match url.split_once("://") {
        Some((scheme, rest)) => format!("{scheme}://{}", rest.split('/').next().unwrap_or_default()),
        None => url.to_string(),
    }
}

/// Normalizes an A2A Agent Card (v1, or legacy `url`-style) into the platform's AgentCard.
pub fn normalize_card(card: &Value, local_domain: &str) -> Result<(somework_core::contracts::AgentCard, String), Error> {
    let name = card["name"].as_str().ok_or_else(|| Error::invalid("A2A card has no name"))?;
    let interfaces: Vec<Value> = card["supportedInterfaces"].as_array().cloned().unwrap_or_else(|| match card["url"].as_str() {
        Some(u) => vec![json!({"url": u, "protocolBinding": card["preferredTransport"].as_str().unwrap_or("JSONRPC"), "protocolVersion": card["protocolVersion"].as_str().unwrap_or("0.3")})],
        None => vec![],
    });
    let http = interfaces
        .iter()
        .find(|i| {
            i["protocolBinding"].as_str().is_some_and(|b| {
                b.eq_ignore_ascii_case(BINDING) || b.eq_ignore_ascii_case("HTTP-JSON") || b.eq_ignore_ascii_case("http-json") || b.eq_ignore_ascii_case("REST")
            })
        })
        .ok_or_else(|| Error::invalid("the A2A agent offers no HTTP+JSON interface; only that binding is supported"))?;
    let interface_url = http["url"].as_str().ok_or_else(|| Error::invalid("interface has no url"))?.to_string();
    let host = origin_of(&interface_url).split_once("://").map(|(_, h)| h.to_string()).unwrap_or_default();
    let agent_slug = format!("{}-{}", slug(&host), slug(name));
    let agent_id = format!("a2a:{host}/{}", slug(name));

    let extension = card["capabilities"]["extensions"].as_array().and_then(|e| e.iter().find(|x| x["uri"] == SCHEMA_EXTENSION_URI)).cloned();
    let mut capabilities = vec![];
    let mut labels = std::collections::BTreeMap::new();
    for skill in card["skills"].as_array().cloned().unwrap_or_default() {
        let skill_id = skill["id"].as_str().ok_or_else(|| Error::invalid("skill without id"))?;
        let cap_id = format!("a2a.{}.{}", slug(&agent_slug), slug(skill_id));
        let ext = extension
            .as_ref()
            .and_then(|e| e["params"]["skills"].as_object())
            .and_then(|m| m.iter().find(|(k, _)| k.split('@').next() == Some(skill_id)).map(|(k, v)| (k.clone(), v.clone())));
        let (version, input_schema, output_schema, side_effects) = match &ext {
            Some((key, v)) => (
                key.split('@').nth(1).unwrap_or("1").to_string(),
                v["inputSchema"].clone(),
                v["outputSchema"].clone(),
                v["sideEffects"].as_str().and_then(SideEffects::parse).unwrap_or(SideEffects::Write),
            ),
            None => ("1".into(), json!({"type": "object"}), json!({"type": "object"}), SideEffects::Write),
        };
        let mut tags: Vec<String> = skill["tags"]
            .as_array()
            .map(|a| a.iter().filter_map(|t| t.as_str().map(String::from)).filter(|t| !t.starts_with("side-effects:")).collect())
            .unwrap_or_default();
        tags.sort();
        tags.dedup();
        capabilities.push(Capability {
            id: cap_id.chars().take(128).collect(),
            version,
            name: skill["name"].as_str().unwrap_or(skill_id).chars().take(128).collect(),
            description: skill["description"].as_str().filter(|d| !d.is_empty()).unwrap_or("External A2A skill").chars().take(4096).collect(),
            tags,
            input_schema: if input_schema.is_object() { input_schema } else { json!({"type": "object"}) },
            output_schema: if output_schema.is_object() { output_schema } else { json!({"type": "object"}) },
            input_media_types: skill["inputModes"].as_array().map(|a| a.iter().filter_map(|m| m.as_str().map(String::from)).collect()).unwrap_or_default(),
            output_media_types: skill["outputModes"].as_array().map(|a| a.iter().filter_map(|m| m.as_str().map(String::from)).collect()).unwrap_or_default(),
            side_effects,
            data_classes: vec![],
            required_permissions: vec![],
            examples: vec![],
            timeout_seconds: None,
            cost_hint: None,
        });
        labels.insert(format!("{SKILL_LABEL_PREFIX}{}", capabilities.last().map(|c| c.id.clone()).unwrap_or_default()), skill_id.to_string());
    }
    if capabilities.is_empty() {
        return Err(Error::invalid("the A2A card declares no skills"));
    }
    let auth_schemes = card["securitySchemes"].as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
    let owner_team = card["provider"]["organization"].as_str().unwrap_or(&host).to_string();
    let platform_card = somework_core::contracts::AgentCard {
        schema_version: "1.0".into(),
        agent_id,
        domain_id: local_domain.to_string(),
        display_name: name.chars().take(256).collect(),
        description: card["description"].as_str().filter(|d| !d.is_empty()).unwrap_or("External A2A agent").chars().take(4096).collect(),
        owner: somework_core::contracts::Owner { team: owner_team, contact: None, service: Some(interface_url.clone()) },
        status: None,
        capabilities,
        interfaces: vec![somework_core::contracts::Interface {
            protocol: "a2a".into(),
            binding: Some(BINDING.into()),
            url: Some(interface_url),
            version: http["protocolVersion"].as_str().map(String::from),
            tenant: http["tenant"].as_str().filter(|t| !t.is_empty()).map(String::from),
        }],
        auth_schemes,
        labels,
        card_version: None,
        updated_at: None,
    };
    Ok((platform_card, digest_json(card)))
}

/// Registers an external A2A agent in the catalog (source `a2a`, `draft` unless explicitly approved).
pub async fn import_agent_card(
    domain: &Domain,
    ctx: &Ctx,
    card: &Value,
    source_url: &str,
    approve: bool,
) -> Result<somework_core::contracts::CatalogEntry, Error> {
    let (platform, digest) = normalize_card(card, domain.domain_id())?;
    let mut entry = domain
        .register_agent(
            ctx,
            RegisterAgent {
                card: serde_json::to_value(&platform)?,
                visibility: Some(Visibility::Domain),
                source: Some(Source { kind: SourceType::A2a, uri: Some(source_url.to_string()), digest: Some(digest) }),
            },
        )
        .await?;
    if approve {
        entry = domain
            .approve_entry(
                ctx,
                &entry.entry_id,
                ApproveEntry {
                    status: Some(ApprovalStatus::Approved),
                    visibility: Some(Visibility::Domain),
                    trust_tier: Some(TrustTier::External),
                    ..Default::default()
                },
            )
            .await?;
    }
    Ok(entry)
}

pub async fn fetch_card(url: &str) -> Result<Value, Error> {
    let resp = reqwest::get(url).await.map_err(|e| Error::unavailable(format!("fetch agent card: {e}")))?;
    if !resp.status().is_success() {
        return Err(Error::unavailable(format!("agent card request answered {}", resp.status())));
    }
    resp.json().await.map_err(|e| Error::invalid(format!("agent card is not JSON: {e}")))
}

/// Stores the credential presented to an external A2A origin (sealed with the domain master key).
pub async fn set_credential(domain: &Domain, origin: &str, scheme: &str, secret: &str, issuer: Option<&str>, audience: Option<&str>) -> Result<(), Error> {
    if !matches!(scheme, "bearer" | "assertion") {
        return Err(Error::invalid("scheme must be bearer or assertion"));
    }
    let sealed = domain.master.seal(secret.as_bytes(), origin.as_bytes());
    sqlx::query("INSERT INTO a2a_credentials(origin, scheme, secret_sealed, issuer, audience, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(origin) DO UPDATE SET scheme = excluded.scheme, secret_sealed = excluded.secret_sealed, issuer = excluded.issuer, audience = excluded.audience")
        .bind(origin)
        .bind(scheme)
        .bind(sealed)
        .bind(issuer)
        .bind(audience)
        .bind(domain.now_ts())
        .execute(domain.db.writer())
        .await
        .db()?;
    Ok(())
}

pub struct A2aBackend {
    pub domain: Domain,
    pub http: reqwest::Client,
}

impl A2aBackend {
    pub fn new(domain: Domain) -> Self {
        Self { domain, http: reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build().expect("http client") }
    }

    async fn authorization(&self, url: &str) -> Result<Option<String>, Error> {
        let origin = origin_of(url);
        let Some(row) = sqlx::query("SELECT * FROM a2a_credentials WHERE origin = ?").bind(&origin).fetch_optional(self.domain.db.pool()).await.db()? else {
            return Ok(None);
        };
        let secret = String::from_utf8(self.domain.master.open(&scol(&row, "secret_sealed"), origin.as_bytes())?)
            .map_err(|_| Error::internal("credential is not utf8"))?;
        match scol(&row, "scheme").as_str() {
            "bearer" => Ok(Some(secret)),
            _ => {
                let key = jws::signing_key_from_b64(&secret)?;
                let issuer = scol_opt(&row, "issuer").ok_or_else(|| Error::internal("assertion credential has no issuer"))?;
                let audience = scol_opt(&row, "audience").ok_or_else(|| Error::internal("assertion credential has no audience"))?;
                Ok(Some(jws::mint_assertion(&key, &issuer, &audience, None, self.domain.now(), ChronoDuration::seconds(120))))
            }
        }
    }

    async fn call(&self, method: Method, url: &str, body: Option<&Value>) -> Result<(StatusCode, Value), BackendError> {
        let mut req = self.http.request(method, url).header("A2A-Version", PROTOCOL_VERSION).header("Accept", "application/json");
        if let Some(token) = self.authorization(url).await.map_err(|e| BackendError::Gone(e.to_string()))? {
            req = req.bearer_auth(token);
        }
        if let Some(b) = body {
            req = req.json(b);
        }
        let resp = req.send().await.map_err(|e| BackendError::Transient(e.to_string()))?;
        let status = resp.status();
        let value: Value = resp.json().await.unwrap_or(Value::Null);
        if status.is_server_error() {
            return Err(BackendError::Transient(format!("remote answered {status}")));
        }
        Ok((status, value))
    }
}

fn map_state(s: &str) -> RemoteState {
    match s {
        "TASK_STATE_SUBMITTED" => RemoteState::Queued,
        "TASK_STATE_INPUT_REQUIRED" | "TASK_STATE_AUTH_REQUIRED" => RemoteState::InputRequired,
        "TASK_STATE_COMPLETED" => RemoteState::Succeeded,
        "TASK_STATE_FAILED" => RemoteState::Failed,
        "TASK_STATE_CANCELED" => RemoteState::Canceled,
        "TASK_STATE_REJECTED" => RemoteState::Rejected,
        _ => RemoteState::Running,
    }
}

fn reason_of(body: &Value) -> String {
    body["error"]["details"]
        .as_array()
        .and_then(|d| d.iter().find_map(|x| x["reason"].as_str()))
        .map(|r| format!("remote_{}", r.to_lowercase()))
        .unwrap_or_else(|| "remote_refused".into())
}

#[async_trait]
impl RemoteBackend for A2aBackend {
    async fn submit(&self, task: &TaskView, agent: &AgentInfo) -> Result<SubmitOutcome, BackendError> {
        let url = agent.card.interfaces.iter().find_map(|i| i.url.clone()).ok_or_else(|| BackendError::Gone("agent has no A2A interface".into()))?;
        let skill =
            agent.card.labels.get(&format!("{SKILL_LABEL_PREFIX}{}", task.task.capability.id)).cloned().unwrap_or_else(|| task.task.capability.id.clone());
        let body = json!({
            "message": {"messageId": task.task.task_id, "role": "ROLE_USER", "parts": [{"data": {"skillId": skill, "input": task.task.input}}], "metadata": {"skillId": skill}},
            "configuration": {"returnImmediately": true}
        });
        match self.call(Method::POST, &format!("{}/message:send", url.trim_end_matches('/')), Some(&body)).await? {
            (s, resp) if s.is_success() => {
                let t = &resp["task"];
                let id = t["id"].as_str().ok_or_else(|| BackendError::Gone("remote answered without a task".into()))?;
                Ok(SubmitOutcome::Accepted(RemoteRef {
                    external_task_id: id.into(),
                    external_context_id: t["contextId"].as_str().map(String::from),
                    peer_domain_id: None,
                    remote_interface: url,
                    protocol_version: PROTOCOL_VERSION.into(),
                    card_digest: agent.source_digest.clone(),
                    remote_principal: None,
                }))
            }
            (s, resp) => Ok(SubmitOutcome::Rejected { code: reason_of(&resp), message: format!("the A2A agent refused the request ({s})") }),
        }
    }

    async fn poll(&self, remote: &RemoteRef, cursor: i64) -> Result<RemoteSnapshot, BackendError> {
        let (status, t) = self.call(Method::GET, &format!("{}/tasks/{}", remote.remote_interface.trim_end_matches('/'), remote.external_task_id), None).await?;
        if status == StatusCode::NOT_FOUND {
            return Err(BackendError::Gone("the remote task no longer exists".into()));
        }
        if !status.is_success() {
            return Err(BackendError::Gone(format!("remote answered {status}")));
        }
        let mut snap = RemoteSnapshot { cursor, state: Some(map_state(t["status"]["state"].as_str().unwrap_or(""))), ..Default::default() };
        if let Some(text) = t["status"]["message"]["parts"].as_array().and_then(|p| p.first()).and_then(|p| p["text"].as_str()) {
            snap.failure_message = Some(text.to_string());
            snap.failure_code = Some(format!("remote_{}", text.split(':').next().unwrap_or("failed").trim().to_lowercase().replace(' ', "_")));
        }
        for a in t["artifacts"].as_array().cloned().unwrap_or_default() {
            for part in a["parts"].as_array().cloned().unwrap_or_default() {
                if part.get("data").is_some() && snap.result.is_none() {
                    snap.result = Some(part["data"].clone());
                } else if let Some(url) = part["url"].as_str() {
                    snap.artifacts.push(RemoteArtifact {
                        artifact_id: a["artifactId"].as_str().unwrap_or_default().into(),
                        version: 1,
                        filename: part["filename"].as_str().map(String::from),
                        media_type: part["mediaType"].as_str().unwrap_or("application/octet-stream").into(),
                        size_bytes: a["metadata"]["sizeBytes"].as_u64().unwrap_or(0),
                        sha256: a["metadata"]["sha256"].as_str().unwrap_or_default().into(),
                        classification: "internal".into(),
                        location: url.into(),
                    });
                } else if let Some(text) = part["text"].as_str()
                    && snap.result.is_none()
                {
                    snap.result = Some(json!({"text": text}));
                }
            }
        }
        Ok(snap)
    }

    async fn cancel(&self, remote: &RemoteRef) -> Result<(), BackendError> {
        self.call(Method::POST, &format!("{}/tasks/{}:cancel", remote.remote_interface.trim_end_matches('/'), remote.external_task_id), Some(&json!({})))
            .await
            .map(|_| ())
    }

    async fn fetch_artifact(&self, _remote: &RemoteRef, artifact: &RemoteArtifact) -> Result<Vec<u8>, BackendError> {
        let mut req = self.http.get(&artifact.location);
        if let Some(token) = self.authorization(&artifact.location).await.map_err(|e| BackendError::Gone(e.to_string()))? {
            req = req.bearer_auth(token);
        }
        let resp = req.send().await.map_err(|e| BackendError::Transient(e.to_string()))?;
        if !resp.status().is_success() {
            return Err(BackendError::Gone(format!("artifact fetch answered {}", resp.status())));
        }
        Ok(resp.bytes().await.map_err(|e| BackendError::Transient(e.to_string()))?.to_vec())
    }
}
