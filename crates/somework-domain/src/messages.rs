//! Conversations and typed messages (MSG-01..04). Plain chat is just one message type; every message carries
//! explicit trigger semantics and loop protection.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use somework_core::{
    Error, ErrorCode,
    canonical::digest_json,
    contracts::*,
    ids, schema, subjects,
    taxonomy::{self, may_wake},
};
use sqlx::SqliteConnection;

use crate::{
    audit::AuditRecord,
    db::{DbResultExt, icol, jcol, scol, scol_opt},
    domain::{Ctx, Domain, kind_str, parse_kind},
    events::EventSpec,
    policy::AuthzRequest,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberRef {
    pub kind: ActorKind,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CreateConversation {
    pub conversation_id: Option<String>,
    pub kind: Option<String>,
    pub title: Option<String>,
    pub classification: Option<String>,
    pub members: Vec<MemberRef>,
    pub parent_conversation_id: Option<String>,
    /// Open rooms (channels) can be joined by any cleared principal.
    pub open: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationView {
    pub conversation_id: String,
    pub domain_id: String,
    pub kind: String,
    pub title: Option<String>,
    pub classification: String,
    pub created_by: String,
    pub parent_conversation_id: Option<String>,
    pub task_id: Option<String>,
    pub members: Vec<MemberRef>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SendMessage {
    #[serde(rename = "type")]
    pub kind: Option<MessageType>,
    pub message_id: Option<String>,
    pub sender: Option<ActorRef>,
    pub conversation_id: Option<String>,
    pub task_id: Option<String>,
    pub recipients: Vec<MemberRef>,
    pub content: Option<MessageContent>,
    pub correlation_id: Option<String>,
    pub causation_id: Option<String>,
    pub reply_to: Option<String>,
    pub expires_at: Option<String>,
    pub priority: Option<Priority>,
    pub trigger_mode: Option<TriggerMode>,
    pub artifacts: Vec<ArtifactRef>,
    pub context_refs: Vec<ContextRef>,
    pub labels: BTreeMap<String, String>,
    pub traceparent: Option<String>,
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRecord {
    pub seq: i64,
    #[serde(flatten)]
    pub envelope: MessageEnvelope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePage {
    pub messages: Vec<MessageRecord>,
    pub next_cursor: Option<i64>,
}

/// What an internal caller (tasks, context, approvals) needs to post a platform-emitted message.
pub struct SystemMessage {
    pub kind: MessageType,
    pub conversation_id: Option<String>,
    pub task_id: Option<String>,
    pub recipients: Vec<(ActorRef, String)>,
    pub content: Value,
    pub media_type: &'static str,
    pub trigger: Option<TriggerMode>,
    pub causation_id: Option<String>,
    pub artifacts: Vec<ArtifactRef>,
    pub context_refs: Vec<ContextRef>,
}

impl SystemMessage {
    pub fn new(kind: MessageType, content: Value) -> Self {
        Self {
            kind,
            conversation_id: None,
            task_id: None,
            recipients: vec![],
            content,
            media_type: "application/json",
            trigger: None,
            causation_id: None,
            artifacts: vec![],
            context_refs: vec![],
        }
    }
}

fn conversation_from_row(row: &sqlx::sqlite::SqliteRow, members: Vec<MemberRef>) -> ConversationView {
    ConversationView {
        conversation_id: scol(row, "conversation_id"),
        domain_id: scol(row, "domain_id"),
        kind: scol(row, "kind"),
        title: scol_opt(row, "title"),
        classification: scol(row, "classification"),
        created_by: scol(row, "created_by"),
        parent_conversation_id: scol_opt(row, "parent_conversation_id"),
        task_id: scol_opt(row, "task_id"),
        members,
        created_at: scol(row, "created_at"),
    }
}

impl Domain {
    pub async fn is_member(&self, conn: &mut SqliteConnection, conversation_id: &str, principal_id: &str) -> Result<bool, Error> {
        let v: Option<i64> = sqlx::query_scalar("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND principal_id = ?")
            .bind(conversation_id)
            .bind(principal_id)
            .fetch_optional(conn)
            .await
            .db()?;
        Ok(v.is_some())
    }

    pub(crate) async fn add_member(&self, conn: &mut SqliteConnection, conversation_id: &str, principal_id: &str, role: &str) -> Result<(), Error> {
        sqlx::query("INSERT OR IGNORE INTO conversation_members(conversation_id, principal_id, role, joined_at) VALUES (?, ?, ?, ?)")
            .bind(conversation_id)
            .bind(principal_id)
            .bind(role)
            .bind(self.now_ts())
            .execute(conn)
            .await
            .db()?;
        Ok(())
    }

    async fn resolve_member(&self, conn: &mut SqliteConnection, m: &MemberRef) -> Result<crate::auth::PrincipalView, Error> {
        self.principal_by_label(conn, m.kind, &m.id)
            .await?
            .filter(|p| p.status == "active")
            .ok_or_else(|| Error::invalid(format!("unknown principal {}:{}", kind_str(m.kind), m.id)))
    }

    pub(crate) async fn members_of(&self, conn: &mut SqliteConnection, conversation_id: &str) -> Result<Vec<(String, MemberRef)>, Error> {
        let rows = sqlx::query("SELECT p.principal_id, p.kind, p.external_id FROM conversation_members m JOIN principals p ON p.principal_id = m.principal_id WHERE m.conversation_id = ? ORDER BY m.joined_at")
            .bind(conversation_id)
            .fetch_all(conn)
            .await
            .db()?;
        Ok(rows
            .iter()
            .map(|r| (scol(r, "principal_id"), MemberRef { kind: parse_kind(&scol(r, "kind")).unwrap_or(ActorKind::Service), id: scol(r, "external_id") }))
            .collect())
    }

    pub async fn create_conversation(&self, ctx: &Ctx, req: CreateConversation) -> Result<ConversationView, Error> {
        self.run(ctx, "conversation.create", async {
            let this = self.clone();
            let ctx2 = ctx.clone();
            self.write(move |tx| {
                Box::pin(async move {
                    let kind = req.kind.clone().unwrap_or_else(|| "room".into());
                    if !matches!(kind.as_str(), "room" | "dm") {
                        return Err(Error::invalid("conversation kind must be room or dm"));
                    }
                    let policy = this.active_policy(tx).await?;
                    let classification = req.classification.clone().unwrap_or_else(|| "internal".into());
                    if !policy.scale().is_known(&classification) {
                        return Err(Error::invalid(format!("unknown classification {classification}")));
                    }
                    this.enforce(tx, &ctx2, AuthzRequest::action(Action::MessageSend).classification(&classification).resource("conversation://new")).await?;
                    let conversation_id = req.conversation_id.clone().unwrap_or_else(ids::conversation_id);
                    let now = this.now_ts();
                    let mut members = vec![];
                    for m in &req.members {
                        members.push(this.resolve_member(tx, m).await?);
                    }
                    for member in &members {
                        if !policy.scale().permits(member.permissions.classification_limit(), &classification) {
                            return Err(Error::denied(format!("member {} is not cleared for {classification} conversations", member.id)));
                        }
                    }
                    sqlx::query("INSERT INTO conversations(conversation_id, domain_id, kind, title, classification, created_by, parent_conversation_id, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
                        .bind(&conversation_id)
                        .bind(&this.cfg.domain_id)
                        .bind(&kind)
                        .bind(&req.title)
                        .bind(&classification)
                        .bind(&ctx2.actor.principal_id)
                        .bind(&req.parent_conversation_id)
                        .bind(&now)
                        .bind(json!({"open": req.open.unwrap_or(false)}).to_string())
                        .execute(&mut **tx)
                        .await
                        .map_err(|e| match crate::db::db_error(e) {
                            err if err.code == ErrorCode::Conflict => Error::conflict("conversation id already exists"),
                            err => err,
                        })?;
                    this.add_member(tx, &conversation_id, &ctx2.actor.principal_id, "owner").await?;
                    for member in &members {
                        this.add_member(tx, &conversation_id, &member.principal_id, "member").await?;
                    }
                    this.audit(tx, &ctx2, AuditRecord::new("conversation.create", Some(format!("conversation://{conversation_id}")), "success").conversation(Some(conversation_id.clone()))).await?;
                    this.conversation_view(tx, &conversation_id).await
                })
            })
            .await
        })
        .await
    }

    pub(crate) async fn conversation_view(&self, conn: &mut SqliteConnection, conversation_id: &str) -> Result<ConversationView, Error> {
        let row = sqlx::query("SELECT * FROM conversations WHERE conversation_id = ?")
            .bind(conversation_id)
            .fetch_optional(&mut *conn)
            .await
            .db()?
            .ok_or_else(|| Error::not_found("conversation"))?;
        let members = self.members_of(conn, conversation_id).await?.into_iter().map(|(_, m)| m).collect();
        Ok(conversation_from_row(&row, members))
    }

    pub async fn get_conversation(&self, ctx: &Ctx, conversation_id: &str) -> Result<ConversationView, Error> {
        let mut conn = self.db.pool().acquire().await.db()?;
        if !self.is_member(&mut conn, conversation_id, &ctx.actor.principal_id).await? && !ctx.actor.permissions.allows_action("message.read.any") {
            return Err(Error::not_found("conversation"));
        }
        self.conversation_view(&mut conn, conversation_id).await
    }

    pub async fn add_conversation_member(&self, ctx: &Ctx, conversation_id: &str, member: MemberRef) -> Result<ConversationView, Error> {
        self.run(ctx, "conversation.add_member", async {
            let this = self.clone();
            let ctx2 = ctx.clone();
            let conversation_id = conversation_id.to_string();
            self.write(move |tx| {
                Box::pin(async move {
                    if !this.is_member(tx, &conversation_id, &ctx2.actor.principal_id).await? {
                        return Err(Error::not_found("conversation"));
                    }
                    let row = sqlx::query("SELECT classification FROM conversations WHERE conversation_id = ?")
                        .bind(&conversation_id)
                        .fetch_one(&mut **tx)
                        .await
                        .db()?;
                    let classification = scol(&row, "classification");
                    this.enforce(
                        tx,
                        &ctx2,
                        AuthzRequest::action(Action::MessageSend).classification(&classification).resource(format!("conversation://{conversation_id}")),
                    )
                    .await?;
                    let principal = this.resolve_member(tx, &member).await?;
                    let policy = this.active_policy(tx).await?;
                    if !policy.scale().permits(principal.permissions.classification_limit(), &classification) {
                        return Err(Error::denied(format!("{} is not cleared for {classification} conversations", principal.id)));
                    }
                    this.add_member(tx, &conversation_id, &principal.principal_id, "member").await?;
                    this.audit(
                        tx,
                        &ctx2,
                        AuditRecord::new("conversation.add_member", Some(format!("conversation://{conversation_id}")), "success")
                            .conversation(Some(conversation_id.clone()))
                            .detail(json!({"member": member.id})),
                    )
                    .await?;
                    this.conversation_view(tx, &conversation_id).await
                })
            })
            .await
        })
        .await
    }

    pub(crate) async fn dm_conversation_pub(&self, conn: &mut SqliteConnection, ctx: &Ctx, other: &crate::auth::PrincipalView) -> Result<String, Error> {
        self.dm_conversation(conn, ctx, other).await
    }

    /// Deterministic direct-message conversation for a set of two principals.
    async fn dm_conversation(&self, conn: &mut SqliteConnection, ctx: &Ctx, other: &crate::auth::PrincipalView) -> Result<String, Error> {
        let mut pair = [ctx.actor.principal_id.clone(), other.principal_id.clone()];
        pair.sort();
        let dm_key = format!("{}|{}", pair[0], pair[1]);
        if let Some(id) = sqlx::query_scalar::<_, String>("SELECT conversation_id FROM conversations WHERE domain_id = ? AND dm_key = ?")
            .bind(&self.cfg.domain_id)
            .bind(&dm_key)
            .fetch_optional(&mut *conn)
            .await
            .db()?
        {
            return Ok(id);
        }
        let conversation_id = ids::conversation_id();
        sqlx::query("INSERT INTO conversations(conversation_id, domain_id, kind, title, classification, created_by, dm_key, created_at) VALUES (?, ?, 'dm', NULL, 'internal', ?, ?, ?)")
            .bind(&conversation_id)
            .bind(&self.cfg.domain_id)
            .bind(&ctx.actor.principal_id)
            .bind(&dm_key)
            .bind(self.now_ts())
            .execute(&mut *conn)
            .await
            .db()?;
        self.add_member(conn, &conversation_id, &ctx.actor.principal_id, "member").await?;
        self.add_member(conn, &conversation_id, &other.principal_id, "member").await?;
        Ok(conversation_id)
    }

    /// `POST /v1/messages`
    pub async fn send_message(&self, ctx: &Ctx, req: SendMessage) -> Result<MessageRecord, Error> {
        self.run(ctx, "message.send", async {
            let kind = req.kind.unwrap_or(MessageType::ChatMessage);
            let rules = taxonomy::rules(kind);
            if !rules.client_sendable {
                return Err(Error::invalid(format!("{} messages are emitted by the platform and cannot be sent directly", taxonomy::type_name(kind))));
            }
            let content = req.content.clone().ok_or_else(|| Error::invalid("content is required"))?;
            let size = self.check_inline_size(&content.data, "message content")?;
            let _ = size;
            if let Some(sender) = &req.sender
                && (sender.kind != ctx.actor.kind || sender.id != ctx.actor.id || sender.domain_id != ctx.actor.domain_id) {
                    return Err(Error::new(ErrorCode::SenderMismatch, "sender does not match the authenticated principal; identity is derived from credentials"));
                }
            if let Some(expires) = &req.expires_at {
                somework_core::clock::parse_ts(expires).ok_or_else(|| Error::invalid("expiresAt must be an RFC 3339 timestamp"))?;
            }
            let mut idem_ctx = ctx.clone();
            if idem_ctx.idempotency_key.is_none() {
                idem_ctx.idempotency_key = req.idempotency_key.clone();
            }
            let request_json = serde_json::to_value(&req)?;
            let this = self.clone();
            self.write(move |tx| {
                Box::pin(async move {
                    let ctx = idem_ctx;
                    let slot = match this.idem_begin::<MessageRecord>(tx, &ctx, "message.send", &request_json).await? {
                        crate::idempotency::Idem::Replay(v) => return Ok(v),
                        crate::idempotency::Idem::Fresh(slot) => slot,
                    };
                    if let Some(message_id) = &req.message_id
                        && let Some(existing) = this.message_by_id(tx, message_id).await? {
                            let same_sender = existing.envelope.sender.id == ctx.actor.id && existing.envelope.sender.kind == ctx.actor.kind;
                            if same_sender && digest_json(&serde_json::to_value(&existing.envelope.content)?) == digest_json(&serde_json::to_value(&content)?) {
                                return Ok(existing);
                            }
                            return Err(Error::new(ErrorCode::IdempotencyConflict, "messageId already exists with different content"));
                        }
                    if let Some(key) = &req.idempotency_key {
                        let existing: Option<String> = sqlx::query_scalar("SELECT message_id FROM messages WHERE domain_id = ? AND idempotency_key = ?").bind(&this.cfg.domain_id).bind(key).fetch_optional(&mut **tx).await.db()?;
                        if let Some(id) = existing {
                            let m = this.message_by_id(tx, &id).await?.ok_or_else(|| Error::internal("idempotent message vanished"))?;
                            if m.envelope.sender.id == ctx.actor.id {
                                return Ok(m);
                            }
                            return Err(Error::new(ErrorCode::IdempotencyConflict, "idempotency key already used"));
                        }
                    }
                    let decision = this.enforce(tx, &ctx, AuthzRequest::action(Action::MessageSend)).await?;

                    // resolve recipients
                    let mut recipients = Vec::new();
                    for r in &req.recipients {
                        let p = this.resolve_member(tx, r).await?;
                        if p.principal_id != ctx.actor.principal_id {
                            recipients.push(p);
                        }
                    }
                    let conversation_id = match &req.conversation_id {
                        Some(id) => {
                            if !this.is_member(tx, id, &ctx.actor.principal_id).await? {
                                return Err(Error::denied("sender is not a member of the conversation"));
                            }
                            id.clone()
                        }
                        None => match recipients.as_slice() {
                            [one] => this.dm_conversation(tx, &ctx, one).await?,
                            [] => return Err(Error::invalid("either conversationId or at least one recipient is required")),
                            _ => return Err(Error::invalid("conversationId is required for messages to several recipients")),
                        },
                    };
                    let conv = this.conversation_view(tx, &conversation_id).await?;
                    let policy = this.active_policy(tx).await?;
                    for r in &recipients {
                        if !policy.scale().permits(r.permissions.classification_limit(), &conv.classification) {
                            return Err(Error::denied(format!("recipient {} is not cleared for {} conversations", r.id, conv.classification)));
                        }
                    }
                    if let Some(task_id) = &req.task_id {
                        this.require_task_participant(tx, &ctx, task_id).await?;
                    }

                    let members = this.members_of(tx, &conversation_id).await?;
                    let envelope_recipients: Vec<crate::auth::PrincipalView> = if recipients.is_empty() {
                        let mut v = Vec::new();
                        for (pid, _) in members.iter().filter(|(pid, _)| *pid != ctx.actor.principal_id) {
                            if let Some(p) = this.principal_by_id(tx, pid).await? {
                                v.push(p);
                            }
                        }
                        v
                    } else {
                        recipients.clone()
                    };
                    // a conversation of one (e.g. an imported channel) addresses the sender; such messages never wake anyone
                    let envelope_recipients = if envelope_recipients.is_empty() {
                        vec![this.principal_by_id(tx, &ctx.actor.principal_id).await?.ok_or_else(|| Error::internal("sender principal vanished"))?]
                    } else {
                        envelope_recipients
                    };
                    // Trigger semantics: an explicit mode must be allowed for the type; otherwise default by type and by
                    // whether the sender named specific recipients (mention gating).
                    let trigger = match req.trigger_mode {
                        Some(t) => {
                            if !rules.allowed_triggers.contains(&t) {
                                return Err(Error::new(
                                    ErrorCode::TriggerNotAllowed,
                                    format!("{} messages may not use trigger mode {}", taxonomy::type_name(kind), t.as_str()),
                                ));
                            }
                            t
                        }
                        None if kind == MessageType::ChatMessage && recipients.is_empty() => TriggerMode::Never,
                        None => rules.default_trigger,
                    };
                    let mut effective_trigger = trigger;
                    let mut hop_depth = 0i64;
                    if let Some(cause) = &req.causation_id {
                        let depth: Option<i64> = sqlx::query_scalar("SELECT hop_depth FROM messages WHERE message_id = ?").bind(cause).fetch_optional(&mut **tx).await.db()?;
                        hop_depth = depth.map(|d| d + 1).unwrap_or(0);
                    }
                    let mut loop_guarded = false;
                    if ctx.actor.kind == ActorKind::Agent && hop_depth as u32 > this.cfg.max_agent_hops && effective_trigger != TriggerMode::Never {
                        effective_trigger = TriggerMode::Never;
                        loop_guarded = true;
                    }

                    let message_id = req.message_id.clone().unwrap_or_else(ids::message_id);
                    let now = this.now_ts();
                    let envelope = MessageEnvelope {
                        schema_version: SCHEMA_VERSION.into(),
                        message_id: message_id.clone(),
                        kind,
                        sender: ctx.actor.actor_ref(),
                        recipients: envelope_recipients.iter().map(|p| ActorRef { kind: p.kind, id: p.id.clone(), domain_id: this.cfg.domain_id.clone(), display_name: p.display_name.clone() }).collect(),
                        domain_id: this.cfg.domain_id.clone(),
                        conversation_id: Some(conversation_id.clone()),
                        task_id: req.task_id.clone(),
                        correlation_id: req.correlation_id.clone(),
                        causation_id: req.causation_id.clone(),
                        reply_to: req.reply_to.clone(),
                        created_at: now.clone(),
                        expires_at: req.expires_at.clone(),
                        priority: req.priority,
                        trigger_mode: effective_trigger,
                        content: content.clone(),
                        artifacts: req.artifacts.clone(),
                        context_refs: req.context_refs.clone(),
                        authorization_token_id: ctx.actor.grant_jti.clone(),
                        labels: req.labels.clone(),
                        traceparent: Some(ctx.trace.traceparent()),
                        idempotency_key: req.idempotency_key.clone().or_else(|| ctx.idempotency_key.clone()),
                    };
                    let record = this.insert_message(tx, &ctx, &envelope, &envelope_recipients, !recipients.is_empty(), hop_depth, &members).await?;
                    this.audit(
                        tx,
                        &ctx,
                        AuditRecord::new("message.send", Some(format!("message://{message_id}")), "success")
                            .decision(&decision)
                            .conversation(Some(conversation_id.clone()))
                            .detail(json!({"type": taxonomy::type_name(kind), "trigger": effective_trigger.as_str(), "loopGuard": loop_guarded, "contentDigest": digest_json(&content.data)})),
                    )
                    .await?;
                    this.idem_finish(tx, &ctx, slot, &record).await?;
                    Ok(record)
                })
            })
            .await
        })
        .await
    }

    /// Persists a canonical message plus deliveries and its event/outbox rows. Shared by client and platform senders.
    pub(crate) async fn insert_message(
        &self,
        conn: &mut SqliteConnection,
        ctx: &Ctx,
        envelope: &MessageEnvelope,
        recipients: &[crate::auth::PrincipalView],
        explicit_recipients: bool,
        hop_depth: i64,
        members: &[(String, MemberRef)],
    ) -> Result<MessageRecord, Error> {
        let value = serde_json::to_value(envelope)?;
        schema::validate_contract("MessageEnvelope", &value)?;
        let content_digest = digest_json(&serde_json::to_value(&envelope.content)?);
        let seq: i64 = sqlx::query_scalar(
            "INSERT INTO messages(message_id, domain_id, conversation_id, task_id, type, sender_principal_id, trigger_mode, envelope, content_digest, idempotency_key, causation_id, hop_depth, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq",
        )
        .bind(&envelope.message_id)
        .bind(&self.cfg.domain_id)
        .bind(&envelope.conversation_id)
        .bind(&envelope.task_id)
        .bind(taxonomy::type_name(envelope.kind))
        .bind(&ctx.actor.principal_id)
        .bind(envelope.trigger_mode.as_str())
        .bind(value.to_string())
        .bind(&content_digest)
        .bind(&envelope.idempotency_key)
        .bind(&envelope.causation_id)
        .bind(hop_depth)
        .bind(&envelope.created_at)
        .fetch_one(&mut *conn)
        .await
        .map_err(|e| match crate::db::db_error(e) {
            err if err.code == ErrorCode::Conflict => Error::new(ErrorCode::IdempotencyConflict, "duplicate messageId or idempotency key"),
            err => err,
        })?;

        let wake_allowed = may_wake(envelope.kind, envelope.trigger_mode);
        let mut spec = EventSpec::new(
            "message.created",
            json!({
                "messageId": envelope.message_id,
                "messageType": taxonomy::type_name(envelope.kind),
                "conversationId": envelope.conversation_id,
                "taskId": envelope.task_id,
                "sender": {"kind": kind_str(envelope.sender.kind), "id": envelope.sender.id},
                "triggerMode": envelope.trigger_mode.as_str(),
            }),
        )
        .conversation(envelope.conversation_id.clone())
        .message(&envelope.message_id)
        .matrix();
        if let Some(task_id) = &envelope.task_id {
            spec.task_id = Some(task_id.clone());
        }
        if envelope.kind == MessageType::TaskStatus
            && envelope.content.data.get("event").and_then(Value::as_str) == Some("progress")
            && let Some(task_id) = &envelope.task_id
        {
            spec = spec.coalesce(format!("task:{task_id}:progress"));
        }
        if let Some(topic) = envelope.labels.get("topic") {
            spec.topics.push(topic.clone());
        }
        let own = &ctx.actor.principal_id;
        let mut woken: Vec<&crate::auth::PrincipalView> = vec![];
        for r in recipients {
            // wake only explicitly addressed recipients, never the sender (own-origin events are ignored)
            let wake = wake_allowed && (explicit_recipients || envelope.trigger_mode == TriggerMode::Directed) && r.principal_id != *own;
            sqlx::query("INSERT OR IGNORE INTO message_deliveries(message_id, principal_id, wake, delivered_at) VALUES (?, ?, ?, ?)")
                .bind(&envelope.message_id)
                .bind(&r.principal_id)
                .bind(wake as i64)
                .bind(&envelope.created_at)
                .execute(&mut *conn)
                .await
                .db()?;
            spec = spec.recipient(r.principal_id.clone(), wake);
            if wake {
                woken.push(r);
            }
        }
        for (pid, _) in members {
            if pid != own && !recipients.iter().any(|r| &r.principal_id == pid) {
                sqlx::query("INSERT OR IGNORE INTO message_deliveries(message_id, principal_id, wake, delivered_at) VALUES (?, ?, 0, ?)")
                    .bind(&envelope.message_id)
                    .bind(pid)
                    .bind(&envelope.created_at)
                    .execute(&mut *conn)
                    .await
                    .db()?;
                spec = spec.recipient(pid.clone(), false);
            }
        }
        spec = spec.recipient(own.clone(), false);
        if let Some(conv) = &envelope.conversation_id {
            spec = spec.nats(
                subjects::event_conversation(conv),
                json!({"messageId": envelope.message_id, "conversationId": conv, "messageType": taxonomy::type_name(envelope.kind)}),
            );
        }
        if !matches!(envelope.kind, MessageType::StreamChunk | MessageType::PresenceChanged) {
            for r in recipients.iter().filter(|r| r.kind == ActorKind::Agent) {
                let wake = woken.iter().any(|w| w.principal_id == r.principal_id);
                spec = spec.nats(
                    subjects::inbox(&r.id),
                    json!({
                        "kind": "message",
                        "messageId": envelope.message_id,
                        "messageType": taxonomy::type_name(envelope.kind),
                        "conversationId": envelope.conversation_id,
                        "taskId": envelope.task_id,
                        "wake": wake,
                        "sender": envelope.sender.id,
                    }),
                );
            }
        }
        self.emit(conn, ctx, spec).await?;
        Ok(MessageRecord { seq, envelope: envelope.clone() })
    }

    /// Posts a platform-emitted message (task status/result, context offers, approvals...).
    pub(crate) async fn post_system_message(&self, conn: &mut SqliteConnection, ctx: &Ctx, msg: SystemMessage) -> Result<Option<MessageRecord>, Error> {
        let Some(conversation_id) = msg.conversation_id.clone() else { return Ok(None) };
        let rules = taxonomy::rules(msg.kind);
        let trigger = msg.trigger.unwrap_or(rules.default_trigger);
        if !rules.allowed_triggers.contains(&trigger) {
            return Err(Error::internal(format!("platform attempted forbidden trigger {} for {}", trigger.as_str(), taxonomy::type_name(msg.kind))));
        }
        let mut principals = Vec::new();
        for (actor, _) in &msg.recipients {
            if let Some(p) = self.principal_by_label(conn, actor.kind, &actor.id).await? {
                principals.push(p);
            }
        }
        let members = self.members_of(conn, &conversation_id).await?;
        if principals.is_empty() {
            for (pid, _) in members.iter().filter(|(pid, _)| *pid != ctx.actor.principal_id) {
                if let Some(p) = self.principal_by_id(conn, pid).await? {
                    principals.push(p);
                }
            }
        }
        let recipients: Vec<ActorRef> = principals
            .iter()
            .map(|p| ActorRef { kind: p.kind, id: p.id.clone(), domain_id: self.cfg.domain_id.clone(), display_name: p.display_name.clone() })
            .collect();
        let recipients = if recipients.is_empty() { vec![ctx.actor.actor_ref()] } else { recipients };
        let envelope = MessageEnvelope {
            schema_version: SCHEMA_VERSION.into(),
            message_id: ids::message_id(),
            kind: msg.kind,
            sender: ctx.actor.actor_ref(),
            recipients,
            domain_id: self.cfg.domain_id.clone(),
            conversation_id: Some(conversation_id),
            task_id: msg.task_id,
            correlation_id: None,
            causation_id: msg.causation_id,
            reply_to: None,
            created_at: self.now_ts(),
            expires_at: None,
            priority: None,
            trigger_mode: trigger,
            content: MessageContent { media_type: msg.media_type.into(), data: msg.content },
            artifacts: msg.artifacts,
            context_refs: msg.context_refs,
            authorization_token_id: None,
            labels: BTreeMap::new(),
            traceparent: Some(ctx.trace.traceparent()),
            idempotency_key: None,
        };
        let principals_for_delivery = if principals.is_empty() { vec![] } else { principals };
        let record = self.insert_message(conn, ctx, &envelope, &principals_for_delivery, true, 0, &members).await?;
        Ok(Some(record))
    }

    pub(crate) async fn message_by_id(&self, conn: &mut SqliteConnection, message_id: &str) -> Result<Option<MessageRecord>, Error> {
        let row = sqlx::query("SELECT seq, envelope FROM messages WHERE message_id = ?").bind(message_id).fetch_optional(conn).await.db()?;
        row.map(|r| Ok(MessageRecord { seq: icol(&r, "seq"), envelope: serde_json::from_value(jcol(&r, "envelope"))? })).transpose()
    }

    pub async fn get_message(&self, ctx: &Ctx, message_id: &str) -> Result<MessageRecord, Error> {
        self.enforce_read(ctx, AuthzRequest::action(Action::MessageRead).resource(format!("message://{message_id}"))).await?;
        let mut conn = self.db.pool().acquire().await.db()?;
        let m = self.message_by_id(&mut conn, message_id).await?.ok_or_else(|| Error::not_found("message"))?;
        if !self.can_read_message(&mut conn, ctx, &m).await? {
            return Err(Error::not_found("message"));
        }
        Ok(m)
    }

    async fn can_read_message(&self, conn: &mut SqliteConnection, ctx: &Ctx, m: &MessageRecord) -> Result<bool, Error> {
        if ctx.actor.permissions.allows_action("message.read.any") {
            return Ok(true);
        }
        if let Some(conv) = &m.envelope.conversation_id {
            return self.is_member(conn, conv, &ctx.actor.principal_id).await;
        }
        Ok(m.envelope.sender.id == ctx.actor.id || m.envelope.recipients.iter().any(|r| r.id == ctx.actor.id))
    }

    /// `GET /v1/conversations/{id}/messages` (cursor based).
    pub async fn list_messages(&self, ctx: &Ctx, conversation_id: &str, after: i64, limit: i64) -> Result<MessagePage, Error> {
        self.enforce_read(ctx, AuthzRequest::action(Action::MessageRead).resource(format!("conversation://{conversation_id}"))).await?;
        let mut conn = self.db.pool().acquire().await.db()?;
        if !self.is_member(&mut conn, conversation_id, &ctx.actor.principal_id).await? && !ctx.actor.permissions.allows_action("message.read.any") {
            return Err(Error::not_found("conversation"));
        }
        let limit = limit.clamp(1, 200);
        let rows = sqlx::query("SELECT seq, envelope FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?")
            .bind(conversation_id)
            .bind(after)
            .bind(limit)
            .fetch_all(&mut *conn)
            .await
            .db()?;
        let mut messages = Vec::new();
        for r in &rows {
            messages.push(MessageRecord { seq: icol(r, "seq"), envelope: serde_json::from_value(jcol(r, "envelope"))? });
        }
        let next = if rows.len() as i64 == limit { messages.last().map(|m| m.seq) } else { None };
        if !ctx.actor.permissions.allows_action("message.read.any") || self.is_member(&mut conn, conversation_id, &ctx.actor.principal_id).await? {
            let now = self.now_ts();
            sqlx::query("UPDATE message_deliveries SET read_at = COALESCE(read_at, ?) WHERE principal_id = ? AND message_id IN (SELECT message_id FROM messages WHERE conversation_id = ? AND seq > ? AND seq <= ?)")
                .bind(now)
                .bind(&ctx.actor.principal_id)
                .bind(conversation_id)
                .bind(after)
                .bind(messages.last().map(|m| m.seq).unwrap_or(after))
                .execute(&mut *conn)
                .await
                .db()?;
        }
        Ok(MessagePage { messages, next_cursor: next })
    }

    /// Unread/delivery projection for a principal (inbox with read receipts).
    pub async fn inbox(&self, ctx: &Ctx, only_unread: bool, limit: i64) -> Result<Vec<MessageRecord>, Error> {
        self.enforce_read(ctx, AuthzRequest::action(Action::MessageRead)).await?;
        let rows = sqlx::query("SELECT m.seq, m.envelope FROM message_deliveries d JOIN messages m ON m.message_id = d.message_id WHERE d.principal_id = ? AND (? = 0 OR d.read_at IS NULL) ORDER BY m.seq ASC LIMIT ?")
            .bind(&ctx.actor.principal_id)
            .bind(only_unread as i64)
            .bind(limit.clamp(1, 500))
            .fetch_all(self.db.pool())
            .await
            .db()?;
        rows.iter().map(|r| Ok(MessageRecord { seq: icol(r, "seq"), envelope: serde_json::from_value(jcol(r, "envelope"))? })).collect()
    }

    pub async fn mark_messages_read(&self, ctx: &Ctx, message_ids: &[String]) -> Result<u64, Error> {
        let mut n = 0;
        for id in message_ids {
            let res = sqlx::query("UPDATE message_deliveries SET read_at = COALESCE(read_at, ?) WHERE message_id = ? AND principal_id = ?")
                .bind(self.now_ts())
                .bind(id)
                .bind(&ctx.actor.principal_id)
                .execute(self.db.writer())
                .await
                .db()?;
            n += res.rows_affected();
        }
        Ok(n)
    }

    /// Operator/audit view of a conversation. Plaintext is only shown when the domain policy allows it (AUD-03).
    pub async fn audit_messages(&self, ctx: &Ctx, conversation_id: Option<&str>, task_id: Option<&str>, limit: i64) -> Result<Vec<MessageRecord>, Error> {
        self.enforce_read(ctx, AuthzRequest::new("audit.read")).await?;
        let mut conn = self.db.pool().acquire().await.db()?;
        let policy = self.active_policy(&mut conn).await?;
        let rows = sqlx::query("SELECT seq, envelope, content_digest FROM messages WHERE (? IS NULL OR conversation_id = ?) AND (? IS NULL OR task_id = ?) ORDER BY seq ASC LIMIT ?")
            .bind(conversation_id)
            .bind(conversation_id)
            .bind(task_id)
            .bind(task_id)
            .bind(limit.clamp(1, 1000))
            .fetch_all(&mut *conn)
            .await
            .db()?;
        let mut out = Vec::new();
        for r in rows {
            let mut envelope: MessageEnvelope = serde_json::from_value(jcol(&r, "envelope"))?;
            if !policy.audit_plaintext {
                envelope.content =
                    MessageContent { media_type: envelope.content.media_type.clone(), data: json!({"redacted": true, "digest": scol(&r, "content_digest")}) };
            }
            out.push(MessageRecord { seq: icol(&r, "seq"), envelope });
        }
        Ok(out)
    }
}
