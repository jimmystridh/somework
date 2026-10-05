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
            k if k.starts_with("task.") => self.project_task_event(item, k.trim_start_matches("task.")).await,
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
        let thread_root = match &env.task_id {
            Some(task_id) => Some(b.task_root(&room, task_id).await?),
            None => None,
        };
        let allowed = b.content_allowed();
        let sender_label = env.sender.display_name.clone().unwrap_or_else(|| env.sender.id.clone());
        let ref_uri = format!("somework://messages/{message_id}");
        let txn = item.dedupe_key.clone();
        let mut relates = thread_root.as_deref().map(thread_relation);
        if let Some(reply_to) = &env.reply_to
            && let Some(m) = b.domain.mapping_by_object(TRANSPORT, "message", reply_to).await?
        {
            let mut rel = relates.take().unwrap_or_else(|| json!({}));
            rel["m.in_reply_to"] = json!({"event_id": m.external_id});
            relates = Some(rel);
        }
        let reference = json!({"type": "message", "id": message_id, "message_type": taxonomy::type_name(env.kind)});
        let mut first_event: Option<String> = None;

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
            MessageType::TaskStatus => {
                let event = env.content.data["event"].as_str().unwrap_or_default();
                if event == "progress" {
                    if let Some(task_id) = &env.task_id {
                        self.update_progress(&room, task_id, thread_root.as_deref().unwrap_or_default(), &txn).await?;
                    }
                    return Ok(());
                }
                let text = env.content.data["text"].as_str().unwrap_or("Task update").to_string();
                let revision = env.content.data["revision"].clone();
                let body = if allowed || !matches!(event, "running" | "input_required" | "blocked") { text } else { format!("Task update ({event})") };
                let reference = json!({"type": "task", "id": env.task_id, "revision": revision});
                first_event = Some(b.notice(&room, &txn, &body, thread_root.as_deref(), Some(reference)).await?);
            }
            MessageType::TaskRequest => {}
            MessageType::TaskResult => {
                let d = &env.content.data;
                let body = format!(
                    "Task {} (revision {}){}",
                    d["state"].as_str().unwrap_or("finished"),
                    d["revision"],
                    d["artifacts"].as_array().filter(|a| !a.is_empty()).map(|a| format!("; {} artifact(s)", a.len())).unwrap_or_default()
                );
                first_event = Some(
                    b.notice(&room, &txn, &body, thread_root.as_deref(), Some(json!({"type": "task", "id": env.task_id, "revision": d["revision"]}))).await?,
                );
            }
            MessageType::TaskInput => {
                let body =
                    if allowed { format!("Input provided: {}", text_of(&env.content.data["data"])) } else { "Input provided (content withheld)".to_string() };
                first_event = Some(b.notice(&room, &txn, &body, thread_root.as_deref(), Some(reference)).await?);
            }
            MessageType::ContextOffer => {
                let d = &env.content.data;
                let structured = json!({
                    "schema_version": "1.0",
                    "offer_id": d["offerId"], "context_pack_id": d["contextPackId"], "version": d["version"], "mode": d["mode"],
                    "canonical_ref": format!("somework://contexts/{}/versions/{}", d["contextPackId"].as_str().unwrap_or_default(), d["version"]),
                });
                let mut structured = structured;
                if let Some(r) = &relates {
                    structured["m.relates_to"] = r.clone();
                }
                b.send(&room, &b.cfg.bot_user_id(), EV_CONTEXT, &format!("{txn}.s"), structured, &ref_uri).await?;
                let objective = if allowed { d["objective"].as_str().unwrap_or_default().to_string() } else { "(content withheld)".into() };
                let body = format!("Context offered by {sender_label} ({}): {objective}", d["mode"].as_str().unwrap_or("consultation"));
                first_event = Some(b.notice(&room, &txn, &body, thread_root.as_deref(), Some(reference)).await?);
            }
            MessageType::ApprovalRequest => {
                first_event = Some(self.project_approval_request(&room, item, &record.envelope.content.data, &txn, relates).await?);
            }
            MessageType::ApprovalDecision | MessageType::ContextAccepted | MessageType::ArtifactPublished => {
                let d = &env.content.data;
                let body = match env.kind {
                    MessageType::ApprovalDecision => format!(
                        "Approval {} {} by {}",
                        d["approvalId"].as_str().unwrap_or_default(),
                        d["decision"].as_str().unwrap_or_default(),
                        d["decidedBy"].as_str().unwrap_or_default()
                    ),
                    MessageType::ContextAccepted => format!("Context offer {} accepted", d["offerId"].as_str().unwrap_or_default()),
                    _ => "Artifact published".to_string(),
                };
                first_event = Some(b.notice(&room, &txn, &body, thread_root.as_deref(), Some(reference)).await?);
            }
            MessageType::CatalogChanged | MessageType::PolicyDenied | MessageType::StreamChunk | MessageType::PresenceChanged => return Ok(()),
        }
        if let Some(event_id) = first_event {
            b.domain.put_mapping(&Mapping::new(TRANSPORT, event_id, "message", message_id, json!({"roomId": room}))).await?;
        }
        Ok(())
    }

    /// Structured approval event + readable prompt. Reactions on either event resolve to the stored approval
    /// details (id, action digest, task revision), so a stale reaction can never approve a changed action.
    async fn project_approval_request(&self, room: &str, item: &OutboxItem, d: &Value, txn: &str, relates: Option<Value>) -> Result<String, Error> {
        let b = &self.bridge;
        let approval_id = d["approvalId"].as_str().unwrap_or_default();
        let task_id = d["taskId"].as_str().unwrap_or_default();
        if let Some(conv) = item.payload["conversationId"].as_str() {
            b.sync_members(room, conv).await?;
        }
        let mut structured = json!({
            "schema_version": "1.0", "approval_id": approval_id, "task_id": task_id, "task_revision": d["taskRevision"], "action_digest": d["actionDigest"],
            "action": d["action"], "side_effects": d["sideEffects"], "expires_at": d["expiresAt"], "state": "pending",
            "canonical_ref": format!("somework://tasks/{task_id}"),
        });
        if let Some(r) = &relates {
            structured["m.relates_to"] = r.clone();
        }
        let structured_event = b.send(room, &b.cfg.bot_user_id(), EV_APPROVAL, &format!("{txn}.s"), structured, &format!("somework://tasks/{task_id}")).await?;
        let body = format!(
            "Approval required for {} (task {task_id}, id {approval_id}). React 👍 to approve or 👎 to deny; this approval is bound to the exact action and expires {}.",
            d["action"].as_str().unwrap_or_default(),
            d["expiresAt"].as_str().unwrap_or_default()
        );
        let mut content = json!({"msgtype": "m.notice", "body": body, REF_KEY: {"type": "approval", "id": approval_id}});
        if let Some(r) = relates {
            content["m.relates_to"] = r;
        }
        let readable = b.send(room, &b.cfg.bot_user_id(), "m.room.message", txn, content, &format!("somework://tasks/{task_id}")).await?;
        let data = json!({"approvalId": approval_id, "actionDigest": d["actionDigest"], "taskRevision": d["taskRevision"], "taskId": task_id, "roomId": room, "expiresAt": d["expiresAt"]});
        b.domain.put_mapping(&Mapping::new(TRANSPORT, &structured_event, "approval", approval_id, data.clone())).await?;
        b.domain.put_mapping(&Mapping::new(TRANSPORT, &readable, "approval", approval_id, data)).await?;
        Ok(readable)
    }

    async fn project_task_event(&self, item: &OutboxItem, event_type: &str) -> Result<(), Error> {
        let b = &self.bridge;
        let task_id = item.payload["taskId"].as_str().ok_or_else(|| Error::invalid("task event without taskId"))?;
        let Some(conversation_id) = item.payload["conversationId"].as_str() else { return Ok(()) };
        let room = b.ensure_room(conversation_id).await?;
        let root = b.task_root(&room, task_id).await?;
        if event_type == "progress" {
            return self.update_progress(&room, task_id, &root, &item.dedupe_key).await;
        }
        let view = b.domain.get_task(&b.ctx(), task_id).await?;
        let state = item.payload["state"].as_str().unwrap_or_default();
        let revision = item.payload["revision"].clone();
        let agent = view.task.assignee.as_ref().map(|a| a.id.clone()).or(view.task.target_agent_id.clone());
        let mut content = json!({
            "schema_version": "1.0",
            "task_id": task_id,
            "conversation_id": conversation_id,
            "state": state,
            "revision": revision,
            "agent_id": agent,
            "summary": format!("{event_type}: task is {state}"),
            "canonical_ref": format!("somework://tasks/{task_id}"),
            "m.relates_to": thread_relation(&root),
        });
        if matches!(item.payload["state"].as_str(), Some("queued")) {
            content["capability"] = json!({"id": item.payload["capabilityId"], "version": item.payload["capabilityVersion"]});
        }
        b.send(&room, &b.cfg.bot_user_id(), EV_TASK, &item.dedupe_key, content, &format!("somework://tasks/{task_id}")).await?;
        Ok(())
    }

    /// One progress notice per task, edited in place (`m.replace`). The outbox coalesces rows so edits are throttled.
    async fn update_progress(&self, room: &str, task_id: &str, root: &str, txn: &str) -> Result<(), Error> {
        let b = &self.bridge;
        let events = b.domain.list_task_events(&b.ctx(), task_id, 0, 1000).await?;
        let latest = events.iter().rev().find(|e| matches!(e.kind.as_str(), "task.progress" | "task.running"));
        let (text, revision) = match latest {
            Some(e) => {
                let message = e.data["message"].as_str().map(String::from);
                let percent = e.data["percent"].as_f64().map(|p| format!(" ({p:.0}%)"));
                let text = if b.content_allowed() {
                    format!("Progress: {}{}", message.unwrap_or_else(|| "working".into()), percent.unwrap_or_default())
                } else {
                    format!("Progress update (revision {})", e.revision)
                };
                (text, e.revision)
            }
            None => return Ok(()),
        };
        let mapping = b.domain.mapping_by_object(TRANSPORT, "progress", task_id).await?;
        let reference = json!({"type": "task", "id": task_id, "revision": revision});
        match mapping {
            None => {
                let content = json!({"msgtype": "m.notice", "body": text, REF_KEY: reference, "m.relates_to": thread_relation(root)});
                let event_id = b
                    .send(room, &b.cfg.bot_user_id(), "m.room.message", &format!("progress:{task_id}"), content, &format!("somework://tasks/{task_id}"))
                    .await?;
                b.domain
                    .put_mapping(&Mapping::new(TRANSPORT, &event_id, "progress", task_id, json!({"roomId": room, "text": text, "revision": revision})))
                    .await?;
            }
            Some(m) => {
                if m.data["text"].as_str() == Some(text.as_str()) {
                    return Ok(());
                }
                let content = json!({
                    "msgtype": "m.notice",
                    "body": format!("* {text}"),
                    "m.new_content": {"msgtype": "m.notice", "body": text},
                    "m.relates_to": {"rel_type": "m.replace", "event_id": m.external_id},
                    REF_KEY: reference,
                });
                b.send(room, &b.cfg.bot_user_id(), "m.room.message", txn, content, &format!("somework://tasks/{task_id}")).await?;
                b.domain.update_mapping_data(TRANSPORT, &m.external_id, &json!({"roomId": room, "text": text, "revision": revision})).await?;
            }
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
