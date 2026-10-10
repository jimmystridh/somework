//! Outbound projection: canonical events -> readable Matrix rooms/threads plus structured custom events.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Value, json};
use somework_core::{
    Error, ErrorCode,
    contracts::{ActorKind, MessageType},
    taxonomy,
};
use somework_domain::{
    config::SINK_MATRIX,
    outbox::{OutboxItem, OutboxSink, SinkError},
    transport::Mapping,
};

use crate::bridge::*;

pub struct MatrixSink {
    pub bridge: Arc<Bridge>,
}

fn sink_error(e: Error) -> SinkError {
    match e.code {
        ErrorCode::Unavailable | ErrorCode::PolicyUnavailable | ErrorCode::RateLimited | ErrorCode::Internal => SinkError::transient(e.message),
        _ => SinkError::permanent(e.message),
    }
}

fn text_of(data: &Value) -> String {
    match data {
        Value::String(s) => s.clone(),
        Value::Object(o) => o.get("text").or_else(|| o.get("body")).and_then(Value::as_str).map(String::from).unwrap_or_else(|| data.to_string()),
        other => other.to_string(),
    }
}

#[async_trait]
impl OutboxSink for MatrixSink {
    fn name(&self) -> &'static str {
        SINK_MATRIX
    }

    async fn deliver(&self, item: &OutboxItem) -> Result<(), SinkError> {
        self.project(item).await.map_err(sink_error)
    }
}

impl MatrixSink {
    pub fn new(bridge: Arc<Bridge>) -> Self {
        Self { bridge }
    }

    async fn project(&self, item: &OutboxItem) -> Result<(), Error> {
        let kind = item.payload["type"].as_str().unwrap_or_default().to_string();
        match kind.as_str() {
            "message.created" => self.project_message(item).await,
            "artifact.published" => self.project_artifact(item).await,
            _ => Ok(()),
        }
    }

    async fn project_message(&self, item: &OutboxItem) -> Result<(), Error> {
        let b = &self.bridge;
        let message_id = item.payload["messageId"].as_str().ok_or_else(|| Error::invalid("message event without messageId"))?;
        if b.domain.mapping_by_object(TRANSPORT, "message", message_id).await?.is_some() {
            return Ok(()); // already projected, or ingested from Matrix itself (own-origin)
        }
        let ctx = b.ctx();
        let record = b.domain.get_message(&ctx, message_id).await?;
        let env = &record.envelope;
        let Some(conversation_id) = env.conversation_id.clone() else { return Ok(()) };
        let room = b.ensure_room(&conversation_id).await?;
        let allowed = b.content_allowed();
        let sender_label = env.sender.display_name.clone().unwrap_or_else(|| env.sender.id.clone());
        let ref_uri = format!("somework://messages/{message_id}");
        let txn = item.dedupe_key.clone();
        let mut relates: Option<Value> = None;
        if let Some(reply_to) = &env.reply_to
            && let Some(m) = b.domain.mapping_by_object(TRANSPORT, "message", reply_to).await?
        {
            relates = Some(json!({"m.in_reply_to": {"event_id": m.external_id}}));
        }
        let reference = json!({"type": "message", "id": message_id, "message_type": taxonomy::type_name(env.kind)});
        let first_event: Option<String>;

        match env.kind {
            MessageType::ChatMessage | MessageType::EventNotification | MessageType::ChatNotice => {
                let text = if allowed {
                    text_of(&env.content.data)
                } else {
                    format!("[{} from {sender_label}; content withheld by the {:?} profile]", taxonomy::type_name(env.kind), b.profile())
                };
                let (sender, body, msgtype) = match (env.sender.kind, env.kind) {
                    (ActorKind::Agent, MessageType::ChatMessage) => (b.ensure_virtual_user(&env.sender.id).await?, text, "m.text"),
                    (ActorKind::Agent, _) => (b.ensure_virtual_user(&env.sender.id).await?, text, "m.notice"),
                    (_, MessageType::ChatMessage) => (b.cfg.bot_user_id(), format!("{sender_label}: {text}"), "m.text"),
                    _ => (b.cfg.bot_user_id(), format!("{sender_label}: {text}"), "m.notice"),
                };
                if sender != b.cfg.bot_user_id() {
                    b.ensure_joined(&room, &sender).await?;
                }
                let mut content =
                    json!({"msgtype": msgtype, "body": body, REF_KEY: reference, "dev.somework.sender": {"kind": env.sender.kind, "id": env.sender.id}});
                if let Some(r) = relates {
                    content["m.relates_to"] = r;
                }
                first_event = Some(b.send(&room, &sender, "m.room.message", &txn, content, &ref_uri).await?);
            }
            MessageType::ArtifactPublished => {
                first_event = Some(b.notice(&room, &txn, "Artifact published", None, Some(reference)).await?);
            }
            MessageType::CatalogChanged | MessageType::PolicyDenied | MessageType::PresenceChanged => return Ok(()),
        }
        if let Some(event_id) = first_event {
            b.domain.put_mapping(&Mapping::new(TRANSPORT, event_id, "message", message_id, json!({"roomId": room}))).await?;
        }
        Ok(())
    }

    async fn project_artifact(&self, item: &OutboxItem) -> Result<(), Error> {
        let b = &self.bridge;
        let Some(conversation_id) =
            item.payload.get("conversationId").and_then(Value::as_str).or(Some(item.subject.as_str()).filter(|s| s.starts_with("conv_")))
        else {
            return Ok(());
        };
        let room = b.ensure_room(conversation_id).await?;
        let (id, version) = (item.payload["artifactId"].as_str().unwrap_or_default(), item.payload["version"].clone());
        let structured = json!({
            "schema_version": "1.0", "artifact_id": id, "version": version, "uri": item.payload["uri"], "size_bytes": item.payload["sizeBytes"],
            "classification": item.payload["classification"],
            "canonical_ref": format!("somework://artifacts/{id}/versions/{version}/metadata"),
        });
        b.send(&room, &b.cfg.bot_user_id(), EV_ARTIFACT, &format!("{}.s", item.dedupe_key), structured, &format!("somework://artifacts/{id}")).await?;
        b.notice(
            &room,
            &item.dedupe_key,
            &format!("Artifact {id} v{version} published ({} bytes)", item.payload["sizeBytes"]),
            None,
            Some(json!({"type": "artifact", "id": id})),
        )
        .await?;
        Ok(())
    }
}
