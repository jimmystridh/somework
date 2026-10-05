//! Domain events and the transactional outbox. Every durable event row, its recipients and its per-sink outbox rows
//! commit in the same transaction as the state change that caused them (TASK-01, canonical-state rule).

use serde::Serialize;
use serde_json::{Value, json};
use somework_core::{Error, canonical::sha256_hex, clock::ts, ids, subjects};
use sqlx::{Row, SqliteConnection};

use crate::{
    config::{SINK_GATEWAY, SINK_MATRIX, SINK_NATS},
    db::{DbResultExt, icol, jcol, scol, scol_opt},
    domain::{Ctx, Domain},
    policy::{AuthzRequest, Decision},
};

#[derive(Debug, Clone)]
pub struct NatsRoute {
    pub subject: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Default)]
pub struct EventSpec {
    pub kind: String,
    pub task_id: Option<String>,
    pub conversation_id: Option<String>,
    pub message_id: Option<String>,
    pub revision: Option<i64>,
    /// Reference-only payload: ids, state and revision, never message bodies or task inputs.
    pub payload: Value,
    /// (principal id, may-wake) pairs that can see this event through `GET /v1/events`.
    pub recipients: Vec<(String, bool)>,
    pub nats: Vec<NatsRoute>,
    pub matrix: bool,
    pub matrix_coalesce_key: Option<String>,
    pub gateway: Vec<NatsRoute>,
    /// Topics for `topic` subscriptions (event kind is always included).
    pub topics: Vec<String>,
    pub capability_id: Option<String>,
}

impl EventSpec {
    pub fn new(kind: &str, payload: Value) -> Self {
        Self { kind: kind.into(), payload, ..Default::default() }
    }
    pub fn task(mut self, task_id: &str, revision: i64) -> Self {
        self.task_id = Some(task_id.into());
        self.revision = Some(revision);
        self
    }
    pub fn conversation(mut self, id: Option<String>) -> Self {
        self.conversation_id = id;
        self
    }
    pub fn message(mut self, id: &str) -> Self {
        self.message_id = Some(id.into());
        self
    }
    pub fn recipient(mut self, principal_id: impl Into<String>, wake: bool) -> Self {
        let principal_id = principal_id.into();
        if let Some(existing) = self.recipients.iter_mut().find(|(p, _)| *p == principal_id) {
            existing.1 |= wake;
        } else {
            self.recipients.push((principal_id, wake));
        }
        self
    }
    pub fn nats(mut self, subject: String, payload: Value) -> Self {
        self.nats.push(NatsRoute { subject, payload });
        self
    }
    pub fn matrix(mut self) -> Self {
        self.matrix = true;
        self
    }
    pub fn coalesce(mut self, key: String) -> Self {
        self.matrix_coalesce_key = Some(key);
        self
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmittedEvent {
    pub seq: i64,
    pub event_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventView {
    pub seq: i64,
    pub event_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub task_id: Option<String>,
    pub conversation_id: Option<String>,
    pub message_id: Option<String>,
    pub revision: Option<i64>,
    pub wake: bool,
    pub payload: Value,
    pub created_at: String,
}

impl Domain {
    pub async fn emit(&self, conn: &mut SqliteConnection, ctx: &Ctx, mut spec: EventSpec) -> Result<EmittedEvent, Error> {
        let event_id = ids::event_id();
        let created_at = self.now_ts();
        let mut payload = spec.payload.clone();
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("eventId".into(), json!(event_id));
            obj.insert("type".into(), json!(spec.kind));
            obj.insert("traceparent".into(), json!(ctx.trace.traceparent()));
        }
        let first_subject = spec.nats.first().map(|r| r.subject.clone());
        let seq: i64 = sqlx::query_scalar(
            "INSERT INTO events(event_id, domain_id, type, task_id, conversation_id, message_id, revision, subject, payload, traceparent, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq",
        )
        .bind(&event_id)
        .bind(&self.cfg.domain_id)
        .bind(&spec.kind)
        .bind(&spec.task_id)
        .bind(&spec.conversation_id)
        .bind(&spec.message_id)
        .bind(spec.revision)
        .bind(&first_subject)
        .bind(payload.to_string())
        .bind(ctx.trace.traceparent())
        .bind(&created_at)
        .fetch_one(&mut *conn)
        .await
        .db()?;

        self.match_subscriptions(conn, &mut spec, &payload).await?;

        for (principal_id, wake) in &spec.recipients {
            sqlx::query("INSERT INTO event_recipients(event_seq, principal_id, wake) VALUES (?, ?, ?) ON CONFLICT(event_seq, principal_id) DO UPDATE SET wake = MAX(wake, excluded.wake)")
                .bind(seq)
                .bind(principal_id)
                .bind(*wake as i64)
                .execute(&mut *conn)
                .await
                .db()?;
        }

        let mut outbox_rows = 0;
        if self.cfg.sink_enabled(SINK_NATS) {
            for route in &spec.nats {
                let mut body = route.payload.clone();
                if let Some(obj) = body.as_object_mut() {
                    obj.entry("eventId").or_insert(json!(event_id));
                    obj.entry("traceparent").or_insert(json!(ctx.trace.traceparent()));
                }
                self.insert_outbox(conn, seq, SINK_NATS, &route.subject, &format!("{event_id}:{}", route.subject), None, &body).await?;
                outbox_rows += 1;
            }
        }
        if self.cfg.sink_enabled(SINK_MATRIX) && spec.matrix {
            let subject = spec.conversation_id.clone().or(spec.task_id.clone()).unwrap_or_else(|| "domain".into());
            self.insert_outbox(conn, seq, SINK_MATRIX, &subject, &format!("{event_id}:matrix"), spec.matrix_coalesce_key.as_deref(), &payload).await?;
            outbox_rows += 1;
        }
        if self.cfg.sink_enabled(SINK_GATEWAY) {
            for route in &spec.gateway {
                self.insert_outbox(conn, seq, SINK_GATEWAY, &route.subject, &format!("{event_id}:{}", route.subject), None, &route.payload).await?;
                outbox_rows += 1;
            }
        }
        let _ = outbox_rows;
        Ok(EmittedEvent { seq, event_id })
    }

    #[allow(clippy::too_many_arguments)]
    async fn insert_outbox(
        &self,
        conn: &mut SqliteConnection,
        event_seq: i64,
        sink: &str,
        subject: &str,
        dedupe_key: &str,
        coalesce_key: Option<&str>,
        payload: &Value,
    ) -> Result<(), Error> {
        let now = self.now_ts();
        sqlx::query(
            "INSERT OR IGNORE INTO outbox_events(event_seq, domain_id, sink, subject, dedupe_key, coalesce_key, payload, status, attempts, next_attempt_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)",
        )
        .bind(event_seq)
        .bind(&self.cfg.domain_id)
        .bind(sink)
        .bind(subject)
        .bind(dedupe_key)
        .bind(coalesce_key)
        .bind(payload.to_string())
        .bind(&now)
        .bind(&now)
        .execute(conn)
        .await
        .db()?;
        Ok(())
    }

    /// Fan an event out to matching durable subscriptions (SUB-01/02). The `wake` flag is the subscriber's explicit
    /// choice; loop protection on top of that is enforced by the message taxonomy for message events.
    async fn match_subscriptions(&self, conn: &mut SqliteConnection, spec: &mut EventSpec, payload: &Value) -> Result<(), Error> {
        let rows = sqlx::query("SELECT subscription_id, principal_id, kind, selector, wake FROM subscriptions WHERE domain_id = ? AND status = 'active'")
            .bind(&self.cfg.domain_id)
            .fetch_all(&mut *conn)
            .await
            .db()?;
        for row in rows {
            let kind = scol(&row, "kind");
            let selector = scol(&row, "selector");
            let hit = match kind.as_str() {
                "topic" => std::iter::once(&spec.kind).chain(spec.topics.iter()).any(|t| somework_core::classification::glob_match(&selector, t)),
                "capability_queue" => {
                    spec.kind == "task.queued" && spec.capability_id.as_deref().is_some_and(|c| somework_core::classification::glob_match(&selector, c))
                }
                "conversation" => spec.conversation_id.as_deref() == Some(selector.as_str()),
                "task" => spec.task_id.as_deref() == Some(selector.as_str()),
                _ => false,
            };
            if !hit {
                continue;
            }
            let owner = scol(&row, "principal_id");
            if matches!(kind.as_str(), "task" | "conversation") && !self.can_observe(conn, &owner, spec).await? {
                continue;
            }
            let wake = icol(&row, "wake") != 0;
            let sub_id = scol(&row, "subscription_id");
            let mut body = payload.clone();
            if let Some(obj) = body.as_object_mut() {
                obj.insert("subscriptionId".into(), json!(sub_id));
                obj.insert("wake".into(), json!(wake));
            }
            spec.nats.push(NatsRoute { subject: subjects::subscription(&sub_id), payload: body });
            if let Some(existing) = spec.recipients.iter_mut().find(|(p, _)| *p == owner) {
                existing.1 |= wake;
            } else {
                spec.recipients.push((owner, wake));
            }
        }
        Ok(())
    }

    /// Whether `principal_id` may still observe the task/conversation of `spec` (re-checked at match time).
    async fn can_observe(&self, conn: &mut SqliteConnection, principal_id: &str, spec: &EventSpec) -> Result<bool, Error> {
        if let Some(task_id) = &spec.task_id {
            let row = sqlx::query("SELECT requester_principal_id, assignee_principal_id, target_agent_id FROM tasks WHERE task_id = ?")
                .bind(task_id)
                .fetch_optional(&mut *conn)
                .await
                .db()?;
            if let Some(row) = row
                && (scol(&row, "requester_principal_id") == principal_id || scol_opt(&row, "assignee_principal_id").as_deref() == Some(principal_id))
            {
                return Ok(true);
            }
        }
        if let Some(conversation_id) = &spec.conversation_id {
            let member: Option<i64> = sqlx::query_scalar("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND principal_id = ?")
                .bind(conversation_id)
                .bind(principal_id)
                .fetch_optional(&mut *conn)
                .await
                .db()?;
            return Ok(member.is_some());
        }
        Ok(false)
    }

    pub async fn emit_policy_denied(&self, conn: &mut SqliteConnection, ctx: &Ctx, decision: &Decision, req: &AuthzRequest) -> Result<(), Error> {
        let payload = json!({
            "decisionId": decision.decision_id,
            "action": req.action,
            "resource": req.resource,
            "taskId": req.task_id,
            "actor": ctx.actor.label(),
            "reasons": decision.reasons,
        });
        let spec = EventSpec::new("policy.denied", payload.clone())
            .nats(subjects::EVENT_POLICY_DENIED.to_string(), payload)
            .recipient(ctx.actor.principal_id.clone(), false);
        self.emit(conn, ctx, spec).await?;
        Ok(())
    }

    /// `GET /v1/events`: events addressed to the caller after `cursor`, oldest first.
    pub async fn list_events(&self, ctx: &Ctx, after: i64, limit: i64) -> Result<Vec<EventView>, Error> {
        let rows = sqlx::query(
            "SELECT e.seq, e.event_id, e.type, e.task_id, e.conversation_id, e.message_id, e.revision, e.payload, e.created_at, r.wake
             FROM event_recipients r JOIN events e ON e.seq = r.event_seq
             WHERE r.principal_id = ? AND e.seq > ? ORDER BY e.seq ASC LIMIT ?",
        )
        .bind(&ctx.actor.principal_id)
        .bind(after)
        .bind(limit.clamp(1, 500))
        .fetch_all(self.db.pool())
        .await
        .db()?;
        Ok(rows
            .iter()
            .map(|r| EventView {
                seq: icol(r, "seq"),
                event_id: scol(r, "event_id"),
                kind: scol(r, "type"),
                task_id: scol_opt(r, "task_id"),
                conversation_id: scol_opt(r, "conversation_id"),
                message_id: scol_opt(r, "message_id"),
                revision: r.try_get::<Option<i64>, _>("revision").ok().flatten(),
                wake: icol(r, "wake") != 0,
                payload: jcol(r, "payload"),
                created_at: scol(r, "created_at"),
            })
            .collect())
    }

    /// Long-poll variant: waits up to `wait` for new events.
    pub async fn watch_events(&self, ctx: &Ctx, after: i64, limit: i64, wait: std::time::Duration) -> Result<Vec<EventView>, Error> {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let notified = self.event_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let events = self.list_events(ctx, after, limit).await?;
            if !events.is_empty() || tokio::time::Instant::now() >= deadline {
                return Ok(events);
            }
            let remaining = deadline - tokio::time::Instant::now();
            let _ = tokio::time::timeout(remaining.min(std::time::Duration::from_millis(250)), notified).await;
        }
    }

    pub async fn ack_events(&self, ctx: &Ctx, cursor: i64) -> Result<(), Error> {
        let now = self.now_ts();
        sqlx::query("INSERT INTO event_cursors(principal_id, cursor, updated_at) VALUES (?, ?, ?) ON CONFLICT(principal_id) DO UPDATE SET cursor = MAX(cursor, excluded.cursor), updated_at = excluded.updated_at")
            .bind(&ctx.actor.principal_id)
            .bind(cursor)
            .bind(now)
            .execute(self.db.writer())
            .await
            .db()?;
        Ok(())
    }

    pub async fn event_cursor(&self, ctx: &Ctx) -> Result<i64, Error> {
        let c: Option<i64> = sqlx::query_scalar("SELECT cursor FROM event_cursors WHERE principal_id = ?")
            .bind(&ctx.actor.principal_id)
            .fetch_optional(self.db.pool())
            .await
            .db()?;
        Ok(c.unwrap_or(0))
    }

    /// Operator view: every event (no recipient filter) for the introspection UI.
    pub async fn list_all_events(&self, ctx: &Ctx, task_id: Option<&str>, after: i64, limit: i64) -> Result<Vec<EventView>, Error> {
        self.enforce_read(ctx, AuthzRequest::new("ops.read")).await?;
        let rows = sqlx::query("SELECT seq, event_id, type, task_id, conversation_id, message_id, revision, payload, created_at FROM events WHERE seq > ? AND (? IS NULL OR task_id = ?) ORDER BY seq ASC LIMIT ?")
            .bind(after)
            .bind(task_id)
            .bind(task_id)
            .bind(limit.clamp(1, 1000))
            .fetch_all(self.db.pool())
            .await
            .db()?;
        Ok(rows
            .iter()
            .map(|r| EventView {
                seq: icol(r, "seq"),
                event_id: scol(r, "event_id"),
                kind: scol(r, "type"),
                task_id: scol_opt(r, "task_id"),
                conversation_id: scol_opt(r, "conversation_id"),
                message_id: scol_opt(r, "message_id"),
                revision: r.try_get::<Option<i64>, _>("revision").ok().flatten(),
                wake: false,
                payload: jcol(r, "payload"),
                created_at: scol(r, "created_at"),
            })
            .collect())
    }
}

pub fn digest_of(value: &Value) -> String {
    sha256_hex(value.to_string().as_bytes())
}

pub fn ts_now_placeholder() -> String {
    ts(chrono::Utc::now())
}
