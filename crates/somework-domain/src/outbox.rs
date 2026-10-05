//! Transactional outbox runner. Rows are inserted in the same transaction as the state change (see
//! [`crate::events`]); this module publishes them to sinks (NATS, Matrix, federation gateway) with retries,
//! exponential backoff, a dead-letter state and multi-replica safe claiming.

use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use chrono::Duration as ChronoDuration;
use serde::Serialize;
use serde_json::Value;
use somework_core::{
    Error,
    clock::{parse_ts, ts},
};
use sqlx::Row;
use tokio_util::sync::CancellationToken;

use crate::{
    db::{DbResultExt, icol, jcol, scol, scol_opt},
    domain::Domain,
};

#[derive(Debug, Clone)]
pub struct OutboxItem {
    pub id: i64,
    pub event_seq: i64,
    pub sink: String,
    pub subject: String,
    pub dedupe_key: String,
    pub coalesce_key: Option<String>,
    pub payload: Value,
    pub attempts: i64,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct SinkError {
    pub message: String,
    /// Non-retryable errors dead-letter the row immediately.
    pub retryable: bool,
}

impl SinkError {
    pub fn transient(message: impl Into<String>) -> Self {
        Self { message: message.into(), retryable: true }
    }
    pub fn permanent(message: impl Into<String>) -> Self {
        Self { message: message.into(), retryable: false }
    }
}

#[async_trait]
pub trait OutboxSink: Send + Sync + 'static {
    fn name(&self) -> &'static str;

    async fn deliver(&self, item: &OutboxItem) -> Result<(), SinkError>;

    /// Sinks that can pipeline publishes override this; results are positional.
    async fn deliver_batch(&self, items: &[OutboxItem]) -> Vec<Result<(), SinkError>> {
        let mut out = Vec::with_capacity(items.len());
        for item in items {
            out.push(self.deliver(item).await);
        }
        out
    }
}

#[derive(Debug, Clone)]
pub struct OutboxConfig {
    pub batch_size: i64,
    pub poll_interval: Duration,
    pub claim_ttl: Duration,
    pub max_attempts: i64,
    pub base_backoff: Duration,
    pub max_backoff: Duration,
    /// Minimum spacing between published rows sharing a coalesce key (Matrix progress throttle, 500–1000 ms).
    pub coalesce_interval: Duration,
}

impl Default for OutboxConfig {
    fn default() -> Self {
        Self {
            batch_size: 256,
            poll_interval: Duration::from_millis(200),
            claim_ttl: Duration::from_secs(5),
            max_attempts: 12,
            base_backoff: Duration::from_millis(250),
            max_backoff: Duration::from_secs(60),
            coalesce_interval: Duration::from_millis(750),
        }
    }
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StepReport {
    pub claimed: usize,
    pub published: usize,
    pub retried: usize,
    pub dead: usize,
    pub superseded: usize,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OutboxStats {
    pub sink: String,
    pub pending: i64,
    pub failed: i64,
    pub dead: i64,
    pub published: i64,
    pub oldest_pending_age_seconds: i64,
}

impl Domain {
    pub async fn outbox_step(&self, sink: &dyn OutboxSink, worker_id: &str, cfg: &OutboxConfig) -> Result<StepReport, Error> {
        let mut report = StepReport::default();
        let items = self.claim_outbox_batch(sink.name(), worker_id, cfg, &mut report).await?;
        report.claimed = items.len();
        if items.is_empty() {
            return Ok(report);
        }
        // Chaos hook: rows are committed and claimed but nothing has been published yet.
        self.failpoint("outbox.before_publish").await?;
        let results = sink.deliver_batch(&items).await;
        let now = self.now();
        let now_ts = self.now_ts();
        let mut tx = self.db.begin_write().await?;
        for (item, result) in items.iter().zip(results) {
            match result {
                Ok(()) => {
                    sqlx::query("UPDATE outbox_events SET status = 'published', published_at = ?, claimed_by = NULL, claim_expires_at = NULL, last_error = NULL WHERE id = ?").bind(&now_ts).bind(item.id).execute(&mut *tx).await.db()?;
                    report.published += 1;
                }
                Err(err) => {
                    let attempts = item.attempts + 1;
                    let dead = !err.retryable || attempts >= cfg.max_attempts;
                    let backoff = (cfg.base_backoff * 2u32.saturating_pow(attempts.min(16) as u32)).min(cfg.max_backoff);
                    sqlx::query("UPDATE outbox_events SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ?, claimed_by = NULL, claim_expires_at = NULL WHERE id = ?")
                        .bind(if dead { "dead" } else { "failed" })
                        .bind(attempts)
                        .bind(&err.message)
                        .bind(ts(now + ChronoDuration::milliseconds(backoff.as_millis() as i64)))
                        .bind(item.id)
                        .execute(&mut *tx)
                        .await
                        .db()?;
                    if dead {
                        report.dead += 1;
                        tracing::error!(sink = sink.name(), id = item.id, error = %err.message, "outbox row dead-lettered");
                    } else {
                        report.retried += 1;
                    }
                }
            }
        }
        tx.commit().await.db()?;
        Ok(report)
    }

    async fn claim_outbox_batch(&self, sink: &str, worker_id: &str, cfg: &OutboxConfig, report: &mut StepReport) -> Result<Vec<OutboxItem>, Error> {
        let now = self.now();
        let now_ts = ts(now);
        let coalesce_cutoff = ts(now - ChronoDuration::milliseconds(cfg.coalesce_interval.as_millis() as i64));
        let claim_until = ts(now + ChronoDuration::milliseconds(cfg.claim_ttl.as_millis() as i64));
        let sink_name = sink.to_string();
        let worker = worker_id.to_string();
        let batch = cfg.batch_size;
        let (items, superseded) = self
            .db
            .write(move |tx| {
                Box::pin(async move {
                    // Older rows of a coalescable stream (progress updates) are dropped once a newer one is waiting.
                    let superseded = sqlx::query(
                        "UPDATE outbox_events SET status = 'skipped', last_error = 'superseded' WHERE sink = ? AND status IN ('pending','failed') AND coalesce_key IS NOT NULL
                         AND id < (SELECT MAX(o2.id) FROM outbox_events o2 WHERE o2.sink = outbox_events.sink AND o2.coalesce_key = outbox_events.coalesce_key AND o2.status IN ('pending','failed'))",
                    )
                    .bind(&sink_name)
                    .execute(&mut **tx)
                    .await
                    .db()?
                    .rows_affected();
                    let rows = sqlx::query(
                        "SELECT * FROM outbox_events o WHERE o.sink = ? AND o.status IN ('pending','failed') AND o.next_attempt_at <= ?
                           AND (o.claimed_by IS NULL OR o.claim_expires_at <= ?)
                           AND (o.coalesce_key IS NULL OR NOT EXISTS (SELECT 1 FROM outbox_events p WHERE p.sink = o.sink AND p.coalesce_key = o.coalesce_key AND p.status = 'published' AND p.published_at > ?))
                         ORDER BY (o.subject LIKE 'somework.work.%') DESC, o.id ASC LIMIT ?",
                    )
                    .bind(&sink_name)
                    .bind(&now_ts)
                    .bind(&now_ts)
                    .bind(&coalesce_cutoff)
                    .bind(batch)
                    .fetch_all(&mut **tx)
                    .await
                    .db()?;
                    let mut items = Vec::new();
                    for r in rows {
                        let id = icol(&r, "id");
                        sqlx::query("UPDATE outbox_events SET claimed_by = ?, claim_expires_at = ? WHERE id = ?").bind(&worker).bind(&claim_until).bind(id).execute(&mut **tx).await.db()?;
                        items.push(OutboxItem {
                            id,
                            event_seq: icol(&r, "event_seq"),
                            sink: scol(&r, "sink"),
                            subject: scol(&r, "subject"),
                            dedupe_key: scol(&r, "dedupe_key"),
                            coalesce_key: scol_opt(&r, "coalesce_key"),
                            payload: jcol(&r, "payload"),
                            attempts: icol(&r, "attempts"),
                            created_at: scol(&r, "created_at"),
                        });
                    }
                    Ok((items, superseded))
                })
            })
            .await?;
        report.superseded = superseded as usize;
        Ok(items)
    }

    pub async fn outbox_stats(&self) -> Result<Vec<OutboxStats>, Error> {
        let rows = sqlx::query("SELECT sink, status, COUNT(*) AS n, MIN(created_at) AS oldest FROM outbox_events GROUP BY sink, status")
            .fetch_all(self.db.pool())
            .await
            .db()?;
        let mut by_sink: std::collections::BTreeMap<String, OutboxStats> = Default::default();
        for r in rows {
            let sink = scol(&r, "sink");
            let entry = by_sink.entry(sink.clone()).or_insert_with(|| OutboxStats { sink, ..Default::default() });
            let n: i64 = r.get("n");
            match scol(&r, "status").as_str() {
                "pending" => {
                    entry.pending += n;
                    if let Some(oldest) = scol_opt(&r, "oldest").as_deref().and_then(parse_ts) {
                        entry.oldest_pending_age_seconds = entry.oldest_pending_age_seconds.max((self.now() - oldest).num_seconds());
                    }
                }
                "failed" => {
                    entry.failed += n;
                    if let Some(oldest) = scol_opt(&r, "oldest").as_deref().and_then(parse_ts) {
                        entry.oldest_pending_age_seconds = entry.oldest_pending_age_seconds.max((self.now() - oldest).num_seconds());
                    }
                }
                "dead" => entry.dead += n,
                "published" => entry.published += n,
                _ => {}
            }
        }
        Ok(by_sink.into_values().collect())
    }

    /// Operator action: give dead-lettered rows another chance (e.g. after fixing the sink).
    pub async fn outbox_requeue_dead(&self, sink: &str) -> Result<u64, Error> {
        let res =
            sqlx::query("UPDATE outbox_events SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL WHERE sink = ? AND status = 'dead'")
                .bind(self.now_ts())
                .bind(sink)
                .execute(self.db.writer())
                .await
                .db()?;
        self.outbox_notify.notify_waiters();
        Ok(res.rows_affected())
    }

    /// Re-enqueue work-ready notifications for every queued task, e.g. after losing JetStream (BAK-02).
    pub async fn republish_queued_tasks(&self) -> Result<u64, Error> {
        let ctx = self.system_ctx();
        let ids: Vec<String> =
            sqlx::query_scalar("SELECT task_id FROM tasks WHERE state = 'queued' ORDER BY created_at").fetch_all(self.db.pool()).await.db()?;
        let mut n = 0;
        for id in ids {
            let this = self.clone();
            let ctx = ctx.clone();
            let ok = self
                .write(move |tx| {
                    Box::pin(async move {
                        let row = this.load_task(tx, &id).await?;
                        if row.state != somework_core::fsm::TaskState::Queued {
                            return Ok(false);
                        }
                        let mut spec = crate::events::EventSpec::new("task.work_ready", serde_json::json!({"taskId": row.task_id, "revision": row.revision, "state": "queued"})).task(&row.task_id, row.revision);
                        spec.capability_id = Some(row.capability_id.clone());
                        for (subject, pool) in this.work_subjects_pub(tx, &row).await? {
                            spec = spec.nats(subject, serde_json::json!({"taskId": row.task_id, "revision": row.revision, "capabilityId": row.capability_id, "capabilityVersion": row.capability_version, "poolId": pool}));
                        }
                        this.emit(tx, &ctx, spec).await?;
                        Ok(true)
                    })
                })
                .await?;
            if ok {
                n += 1;
            }
        }
        Ok(n)
    }

    pub fn spawn_outbox(&self, sink: Arc<dyn OutboxSink>, cfg: OutboxConfig, shutdown: CancellationToken) -> tokio::task::JoinHandle<()> {
        let domain = self.clone();
        let worker_id = format!("{}-{}", sink.name(), somework_core::ids::jti());
        tokio::spawn(async move {
            loop {
                if shutdown.is_cancelled() {
                    break;
                }
                let notified = domain.outbox_notify.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                match domain.outbox_step(sink.as_ref(), &worker_id, &cfg).await {
                    Ok(report) if report.claimed > 0 => continue,
                    Ok(_) => {}
                    Err(err) => {
                        tracing::warn!(sink = sink.name(), error = %err, "outbox step failed");
                        tokio::time::sleep(cfg.poll_interval).await;
                    }
                }
                tokio::select! {
                    _ = shutdown.cancelled() => break,
                    _ = notified => {},
                    _ = tokio::time::sleep(cfg.poll_interval) => {},
                }
            }
        })
    }

    /// Periodic maintenance: leases, deadlines, approvals, stale uploads, retention and gauge refresh.
    pub fn spawn_maintenance(&self, interval: Duration, shutdown: CancellationToken) -> tokio::task::JoinHandle<()> {
        let domain = self.clone();
        tokio::spawn(async move {
            let mut ticks = 0u64;
            loop {
                tokio::select! {
                    _ = shutdown.cancelled() => break,
                    _ = tokio::time::sleep(interval) => {},
                }
                if let Err(err) = domain.run_maintenance().await {
                    tracing::warn!(error = %err, "maintenance failed");
                }
                ticks += 1;
                if ticks.is_multiple_of(30) {
                    let _ = domain.expire_stale_uploads().await;
                }
                if ticks.is_multiple_of(3600) {
                    let _ = domain.purge_retention().await;
                }
                let _ = domain.refresh_gauges().await;
            }
        })
    }

    pub async fn refresh_gauges(&self) -> Result<(), Error> {
        let queued: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tasks WHERE state = 'queued'").fetch_one(self.db.pool()).await.db()?;
        self.metrics.tasks_queued.set(queued);
        let oldest: Option<String> = sqlx::query_scalar("SELECT MIN(updated_at) FROM tasks WHERE state = 'queued'").fetch_one(self.db.pool()).await.db()?;
        self.metrics.task_queue_age.set(oldest.as_deref().and_then(parse_ts).map(|t| (self.now() - t).num_seconds().max(0)).unwrap_or(0));
        for stat in self.outbox_stats().await? {
            self.metrics.outbox_backlog.with_label_values(&[stat.sink.as_str()]).set(stat.pending + stat.failed);
            self.metrics.outbox_oldest_age.with_label_values(&[stat.sink.as_str()]).set(stat.oldest_pending_age_seconds);
            self.metrics.outbox_dead.with_label_values(&[stat.sink.as_str()]).set(stat.dead);
            if stat.sink == crate::config::SINK_MATRIX {
                self.metrics.matrix_projection_lag.set(stat.oldest_pending_age_seconds);
            }
        }
        let cutoff = ts(self.now() - ChronoDuration::seconds(self.cfg.runtime_ttl_seconds));
        let connected: i64 = sqlx::query_scalar("SELECT COUNT(DISTINCT agent_id) FROM runtime_instances WHERE status = 'active' AND last_seen_at >= ?")
            .bind(&cutoff)
            .fetch_one(self.db.pool())
            .await
            .db()?;
        let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agents WHERE status <> 'disabled'").fetch_one(self.db.pool()).await.db()?;
        self.metrics.agent_connected.set(connected);
        self.metrics.agent_offline.set((total - connected).max(0));
        Ok(())
    }
}
