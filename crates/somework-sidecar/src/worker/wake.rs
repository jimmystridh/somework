//! Wake sources: how a worker learns that there is something to do. Polling needs only outbound HTTPS; NATS adds
//! durable low-latency delivery over an outbound connection. Both are at-least-once; claims are idempotent.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use async_trait::async_trait;
use futures::StreamExt;
use serde_json::Value;
use somework_client::Client;
use somework_core::{Error, subjects};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::{
    backoff::{Backoff, jittered},
    config::TlsConfig,
};

#[derive(Debug, Clone, PartialEq)]
pub enum WakeKind {
    /// A task is ready to be claimed.
    Task { task_id: String },
    /// A message addressed to this agent with an explicit wake trigger.
    Message { message_id: String },
    /// Informational task event (child finished, input provided, ...).
    TaskEvent { task_id: String, event: String },
}

#[async_trait]
pub trait AckHandle: Send + Sync {
    async fn ack(&self);
}

#[derive(Clone)]
pub struct Wake {
    pub kind: WakeKind,
    pub dedupe_key: String,
    pub ack: Option<Arc<dyn AckHandle>>,
}

impl std::fmt::Debug for Wake {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Wake").field("kind", &self.kind).field("dedupe_key", &self.dedupe_key).finish()
    }
}

impl Wake {
    pub async fn ack(&self) {
        if let Some(a) = &self.ack {
            a.ack().await;
        }
    }
}

#[async_trait]
pub trait WakeSource: Send + Sync {
    /// Waits (bounded) for wake-ups; an empty vector just means "nothing yet".
    async fn next(&self) -> Result<Vec<Wake>, Error>;
}

/// Suppresses duplicates for a short window (redeliveries, repeated polls).
#[derive(Default)]
pub struct Dedupe {
    seen: Mutex<HashMap<String, Instant>>,
}

impl Dedupe {
    pub fn first_time(&self, key: &str, window: Duration) -> bool {
        let mut seen = self.seen.lock().expect("dedupe map");
        let now = Instant::now();
        seen.retain(|_, at| now.duration_since(*at) < window);
        if seen.contains_key(key) {
            return false;
        }
        seen.insert(key.to_string(), now);
        true
    }
}

pub struct PollingWakeSource {
    client: Client,
    wait_seconds: u64,
    cursor: Mutex<Option<i64>>,
    dedupe: Dedupe,
    retry_after: Duration,
    /// Only look at queued tasks, never at the event cursor (reconciliation next to a push transport).
    tasks_only: bool,
    /// Start at the current event head instead of resuming from the last server-side acknowledgement.
    start_at_head: bool,
}

struct CursorAck {
    client: Client,
    seq: i64,
}

#[async_trait]
impl AckHandle for CursorAck {
    async fn ack(&self) {
        let _ = self.client.ack_events(self.seq).await;
    }
}

impl PollingWakeSource {
    pub fn new(client: Client, wait_seconds: u64) -> Self {
        Self {
            client,
            wait_seconds,
            cursor: Mutex::new(None),
            dedupe: Dedupe::default(),
            retry_after: Duration::from_secs(2),
            tasks_only: false,
            start_at_head: false,
        }
    }

    /// Reconciles queued tasks only. Messages and events are not covered: they reach the worker through the push
    /// transport and are redelivered by it.
    pub fn tasks_only(client: Client) -> Self {
        Self { tasks_only: true, ..Self::new(client, 0) }
    }

    /// Full polling that begins at "now". Used when the push transport is lost mid-run: everything older was either
    /// handled by it already or is redelivered once it is back.
    pub fn from_head(client: Client, wait_seconds: u64) -> Self {
        Self { start_at_head: true, ..Self::new(client, wait_seconds) }
    }

    /// One look at the domain; `task_wait` is how long an empty task lookup may be held open.
    pub async fn poll(&self, task_wait: u64) -> Result<Vec<Wake>, Error> {
        let mut out = vec![];
        if !self.tasks_only {
            out = self.poll_events().await?;
        }
        let wait = if out.is_empty() { task_wait } else { 0 };
        for t in self.client.next_tasks(wait).await.map_err(Error::from)? {
            let Some(id) = t["taskId"].as_str() else { continue };
            let key = format!("task:{id}:{}", t["revision"]);
            if self.dedupe.first_time(&key, self.retry_after) {
                out.push(Wake { kind: WakeKind::Task { task_id: id.to_string() }, dedupe_key: key, ack: None });
            }
        }
        Ok(out)
    }

    async fn poll_events(&self) -> Result<Vec<Wake>, Error> {
        let mut out = vec![];
        let after = *self.cursor.lock().expect("cursor");
        let (events, cursor) = match after {
            Some(a) => self.client.events(a, 0).await.map_err(Error::from)?,
            None => {
                let v = self.client.get("/v1/events?wait=0").await.map_err(Error::from)?;
                let cursor = v["cursor"].as_i64().unwrap_or(0);
                // default: resume from the server-side acknowledged cursor instead of replaying history
                let events = if self.start_at_head { vec![] } else { v["events"].as_array().cloned().unwrap_or_default() };
                (events, cursor)
            }
        };
        for e in &events {
            if !e["wake"].as_bool().unwrap_or(false) {
                continue;
            }
            let seq = e["seq"].as_i64().unwrap_or(cursor);
            let ack: Option<Arc<dyn AckHandle>> = Some(Arc::new(CursorAck { client: self.client.clone(), seq }));
            match e["type"].as_str().unwrap_or_default() {
                "message.created" => {
                    if let Some(id) = e["payload"]["messageId"].as_str() {
                        out.push(Wake { kind: WakeKind::Message { message_id: id.to_string() }, dedupe_key: format!("msg:{id}"), ack });
                    }
                }
                kind if kind.starts_with("task.") => {
                    if let Some(id) = e["taskId"].as_str() {
                        out.push(Wake {
                            kind: WakeKind::TaskEvent { task_id: id.to_string(), event: kind.to_string() },
                            dedupe_key: format!("evt:{}", e["eventId"].as_str().unwrap_or_default()),
                            ack,
                        });
                    }
                }
                _ => {}
            }
        }
        *self.cursor.lock().expect("cursor") = Some(cursor);
        Ok(out)
    }
}

#[async_trait]
impl WakeSource for PollingWakeSource {
    async fn next(&self) -> Result<Vec<Wake>, Error> {
        self.poll(self.wait_seconds.min(2)).await
    }
}

/// A durable pull consumer the agent drains: work-ready notifications for one pool.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolConsumer {
    pub stream: String,
    pub consumer: String,
}

/// Connection details for the NATS plane as returned by `GET /v1/connection`.
#[derive(Debug, Clone)]
pub struct NatsInfo {
    pub url: String,
    pub user: Option<String>,
    pub password: Option<String>,
    pub token: Option<String>,
    pub work_stream: String,
    pub inbox_stream: String,
    pub pool_consumers: Vec<PoolConsumer>,
    pub inbox_consumer: Option<String>,
}

impl NatsInfo {
    pub fn from_connection(info: &Value) -> Option<Self> {
        let n = info.get("nats").filter(|n| n.is_object())?;
        let url = n
            .get("url")
            .and_then(Value::as_str)
            .map(String::from)
            .or_else(|| n["urls"].as_array().and_then(|a| a.first()).and_then(Value::as_str).map(String::from))?;
        let work_stream = n["workStream"].as_str().unwrap_or(subjects::STREAM_WORK).to_string();
        // the domain describes each pool consumer as an object; a bare consumer name (older form) lives on the work stream
        let pool_consumers = n["poolConsumers"]
            .as_array()
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|entry| match entry.as_str() {
                        Some(name) => Some(PoolConsumer { stream: work_stream.clone(), consumer: name.to_string() }),
                        None => Some(PoolConsumer {
                            stream: entry["stream"].as_str().unwrap_or(&work_stream).to_string(),
                            consumer: entry["consumer"].as_str()?.to_string(),
                        }),
                    })
                    .collect()
            })
            .unwrap_or_default();
        Some(Self {
            url,
            user: n["user"].as_str().map(String::from),
            password: n["password"].as_str().map(String::from),
            token: n["token"].as_str().map(String::from),
            work_stream,
            inbox_stream: n["inboxStream"].as_str().unwrap_or(subjects::STREAM_INBOX).to_string(),
            pool_consumers,
            inbox_consumer: n["inboxConsumer"].as_str().map(String::from),
        })
    }

    /// TLS policy comes from the sidecar's own configuration, never from the domain's `/v1/connection` answer, so a
    /// compromised or misconfigured domain cannot talk the worker into plaintext or an untrusted CA.
    pub async fn connect(&self, tls: &TlsConfig) -> Result<async_nats::Client, Error> {
        crate::tls::install_crypto_provider();
        let mut opts = match (&self.user, &self.password, &self.token) {
            (Some(u), Some(p), _) => async_nats::ConnectOptions::with_user_and_password(u.clone(), p.clone()),
            (_, _, Some(t)) => async_nats::ConnectOptions::with_token(t.clone()),
            _ => async_nats::ConnectOptions::new(),
        };
        if tls.required {
            opts = opts.require_tls(true);
        }
        if let Some(ca) = &tls.ca_file {
            opts = opts.add_root_certificates(ca.clone());
        }
        opts.connect(&self.url).await.map_err(|e| Error::unavailable(format!("NATS connect failed: {e}")))
    }
}

struct JsAck {
    message: Mutex<Option<async_nats::jetstream::Message>>,
}

#[async_trait]
impl AckHandle for JsAck {
    async fn ack(&self) {
        let message = self.message.lock().expect("ack slot").take();
        if let Some(m) = message {
            let _ = m.ack().await;
        }
    }
}

pub struct NatsWakeSource {
    rx: tokio::sync::Mutex<mpsc::Receiver<Wake>>,
    /// Cancelled as soon as any consumer stream ends: a source that lost a consumer must be rebuilt, not trusted.
    dead: CancellationToken,
    _client: async_nats::Client,
}

impl NatsWakeSource {
    pub async fn connect(info: &NatsInfo, own_agent_id: String, tls: &TlsConfig) -> Result<Self, Error> {
        let client = info.connect(tls).await?;
        let dead = CancellationToken::new();
        let js = async_nats::jetstream::new(client.clone());
        let (tx, rx) = mpsc::channel::<Wake>(256);
        let dedupe = Arc::new(Dedupe::default());
        let mut consumers: Vec<(String, String, bool)> = info.pool_consumers.iter().map(|c| (c.stream.clone(), c.consumer.clone(), false)).collect();
        if let Some(c) = &info.inbox_consumer {
            consumers.push((info.inbox_stream.clone(), c.clone(), true));
        }
        for (stream, name, inbox) in consumers {
            let consumer = attach_consumer(&js, &stream, &name).await?;
            let mut messages = consumer.messages().await.map_err(|e| Error::unavailable(format!("cannot pull from {name}: {e}")))?;
            let tx = tx.clone();
            let dedupe = dedupe.clone();
            let own = own_agent_id.clone();
            let ended = dead.clone();
            tokio::spawn(async move {
                let _on_exit = ended.drop_guard();
                while let Some(item) = messages.next().await {
                    let Ok(message) = item else { continue };
                    let payload: Value = serde_json::from_slice(&message.payload).unwrap_or(Value::Null);
                    let wake = interpret(&payload, inbox, &own);
                    match wake {
                        None => {
                            let _ = message.ack().await;
                        }
                        Some((kind, key)) => {
                            if !dedupe.first_time(&key, Duration::from_secs(120)) {
                                let _ = message.ack().await; // duplicate delivery: already handled
                                continue;
                            }
                            let ack: Arc<dyn AckHandle> = Arc::new(JsAck { message: Mutex::new(Some(message)) });
                            if tx.send(Wake { kind, dedupe_key: key, ack: Some(ack) }).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            });
        }
        Ok(Self { rx: tokio::sync::Mutex::new(rx), dead, _client: client })
    }
}

/// The domain provisions an agent's consumers asynchronously (on first contact and after a broker restart), so a worker that
/// starts right then may find them missing for a moment. Wait for them instead of failing the whole transport.
async fn attach_consumer(
    js: &async_nats::jetstream::Context,
    stream: &str,
    name: &str,
) -> Result<async_nats::jetstream::consumer::Consumer<async_nats::jetstream::consumer::pull::Config>, Error> {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match js.get_consumer_from_stream::<async_nats::jetstream::consumer::pull::Config, _, _>(name, stream).await {
            Ok(consumer) => return Ok(consumer),
            Err(e) if Instant::now() >= deadline => return Err(Error::unavailable(format!("cannot attach to consumer {name} on {stream}: {e}"))),
            Err(_) => tokio::time::sleep(Duration::from_millis(250)).await,
        }
    }
}

/// Maps a JetStream notification to a wake-up; `None` means "acknowledge and ignore" (loop protection: items that
/// must not wake the agent, and the agent's own output).
pub fn interpret(payload: &Value, inbox: bool, own_agent_id: &str) -> Option<(WakeKind, String)> {
    if inbox {
        if !payload["wake"].as_bool().unwrap_or(false) || payload["sender"].as_str() == Some(own_agent_id) {
            return None;
        }
        return match payload["kind"].as_str() {
            Some("message") => payload["messageId"].as_str().map(|id| (WakeKind::Message { message_id: id.to_string() }, format!("msg:{id}"))),
            Some("task") => payload["taskId"].as_str().map(|id| {
                (
                    WakeKind::TaskEvent { task_id: id.to_string(), event: payload["event"].as_str().unwrap_or_default().to_string() },
                    format!("evt:{}", payload["eventId"].as_str().unwrap_or(id)),
                )
            }),
            _ => None,
        };
    }
    let id = payload["taskId"].as_str()?;
    Some((WakeKind::Task { task_id: id.to_string() }, format!("task:{id}:{}", payload["revision"])))
}

#[async_trait]
impl WakeSource for NatsWakeSource {
    async fn next(&self) -> Result<Vec<Wake>, Error> {
        let mut rx = self.rx.lock().await;
        let mut out = vec![];
        if self.dead.is_cancelled() {
            return Err(Error::unavailable("a NATS consumer stream ended"));
        }
        match tokio::time::timeout(Duration::from_secs(2), rx.recv()).await {
            Ok(Some(w)) => out.push(w),
            Ok(None) => return Err(Error::unavailable("NATS consumers closed")),
            Err(_) => return Ok(out),
        }
        while let Ok(w) = rx.try_recv() {
            out.push(w);
        }
        Ok(out)
    }
}

/// Builds a fresh NATS wake source (re-reading the connection details, so rotated credentials are picked up).
pub type ConnectNats = Arc<dyn Fn() -> futures::future::BoxFuture<'static, Result<Arc<dyn WakeSource>, Error>> + Send + Sync>;

/// NATS for low-latency wakes, with HTTP as the safety net:
///
/// * every `sweep_every` (jittered) queued tasks are looked up over HTTP, so a lost, delayed or purged notification only
///   adds latency;
/// * when the NATS source fails the worker keeps working over HTTP (events and tasks, from "now") while the NATS source
///   is rebuilt with jittered exponential backoff;
/// * duplicate message/event wakes (the same item arriving over both paths) are suppressed. Task wakes are not: claims
///   are fenced and idempotent, and a task must be re-offered if the first attempt could not decide.
pub struct ResilientWakeSource {
    client: Client,
    connect: ConnectNats,
    sweep_every: Duration,
    poll_wait_seconds: u64,
    dedupe: Dedupe,
    state: tokio::sync::Mutex<ResilientState>,
}

struct ResilientState {
    nats: Option<Arc<dyn WakeSource>>,
    sweep: PollingWakeSource,
    fallback: Option<PollingWakeSource>,
    next_sweep: Instant,
    next_reconnect: Instant,
    backoff: Backoff,
}

impl ResilientWakeSource {
    /// `nats` is the already connected source, or `None` when the first attempt failed and the worker should start over
    /// HTTP while NATS keeps being retried; `connect` builds (and rebuilds) it.
    pub fn new(client: Client, nats: Option<Arc<dyn WakeSource>>, connect: ConnectNats, sweep_every: Duration, poll_wait_seconds: u64) -> Self {
        let state = ResilientState {
            nats,
            sweep: PollingWakeSource::tasks_only(client.clone()),
            fallback: None,
            next_sweep: Instant::now() + jittered(sweep_every),
            next_reconnect: Instant::now(),
            backoff: Backoff::new(Duration::from_secs(1), Duration::from_secs(30)),
        };
        Self { client, connect, sweep_every, poll_wait_seconds, dedupe: Dedupe::default(), state: tokio::sync::Mutex::new(state) }
    }

    async fn try_reconnect(&self, st: &mut ResilientState) {
        if st.nats.is_some() || Instant::now() < st.next_reconnect {
            return;
        }
        match (self.connect)().await {
            Ok(source) => {
                tracing::info!("NATS wake source restored");
                st.nats = Some(source);
                st.fallback = None;
                st.backoff.reset();
            }
            Err(e) => {
                let delay = st.backoff.next_delay();
                tracing::warn!(error = %e, retry_in_ms = delay.as_millis() as u64, "NATS reconnect failed; continuing over HTTP");
                st.next_reconnect = Instant::now() + delay;
            }
        }
    }

    fn first_delivery(&self, wake: &Wake) -> bool {
        match wake.kind {
            WakeKind::Task { .. } => true,
            WakeKind::Message { .. } | WakeKind::TaskEvent { .. } => self.dedupe.first_time(&wake.dedupe_key, Duration::from_secs(120)),
        }
    }
}

#[async_trait]
impl WakeSource for ResilientWakeSource {
    async fn next(&self) -> Result<Vec<Wake>, Error> {
        let mut st = self.state.lock().await;
        self.try_reconnect(&mut st).await;
        let mut wakes = vec![];
        if let Some(nats) = st.nats.clone() {
            match nats.next().await {
                Ok(w) => wakes = w,
                Err(e) => {
                    let delay = st.backoff.next_delay();
                    tracing::warn!(error = %e, retry_in_ms = delay.as_millis() as u64, "NATS wake source failed; continuing over HTTP");
                    st.nats = None;
                    st.next_reconnect = Instant::now() + delay;
                }
            }
            if Instant::now() >= st.next_sweep {
                wakes.extend(st.sweep.poll(0).await?);
                st.next_sweep = Instant::now() + jittered(self.sweep_every);
            }
        } else {
            let client = self.client.clone();
            let wait = self.poll_wait_seconds;
            let fallback = st.fallback.get_or_insert_with(|| PollingWakeSource::from_head(client, wait));
            wakes = fallback.next().await?;
        }
        wakes.retain(|w| self.first_delivery(w));
        Ok(wakes)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn connection_info_lists_every_pool_consumer_in_both_shapes() {
        let objects = json!({"nats": {"url": "nats://h:4222", "inboxConsumer": "inbox_a", "poolConsumers": [
            {"poolId": "agent/a", "stream": "SOMEWORK_WORK", "consumer": "pool_a", "filter": "somework.work.pool.a"},
            {"poolId": "pool/x", "stream": "OTHER", "consumer": "pool_x"}]}});
        let info = NatsInfo::from_connection(&objects).unwrap();
        assert_eq!(
            info.pool_consumers,
            [PoolConsumer { stream: "SOMEWORK_WORK".into(), consumer: "pool_a".into() }, PoolConsumer { stream: "OTHER".into(), consumer: "pool_x".into() }]
        );
        assert_eq!(info.inbox_consumer.as_deref(), Some("inbox_a"));

        let names = json!({"nats": {"url": "nats://h:4222", "poolConsumers": ["pool_a"]}});
        assert_eq!(
            NatsInfo::from_connection(&names).unwrap().pool_consumers,
            [PoolConsumer { stream: subjects::STREAM_WORK.into(), consumer: "pool_a".into() }]
        );
    }

    #[test]
    fn inbox_items_without_wake_or_from_self_are_ignored() {
        assert!(interpret(&json!({"kind": "message", "messageId": "m1", "wake": false, "sender": "agent/x"}), true, "agent/me").is_none());
        assert!(interpret(&json!({"kind": "message", "messageId": "m1", "wake": true, "sender": "agent/me"}), true, "agent/me").is_none());
        let (kind, key) = interpret(&json!({"kind": "message", "messageId": "m1", "wake": true, "sender": "agent/x"}), true, "agent/me").unwrap();
        assert_eq!(kind, WakeKind::Message { message_id: "m1".into() });
        assert_eq!(key, "msg:m1");
    }

    #[test]
    fn work_ready_notifications_become_task_wakes() {
        let (kind, key) = interpret(&json!({"taskId": "task_1", "revision": 2}), false, "agent/me").unwrap();
        assert_eq!(kind, WakeKind::Task { task_id: "task_1".into() });
        assert_eq!(key, "task:task_1:2");
        assert!(interpret(&json!({"revision": 2}), false, "agent/me").is_none());
    }

    #[test]
    fn dedupe_suppresses_repeats_within_the_window() {
        let d = Dedupe::default();
        assert!(d.first_time("a", Duration::from_secs(5)));
        assert!(!d.first_time("a", Duration::from_secs(5)));
        assert!(d.first_time("b", Duration::from_secs(5)));
    }

    #[test]
    fn connection_info_parses_the_documented_shape() {
        let info = NatsInfo::from_connection(&json!({"nats": {"url": "nats://x:1", "user": "u", "password": "p",
            "poolConsumers": [{"poolId": "agent/a", "stream": "SOMEWORK_WORK", "consumer": "pool_a", "filter": "somework.work.pool.a"}],
            "inboxConsumer": "inbox_a"}}))
        .unwrap();
        assert_eq!(info.pool_consumers, [PoolConsumer { stream: "SOMEWORK_WORK".into(), consumer: "pool_a".into() }]);
        assert_eq!(info.work_stream, subjects::STREAM_WORK);
        assert!(NatsInfo::from_connection(&json!({"nats": null, "pollOnly": true})).is_none());
    }
}
