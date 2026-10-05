//! Extended collaboration tools (optional, `--extended-tools`): conversation discovery and membership, inbox with read
//! receipts, cursor-based polling and end-to-end sealed secrets. They sit beside the 18 `collab_*` tools of the spec and
//! are thin wrappers over the REST SDK, like everything else in the MCP server.

use std::sync::Mutex;

use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::SigningKey;
use hkdf::Hkdf;
use serde_json::{Value, json};
use sha2::Sha256;
use somework_client::{Client, ClientError};
use somework_core::{ErrorCode, jws};
use x25519_dalek::{PublicKey, StaticSecret};

#[derive(Default)]
pub struct ExtendedState {
    cursor: Mutex<Option<i64>>,
    own_id: tokio::sync::OnceCell<String>,
    pub signing_key: Option<SigningKey>,
}

impl ExtendedState {
    pub fn with_key(key: SigningKey) -> Self {
        Self { cursor: Mutex::new(None), own_id: Default::default(), signing_key: Some(key) }
    }
}

fn invalid(message: impl Into<String>) -> ClientError {
    ClientError { status: 422, code: ErrorCode::ValidationFailed, message: message.into(), details: None, trace_id: None }
}

fn arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, ClientError> {
    args.get(key).and_then(Value::as_str).ok_or_else(|| invalid(format!("`{key}` is required")))
}

fn enc(s: &str) -> String {
    urlencoding::encode(s).into_owned()
}

fn text_of(message: &Value) -> String {
    match &message["content"]["data"] {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn message_view(m: &Value) -> Value {
    json!({
        "messageId": m["messageId"],
        "from": m["sender"]["id"],
        "to": m["recipients"].as_array().map(|r| r.iter().map(|x| x["id"].clone()).collect::<Vec<_>>()),
        "conversationId": m["conversationId"],
        "type": m["type"],
        "text": text_of(m),
        "createdAt": m["createdAt"],
    })
}

/// Accepts a conversation id, or the title of an open room.
async fn resolve_conversation(client: &Client, name: &str) -> Result<String, ClientError> {
    if name.starts_with("conv_") {
        return Ok(name.to_string());
    }
    let list = client.get("/v1/conversations?open=true").await?;
    list["conversations"]
        .as_array()
        .and_then(|a| a.iter().find(|c| c["title"] == name))
        .and_then(|c| c["conversationId"].as_str().map(String::from))
        .ok_or_else(|| ClientError { status: 404, code: ErrorCode::NotFound, message: format!("conversation {name} not found"), details: None, trace_id: None })
}

pub async fn call(client: &Client, state: &ExtendedState, tool: &str, args: Value) -> Result<Value, ClientError> {
    match tool {
        "collab_whoami" => {
            let who = client.get("/v1/admin/whoami").await?;
            Ok(
                json!({"id": who["actor"]["id"], "kind": who["actor"]["kind"], "domainId": who["actor"]["domainId"], "runtimeInstanceId": who["runtimeInstanceId"]}),
            )
        }
        "collab_conversation_list" => {
            let path = if args["open"].as_bool().unwrap_or(false) { "/v1/conversations?open=true" } else { "/v1/conversations" };
            let list = client.get(path).await?;
            let conversations: Vec<Value> = list["conversations"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|c| json!({"conversationId": c["conversationId"], "title": c["title"], "kind": c["kind"], "members": c["members"].as_array().map(|m| m.iter().map(|x| x["id"].clone()).collect::<Vec<_>>())}))
                .collect();
            Ok(json!({"conversations": conversations}))
        }
        "collab_conversation_create" => {
            let title = arg(&args, "title")?;
            let open = args["open"].as_bool().unwrap_or(false);
            let c = client.post("/v1/conversations", &json!({"kind": "room", "title": title, "open": open})).await?;
            Ok(json!({"conversationId": c["conversationId"], "title": title, "open": open}))
        }
        "collab_conversation_join" => {
            let id = resolve_conversation(client, arg(&args, "conversation")?).await?;
            let c = client.post(&format!("/v1/conversations/{}/join", enc(&id)), &json!({})).await?;
            Ok(json!({"joined": c["conversationId"]}))
        }
        "collab_conversation_leave" => {
            let id = resolve_conversation(client, arg(&args, "conversation")?).await?;
            client.raw(reqwest::Method::POST, &format!("/v1/conversations/{}/leave", enc(&id)), Some(&json!({})), None, None).await?;
            Ok(json!({"left": id}))
        }
        "collab_inbox" => {
            let unread = args["unread"].as_bool().unwrap_or(true);
            let inbox = client.get(&format!("/v1/inbox?unread={unread}")).await?;
            let messages: Vec<Value> = inbox["messages"].as_array().cloned().unwrap_or_default().iter().map(message_view).collect();
            Ok(json!({"messages": messages}))
        }
        "collab_inbox_mark_read" => {
            let r = client.post("/v1/messages/read", &json!({"messageIds": args["messageIds"]})).await?;
            Ok(json!({"updated": r["updated"]}))
        }
        "collab_events_poll" => {
            let wait = args["wait"].as_u64().unwrap_or(0).min(30);
            let own_id = state
                .own_id
                .get_or_try_init(|| async { client.get("/v1/admin/whoami").await.map(|who| who["actor"]["id"].as_str().unwrap_or_default().to_string()) })
                .await?;
            let known = *state.cursor.lock().expect("cursor");
            // A live feed: the first poll of a session starts at "now". Anything older is still unread in `collab_inbox`.
            let after = match known {
                Some(cursor) => cursor,
                None => client.get("/v1/events?wait=0").await?["cursor"].as_i64().unwrap_or(0),
            };
            let batch = client.get(&format!("/v1/events?after={after}&wait={wait}")).await?;
            let mut messages = vec![];
            for e in batch["events"].as_array().cloned().unwrap_or_default() {
                if e["type"] == "message.created"
                    && let Some(id) = e["payload"]["messageId"].as_str()
                    && let Ok(m) = client.get(&format!("/v1/messages/{id}")).await
                    && m["sender"]["id"].as_str() != Some(own_id.as_str())
                {
                    messages.push(message_view(&m));
                }
            }
            let cursor = batch["cursor"].as_i64().unwrap_or(after);
            *state.cursor.lock().expect("cursor") = Some(cursor);
            client.ack_events(cursor).await?;
            Ok(json!({"messages": messages}))
        }
        "collab_secret_seal" => {
            let to = arg(&args, "to")?;
            let secret = arg(&args, "secret")?;
            let key = client.get(&format!("/v1/sealed/recipients/agent/{}/key", enc(to))).await?;
            let envelope = seal_to(key["publicKey"].as_str().unwrap_or_default(), secret.as_bytes()).map_err(invalid)?;
            let r = client
                .post("/v1/sealed", &json!({"to": {"kind": "agent", "id": to}, "envelope": envelope, "ttlSeconds": args["ttlSeconds"], "label": args["label"]}))
                .await?;
            Ok(json!({"secretId": r["secretId"], "expiresAt": r["expiresAt"]}))
        }
        "collab_secret_list" => client.get("/v1/sealed").await,
        "collab_secret_open" => {
            let id = arg(&args, "secretId")?;
            let key = state.signing_key.as_ref().ok_or_else(|| invalid("this sidecar was started without its key; it cannot decrypt sealed secrets"))?;
            let opened = client.post(&format!("/v1/sealed/{}/open", enc(id)), &json!({})).await?;
            let plain = open_with(key, opened["envelope"].as_str().unwrap_or_default()).map_err(invalid)?;
            Ok(json!({"from": opened["from"], "label": opened["label"], "secret": String::from_utf8_lossy(&plain)}))
        }
        other => Err(invalid(format!("unknown tool {other}"))),
    }
}

fn derive_key(shared: &[u8]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(None, shared);
    let mut okm = [0u8; 32];
    hk.expand(b"somework-sealed-v1", &mut okm).expect("32 bytes is a valid HKDF output length");
    okm
}

/// Encrypts `plaintext` to the holder of the Ed25519 key `recipient_public_b64` (X25519 ECDH + AES-256-GCM).
pub fn seal_to(recipient_public_b64: &str, plaintext: &[u8]) -> Result<String, String> {
    let recipient = jws::verifying_key_from_b64(recipient_public_b64).map_err(|e| e.message)?;
    let recipient_x = PublicKey::from(recipient.to_montgomery().to_bytes());
    let ephemeral = StaticSecret::from(rand::random::<[u8; 32]>());
    let shared = ephemeral.diffie_hellman(&recipient_x);
    let key = derive_key(shared.as_bytes());
    let nonce_bytes: [u8; 12] = rand::random();
    let cipher = Aes256Gcm::new((&key).into());
    let ct = cipher.encrypt(&Nonce::try_from(nonce_bytes.as_slice()).map_err(|_| "bad nonce")?, plaintext).map_err(|_| "encryption failed".to_string())?;
    let envelope = json!({"v": 1, "epk": URL_SAFE_NO_PAD.encode(PublicKey::from(&ephemeral).as_bytes()), "nonce": URL_SAFE_NO_PAD.encode(nonce_bytes), "ct": URL_SAFE_NO_PAD.encode(ct)});
    Ok(URL_SAFE_NO_PAD.encode(envelope.to_string()))
}

pub fn open_with(key: &SigningKey, envelope_b64: &str) -> Result<Vec<u8>, String> {
    let raw = URL_SAFE_NO_PAD.decode(envelope_b64).map_err(|_| "malformed envelope")?;
    let env: Value = serde_json::from_slice(&raw).map_err(|_| "malformed envelope")?;
    let decode = |k: &str| URL_SAFE_NO_PAD.decode(env[k].as_str().unwrap_or_default()).map_err(|_| format!("malformed envelope field {k}"));
    let epk: [u8; 32] = decode("epk")?.try_into().map_err(|_| "bad ephemeral key")?;
    let nonce = decode("nonce")?;
    let ct = decode("ct")?;
    let secret = StaticSecret::from(key.to_scalar_bytes());
    let shared = secret.diffie_hellman(&PublicKey::from(epk));
    let k = derive_key(shared.as_bytes());
    Aes256Gcm::new((&k).into())
        .decrypt(&Nonce::try_from(nonce.as_slice()).map_err(|_| "bad nonce")?, ct.as_slice())
        .map_err(|_| "the envelope is not addressed to this key".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sealed_envelopes_open_only_for_the_recipient() {
        let recipient = jws::new_signing_key();
        let other = jws::new_signing_key();
        let envelope = seal_to(&jws::verifying_key_to_b64(&recipient.verifying_key()), b"hunter2").unwrap();
        assert!(!envelope.contains("hunter2"));
        assert_eq!(open_with(&recipient, &envelope).unwrap(), b"hunter2");
        assert!(open_with(&other, &envelope).is_err());
    }
}
