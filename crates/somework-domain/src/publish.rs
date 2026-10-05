//! Producer-facing event publication. Events that originate outside the domain (clock ticks, webhooks, alerts) are
//! published by `service` principals that hold an explicit `events.publish:<topic glob>` grant. The stored event's type
//! is the topic itself, so subscription selectors and rules glob over it directly.

use std::sync::OnceLock;

use chrono::Duration;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use somework_core::{Error, ErrorCode, clock::parse_ts, ids, subjects};

use crate::{
    audit::AuditRecord,
    db::{DbResultExt, icol, scol},
    domain::{Ctx, Domain},
    events::EventSpec,
    policy::{AuthzRequest, Decision},
};

pub const EVENT_KEY_RETENTION_DAYS: i64 = 30;
pub const PUBLISHED_EVENT_RETENTION_DAYS: i64 = 30;
pub const MAX_EVENT_DATA_BYTES: usize = 64 * 1024;
const MAX_TOPIC_LENGTH: usize = 200;
const MAX_KEY_LENGTH: usize = 200;

fn topic_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^[a-z][a-z0-9_]*(\.[a-z0-9_]+){2,}$").expect("valid topic pattern"))
}

pub fn valid_topic(topic: &str) -> bool {
    topic.len() <= MAX_TOPIC_LENGTH && topic_pattern().is_match(topic)
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PublishEvent {
    pub topic: Option<String>,
    /// Stable per-producer key: publishing the same key again within the retention window is a no-op.
    pub key: Option<String>,
    /// Where the fact came from; defaults to the first segment of the topic.
    pub source: Option<String>,
    pub data: Option<Value>,
    pub classification: Option<String>,
    /// Whether the producer authenticated the origin of the fact (signature or shared secret checked).
    pub verified: Option<bool>,
    /// A task whose work led to this event (for example a pull request an agent opened); feeds loop protection.
    pub caused_by_task: Option<String>,
    pub occurred_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResponse {
    pub seq: i64,
    pub event_id: String,
    pub duplicate: bool,
}

impl Domain {
    pub async fn publish_event(&self, ctx: &Ctx, req: PublishEvent) -> Result<PublishResponse, Error> {
        let out = self.run(ctx, "event.publish", self.publish_event_inner(ctx, req)).await?;
        if out.duplicate {
            self.metrics.events_duplicate.inc();
        } else {
            self.metrics.events_published.inc();
        }
        Ok(out)
    }

    async fn publish_event_inner(&self, ctx: &Ctx, req: PublishEvent) -> Result<PublishResponse, Error> {
        let topic = req.topic.clone().filter(|t| !t.is_empty()).ok_or_else(|| Error::invalid("topic is required"))?;
        if !valid_topic(&topic) {
            return Err(Error::invalid(
                "topic must look like <source>.<object>.<change> (lowercase letters, digits and underscores, at least three dot-separated parts, at most 200 characters)",
            ));
        }
        let key = req.key.clone().filter(|k| !k.is_empty()).ok_or_else(|| Error::invalid("key is required"))?;
        if key.len() > MAX_KEY_LENGTH || key.chars().any(char::is_control) {
            return Err(Error::invalid("key must be 1-200 characters without control characters"));
        }
        let source = req.source.clone().unwrap_or_else(|| topic.split('.').next().unwrap_or_default().to_string());
        if source.is_empty() || source.len() > 64 || !source.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-') {
            return Err(Error::invalid("source must be 1-64 characters of lowercase letters, digits, '_' or '-'"));
        }
        let data = req.data.clone().unwrap_or_else(|| json!({}));
        if !data.is_object() {
            return Err(Error::invalid("data must be a JSON object"));
        }
        let size = serde_json::to_vec(&data)?.len();
        if size > MAX_EVENT_DATA_BYTES {
            return Err(Error::new(ErrorCode::PayloadTooLarge, format!("event data is {size} bytes; the limit is {MAX_EVENT_DATA_BYTES}"))
                .with_details(json!({"sizeBytes": size, "limitBytes": MAX_EVENT_DATA_BYTES})));
        }
        if let Some(at) = &req.occurred_at
            && parse_ts(at).is_none()
        {
            return Err(Error::invalid("occurredAt must be an RFC 3339 timestamp"));
        }
        let classification = req.classification.clone().unwrap_or_else(|| "internal".into());

        let this = self.clone();
        let ctx = ctx.clone();
        self.write(move |tx| {
            Box::pin(async move {
                let conn = &mut **tx;
                let policy = this.active_policy(conn).await?;
                if !policy.scale().is_known(&classification) {
                    return Err(Error::invalid(format!("classification {classification} is not a level of the active policy")));
                }
                if !ctx.actor.permissions.allows_publish(&topic) {
                    let decision = Decision {
                        decision_id: ids::decision_id(),
                        allow: false,
                        reasons: vec![format!("topic {topic} is outside the caller's events.publish grants")],
                        obligations: vec![],
                        policy_version: policy.version.clone(),
                    };
                    return Err(Error::denied(decision.reasons.join("; "))
                        .with_details(json!({"decision": decision, "action": "events.publish", "resource": format!("topic://{topic}")})));
                }
                let authz = AuthzRequest::new("events.publish").resource(format!("topic://{topic}")).classification(&classification);
                this.enforce(conn, &ctx, authz).await?;

                let cutoff = somework_core::clock::ts(this.now() - Duration::days(EVENT_KEY_RETENTION_DAYS));
                let existing = sqlx::query("SELECT event_seq, event_id, created_at FROM event_keys WHERE domain_id = ? AND principal_id = ? AND event_key = ?")
                    .bind(&this.cfg.domain_id)
                    .bind(&ctx.actor.principal_id)
                    .bind(&key)
                    .fetch_optional(&mut *conn)
                    .await
                    .db()?;
                if let Some(row) = existing {
                    if scol(&row, "created_at") >= cutoff {
                        return Ok(PublishResponse { seq: icol(&row, "event_seq"), event_id: scol(&row, "event_id"), duplicate: true });
                    }
                    sqlx::query("DELETE FROM event_keys WHERE domain_id = ? AND principal_id = ? AND event_key = ?")
                        .bind(&this.cfg.domain_id)
                        .bind(&ctx.actor.principal_id)
                        .bind(&key)
                        .execute(&mut *conn)
                        .await
                        .db()?;
                }

                let depth = match &req.caused_by_task {
                    Some(task_id) => this.reaction_depth_of_task(conn, task_id).await?.map_or(0, |d| d + 1),
                    None => 0,
                };
                let payload = json!({
                    "topic": topic,
                    "source": source,
                    "key": key,
                    "data": data,
                    "classification": classification,
                    "verified": req.verified.unwrap_or(false),
                    "depth": depth,
                    "causedByTask": req.caused_by_task,
                    "occurredAt": req.occurred_at,
                    "publishedBy": ctx.actor.label(),
                });
                let mut spec = EventSpec::new(&topic, payload.clone()).nats(subjects::event_published(&topic), payload);
                spec.exclude_principal = Some(ctx.actor.principal_id.clone());
                let emitted = this.emit(conn, &ctx, spec).await?;
                sqlx::query("INSERT INTO event_keys(domain_id, principal_id, event_key, event_seq, event_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
                    .bind(&this.cfg.domain_id)
                    .bind(&ctx.actor.principal_id)
                    .bind(&key)
                    .bind(emitted.seq)
                    .bind(&emitted.event_id)
                    .bind(this.now_ts())
                    .execute(&mut *conn)
                    .await
                    .db()?;
                this.audit(
                    conn,
                    &ctx,
                    AuditRecord::new("event.publish", Some(format!("event://{}", emitted.event_id)), "success")
                        .detail(json!({"topic": topic, "key": key, "classification": classification, "depth": depth})),
                )
                .await?;
                Ok(PublishResponse { seq: emitted.seq, event_id: emitted.event_id, duplicate: false })
            })
        })
        .await
    }

    /// Retention for the producer side: published-event rows (with their recipients, delivered outbox rows and dedupe keys),
    /// settled reaction firings and stale dedupe keys, all older than [`PUBLISHED_EVENT_RETENTION_DAYS`]. Task events, other
    /// domain events and the audit chain are never touched; a published event whose outbox rows are still undelivered is kept.
    pub(crate) async fn purge_published_events(&self) -> Result<u64, Error> {
        let cutoff = somework_core::clock::ts(self.now() - Duration::days(PUBLISHED_EVENT_RETENTION_DAYS));
        let published = format!("{}%", subjects::event_published(""));
        self.write(move |tx| {
            Box::pin(async move {
                macro_rules! expired_events {
                    ($statement:literal) => {
                        concat!(
                            $statement,
                            " WHERE event_seq IN (SELECT seq FROM events WHERE subject LIKE ? AND created_at < ?",
                            " AND NOT EXISTS (SELECT 1 FROM outbox_events o WHERE o.event_seq = events.seq AND o.status IN ('pending','failed')))"
                        )
                    };
                }
                let mut purged = 0;
                for statement in
                    [expired_events!("DELETE FROM event_keys"), expired_events!("DELETE FROM event_recipients"), expired_events!("DELETE FROM outbox_events")]
                {
                    purged += sqlx::query(statement).bind(&published).bind(&cutoff).execute(&mut **tx).await.db()?.rows_affected();
                }
                purged += sqlx::query(
                    "DELETE FROM events WHERE subject LIKE ? AND created_at < ?
                       AND NOT EXISTS (SELECT 1 FROM outbox_events o WHERE o.event_seq = events.seq)",
                )
                .bind(&published)
                .bind(&cutoff)
                .execute(&mut **tx)
                .await
                .db()?
                .rows_affected();
                purged += sqlx::query("DELETE FROM reaction_firings WHERE created_at < ? AND status <> 'pending'")
                    .bind(&cutoff)
                    .execute(&mut **tx)
                    .await
                    .db()?
                    .rows_affected();
                purged += sqlx::query("DELETE FROM event_keys WHERE created_at < ?").bind(&cutoff).execute(&mut **tx).await.db()?.rows_affected();
                Ok(purged)
            })
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::valid_topic;

    #[test]
    fn topics_need_three_lowercase_parts() {
        assert!(valid_topic("github.pull_request.opened"));
        assert!(valid_topic("clock.nightly.tick"));
        assert!(valid_topic("jira.issue.transitioned.done"));
        assert!(!valid_topic("github.opened"));
        assert!(!valid_topic("GitHub.pull_request.opened"));
        assert!(!valid_topic("github..opened"));
        assert!(!valid_topic("github.pull request.opened"));
        assert!(!valid_topic("github.pull_request.*"));
        assert!(!valid_topic(&format!("a.b.{}", "c".repeat(200))));
    }
}
