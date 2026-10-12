//! Sending a document: upload it as an `application/json` artifact and tell the agent with a `chat.message` from `service:operations`
//! (`triggerMode: directed`: the domain allows only `never` on a `chat.notice`, which would not wake the agent; labels `setup.kind`, `setup.revision`, `setup.sha256`). The domain client is the repository's own crate.

use super::contract::sha256_hex;
use fleet_shared::operations::*;
use serde_json::json;
use somework_client::Client;

pub struct Deliverer {
    client: Client,
}

/// What a document is, for the message around it.
pub enum Document<'a> {
    Override(&'a SetupOverride),
    Limits(&'a FleetLimits),
}

impl Document<'_> {
    fn kind(&self) -> &'static str {
        match self {
            Self::Override(_) => "override",
            Self::Limits(_) => "limits",
        }
    }

    fn revision(&self) -> u64 {
        match self {
            Self::Override(document) => document.revision,
            Self::Limits(document) => document.revision,
        }
    }

    fn bytes(&self) -> Vec<u8> {
        match self {
            Self::Override(document) => serde_json::to_vec(document),
            Self::Limits(document) => serde_json::to_vec(document),
        }
        .expect("a document serialises")
    }
}

impl Deliverer {
    pub fn new(client: Client) -> Self {
        Self { client }
    }

    /// `again` is set for a deliberate re-send of a revision the domain already accepted: it needs its own idempotency key, because a repeat of
    /// the first key is answered with the first message and wakes nobody.
    pub async fn send(&self, agent: &str, document: Document<'_>, again: Option<u64>) -> Result<(), String> {
        let (kind, revision) = (document.kind(), document.revision());
        let bytes = document.bytes();
        let sha = sha256_hex(&bytes);
        let filename = match kind {
            "override" => format!("setup-{}-r{revision}.json", super::contract::slug_of(agent)),
            _ => format!("limits-r{revision}.json"),
        };
        let artifact = self.client.upload_artifact(&filename, "application/json", "internal", &bytes).await.map_err(|error| format!("uploading the document failed: {}", describe(&error)))?;
        let artifact = serde_json::to_value(&artifact).map_err(|_| "the uploaded artifact cannot be referenced".to_string())?;
        let prefix = if kind == "override" { "setup" } else { "limits" };
        let key = match again {
            Some(round) => format!("{prefix}:{agent}:{revision}:again:{round}"),
            None => format!("{prefix}:{agent}:{revision}"),
        };
        let text = match kind {
            "override" => format!("Setup revision {revision}"),
            _ => format!("Fleet limits revision {revision}"),
        };
        let body = json!({
            "type": "chat.message",
            "recipients": [{"kind": "agent", "id": agent}],
            "triggerMode": "directed",
            "content": {"mediaType": "text/plain", "data": text},
            "artifacts": [artifact],
            "labels": {LABEL_KIND: kind, LABEL_REVISION: revision.to_string(), LABEL_SHA256: sha},
            "idempotencyKey": key,
        });
        match self.client.post_idem("/v1/messages", &body, &key).await {
            Ok(_) => Ok(()),
            // the first attempt reached the domain and only its answer was lost: the message is there
            Err(error) if format!("{:?}", error.code) == "IdempotencyConflict" => Ok(()),
            Err(error) => Err(format!("sending the message failed: {}", describe(&error))),
        }
    }
}

/// An error in our own words: the status and the domain's problem code, no body, never a credential.
fn describe(error: &somework_client::ClientError) -> String {
    if error.status == 0 { "the domain is unreachable".to_string() } else { format!("HTTP {} {:?}", error.status, error.code) }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use axum::{
        Json, Router,
        body::Bytes,
        extract::{Path, State},
        http::{HeaderMap, StatusCode},
        routing::{post, put},
    };
    use serde_json::Value;
    use std::sync::{Arc, Mutex};

    /// A fake domain: uploads land in memory, messages are recorded with their headers, and failures can be switched on.
    #[derive(Default)]
    pub struct FakeDomain {
        pub uploads: Mutex<Vec<(Value, Vec<u8>)>>,
        pub messages: Mutex<Vec<(Value, Option<String>, bool)>>,
        pub fail_messages: Mutex<Option<StatusCode>>,
        pub idempotency_conflict: Mutex<bool>,
        pub unauthenticated: Mutex<u32>,
        pub attempts: Mutex<u32>,
        base: Mutex<String>,
    }

    pub async fn fake_domain() -> (String, Arc<FakeDomain>) {
        let state = Arc::new(FakeDomain::default());
        let app = Router::new()
            .route(
                "/v1/artifacts/uploads",
                post(|State(state): State<Arc<FakeDomain>>, headers: HeaderMap, Json(body): Json<Value>| async move {
                    if !headers.get("authorization").and_then(|v| v.to_str().ok()).is_some_and(|v| v.starts_with("Bearer ") && v.split('.').count() == 3) {
                        *state.unauthenticated.lock().unwrap() += 1;
                        return (StatusCode::UNAUTHORIZED, Json(json!({"code": "unauthenticated"})));
                    }
                    let id = format!("art_{}", state.uploads.lock().unwrap().len() + 1);
                    let base = state.base.lock().unwrap().clone();
                    state.uploads.lock().unwrap().push((body.clone(), Vec::new()));
                    (StatusCode::OK, Json(json!({"artifactId": id, "version": 1, "url": format!("{base}/object/{id}"), "headers": {}})))
                }),
            )
            .route(
                "/object/{id}",
                put(|State(state): State<Arc<FakeDomain>>, Path(id): Path<String>, body: Bytes| async move {
                    let index: usize = id.trim_start_matches("art_").parse::<usize>().unwrap() - 1;
                    state.uploads.lock().unwrap()[index].1 = body.to_vec();
                    StatusCode::OK
                }),
            )
            .route(
                "/v1/artifacts/{id}/complete",
                post(|State(state): State<Arc<FakeDomain>>, Path(id): Path<String>| async move {
                    let index: usize = id.trim_start_matches("art_").parse::<usize>().unwrap() - 1;
                    let (request, bytes) = state.uploads.lock().unwrap()[index].clone();
                    Json(json!({
                        "artifactId": id, "version": 1, "uri": format!("somework://artifact/{id}/1"), "filename": request["filename"], "mediaType": request["mediaType"],
                        "sizeBytes": bytes.len(), "digest": {"algorithm": "sha256", "value": request["sha256"]}, "classification": "internal",
                        "createdBy": {"kind": "service", "id": "operations", "domainId": "development"}, "createdAt": "2026-10-10T10:00:00.000Z"
                    }))
                }),
            )
            .route(
                "/v1/messages",
                post(|State(state): State<Arc<FakeDomain>>, headers: HeaderMap, Json(body): Json<Value>| async move {
                    let key = headers.get("idempotency-key").and_then(|v| v.to_str().ok()).map(str::to_string);
                    *state.attempts.lock().unwrap() += 1;
                    if let Some(status) = *state.fail_messages.lock().unwrap() {
                        return (status, Json(json!({"code": "unavailable", "detail": "PRIVATE DOMAIN DETAIL"})));
                    }
                    if *state.idempotency_conflict.lock().unwrap() {
                        return (StatusCode::CONFLICT, Json(json!({"code": "idempotency_conflict", "detail": "key used"})));
                    }
                    state.messages.lock().unwrap().push((body, key, true));
                    (StatusCode::OK, Json(json!({"messageId": "msg_1", "conversationId": "conv_1", "seq": 1})))
                }),
            )
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        *state.base.lock().unwrap() = base.clone();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (base, state)
    }

    pub fn deliverer(base: &str) -> Deliverer {
        let seed = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        Deliverer::new(Client::assertion(base, seed, "service", "operations", "development").with_retries(0))
    }

    pub fn document(revision: u64) -> SetupOverride {
        SetupOverride {
            schema: SETUP_SCHEMA,
            kind: "override".into(),
            agent: "agent/pi-agent".into(),
            revision,
            saved_by: "a@example.com".into(),
            saved_at: "2026-10-10T10:00:00.000Z".into(),
            instructions: Some("Be brief".into()),
            disable_global_prompt: false,
            model: None,
            approval_patterns: None,
            skills: SetupSkills::default(),
            mcp: vec![],
        }
    }

    #[tokio::test]
    async fn a_document_is_uploaded_and_announced_with_the_labels_of_the_contract() {
        let (base, domain) = fake_domain().await;
        let deliverer = deliverer(&base);
        let document = document(5);
        deliverer.send("agent/pi-agent", Document::Override(&document), None).await.unwrap();
        let uploads = domain.uploads.lock().unwrap();
        assert_eq!(uploads.len(), 1);
        assert_eq!((uploads[0].0["mediaType"].as_str(), uploads[0].0["filename"].as_str()), (Some("application/json"), Some("setup-pi-agent-r5.json")));
        let parsed: Value = serde_json::from_slice(&uploads[0].1).unwrap();
        assert_eq!((parsed["kind"].as_str(), parsed["revision"].as_u64(), parsed["agent"].as_str(), parsed["instructions"].as_str()), (Some("override"), Some(5), Some("agent/pi-agent"), Some("Be brief")));
        let messages = domain.messages.lock().unwrap();
        let (body, key, _) = &messages[0];
        assert_eq!(key.as_deref(), Some("setup:agent/pi-agent:5"));
        assert_eq!(body["type"], "chat.message", "a chat.notice may not be directed");
        assert_eq!(body["triggerMode"], "directed");
        assert_eq!(body["recipients"], json!([{"kind": "agent", "id": "agent/pi-agent"}]));
        assert_eq!(body["labels"]["setup.kind"], "override");
        assert_eq!(body["labels"]["setup.revision"], "5");
        assert_eq!(body["labels"]["setup.sha256"], sha256_hex(&uploads[0].1), "the label is the SHA-256 of the attached bytes");
        assert_eq!(body["artifacts"][0]["mediaType"], "application/json");
        assert_eq!(body["idempotencyKey"], "setup:agent/pi-agent:5");
    }

    #[tokio::test]
    async fn limits_go_the_same_way_with_their_own_kind_and_key() {
        let (base, domain) = fake_domain().await;
        let limits = FleetLimits { schema: 1, kind: "limits".into(), revision: 2, saved_by: "a@b".into(), saved_at: "t".into(), max_tokens_cap: 1, max_minutes_cap: 2, daily_token_limit: 3, budget_raise_ceiling: 4, global_prompt: None };
        deliverer(&base).send("agent/qa", Document::Limits(&limits), None).await.unwrap();
        let messages = domain.messages.lock().unwrap();
        assert_eq!(messages[0].1.as_deref(), Some("limits:agent/qa:2"));
        assert_eq!(messages[0].0["labels"]["setup.kind"], "limits");
        assert_eq!(domain.uploads.lock().unwrap()[0].0["filename"], "limits-r2.json");
    }

    #[tokio::test]
    async fn a_deliberate_resend_uses_a_new_key_so_the_domain_does_not_swallow_it() {
        let (base, domain) = fake_domain().await;
        let deliverer = deliverer(&base);
        let document = document(5);
        deliverer.send("agent/pi-agent", Document::Override(&document), None).await.unwrap();
        deliverer.send("agent/pi-agent", Document::Override(&document), Some(7)).await.unwrap();
        let keys: Vec<_> = domain.messages.lock().unwrap().iter().map(|m| m.1.clone().unwrap()).collect();
        assert_eq!(keys, vec!["setup:agent/pi-agent:5", "setup:agent/pi-agent:5:again:7"]);
    }

    #[tokio::test]
    async fn a_refusal_is_an_error_in_our_words_without_the_domains_text() {
        let (base, domain) = fake_domain().await;
        *domain.fail_messages.lock().unwrap() = Some(StatusCode::FORBIDDEN);
        let error = deliverer(&base).send("agent/pi-agent", Document::Override(&document(1)), None).await.unwrap_err();
        assert!(error.contains("sending the message failed") && error.contains("403"), "{error}");
        assert!(!error.contains("PRIVATE"), "{error}");
        let dead = deliverer("http://127.0.0.1:9").send("agent/pi-agent", Document::Override(&document(1)), None).await.unwrap_err();
        assert!(dead.contains("unreachable"), "{dead}");
    }

    #[tokio::test]
    async fn an_idempotency_conflict_means_the_first_attempt_got_through() {
        let (base, domain) = fake_domain().await;
        *domain.idempotency_conflict.lock().unwrap() = true;
        assert!(deliverer(&base).send("agent/pi-agent", Document::Override(&document(1)), None).await.is_ok());
    }

    #[tokio::test]
    async fn every_request_carries_a_signed_assertion() {
        let (base, domain) = fake_domain().await;
        deliverer(&base).send("agent/pi-agent", Document::Override(&document(1)), None).await.unwrap();
        assert_eq!(*domain.unauthenticated.lock().unwrap(), 0);
    }
}
