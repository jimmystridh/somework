//! Worker runtime: turns wake-ups into claimed, leased, fenced task executions (TASK-02/05/06 worker side).
//!
//! Claim algorithm (spec "NATS subjects and JetStream"): receive wake -> POST claim -> success: keep lease+fence and
//! ack; already claimed/terminal/ineligible: ack; transient error: do not ack so the transport redelivers.

pub mod adapter;
pub mod lease;
pub mod stream;
pub mod wake;

use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::{Value, json};
use somework_client::{Client, ClientError};
use somework_core::{
    Error, ErrorCode,
    contracts::{CONTEXT_SECTIONS, Failure},
};
use tokio::sync::{Semaphore, mpsc};
use tokio_util::sync::CancellationToken;

use crate::{
    backoff::Backoff,
    config::{AdapterConfig, TlsConfig, WakeMode, WorkerConfig},
};
use adapter::*;
use lease::spawn_keepalive;
use stream::StreamPublisher;
use wake::*;

pub struct Worker {
    client: Client,
    cfg: WorkerConfig,
    adapter: Arc<dyn Adapter>,
    agent_id: String,
    runtime_id: String,
    stream: Mutex<Option<Arc<StreamPublisher>>>,
    inflight: Mutex<HashSet<String>>,
}

enum ClaimOutcome {
    Claimed(Box<Value>),
    /// Nothing to do for this wake-up (taken by someone else, finished, or not ours): acknowledge it.
    AckOnly,
    /// Could not decide (domain unreachable): leave the wake-up unacknowledged for redelivery.
    Transient,
}

pub fn build_adapter(cfg: &AdapterConfig, max_stderr_notices: usize) -> Arc<dyn Adapter> {
    match cfg {
        AdapterConfig::Exec { command, env, env_allow } => {
            Arc::new(ExecAdapter { command: command.clone(), env: env.clone(), env_allow: env_allow.clone(), max_stderr_notices })
        }
        AdapterConfig::Http { url } => Arc::new(HttpAdapter::new(url.clone())),
        AdapterConfig::None => Arc::new(NoAdapter),
    }
}

fn is_lease_loss(code: ErrorCode) -> bool {
    matches!(code, ErrorCode::StaleFencingToken | ErrorCode::LeaseExpired | ErrorCode::TaskTerminal | ErrorCode::InvalidTransition | ErrorCode::NotFound)
}

impl Worker {
    pub fn new(client: Client, agent_id: impl Into<String>, cfg: WorkerConfig, adapter: Arc<dyn Adapter>) -> Arc<Self> {
        let runtime_id = client.runtime_instance_id().unwrap_or_default();
        Arc::new(Self { client, cfg, adapter, agent_id: agent_id.into(), runtime_id, stream: Mutex::new(None), inflight: Mutex::new(HashSet::new()) })
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    /// Registers the runtime, picks a wake source from `GET /v1/connection` (unless forced) and works until `shutdown`.
    pub async fn run(self: Arc<Self>, shutdown: CancellationToken) -> anyhow::Result<()> {
        self.register_runtime(&shutdown).await;
        if shutdown.is_cancelled() {
            return Ok(());
        }
        let info = self.client.get("/v1/connection").await;
        let nats = info.as_ref().ok().and_then(NatsInfo::from_connection);
        let tls = self.cfg.tls.clone();
        let polling = || -> Arc<dyn WakeSource> { Arc::new(PollingWakeSource::new(self.client.clone(), self.cfg.poll_wait_seconds)) };
        let resilient = |initial: Option<Arc<dyn WakeSource>>, tls: TlsConfig| -> Arc<dyn WakeSource> {
            Arc::new(ResilientWakeSource::new(
                self.client.clone(),
                initial,
                self.nats_connector(tls),
                Duration::from_secs(self.cfg.reconcile_seconds.max(1)),
                self.cfg.poll_wait_seconds,
            ))
        };
        let source: Arc<dyn WakeSource> = match (self.cfg.wake, nats) {
            (WakeMode::Poll, _) => polling(),
            (WakeMode::Auto, None) if info.is_ok() => polling(),
            (WakeMode::Auto, None) => {
                tracing::warn!("could not read the connection details; working over HTTP and retrying NATS in the background");
                resilient(None, tls)
            }
            (WakeMode::Nats, None) => anyhow::bail!("wake = nats but the domain offers no NATS connection"),
            (mode, Some(info)) => {
                let initial: Option<Arc<dyn WakeSource>> = match NatsWakeSource::connect(&info, self.agent_id.clone(), &tls).await {
                    Ok(source) => {
                        if let Ok(client) = info.connect(&tls).await {
                            *self.stream.lock().expect("stream slot") = Some(Arc::new(StreamPublisher::new(client, self.runtime_id.clone())));
                        }
                        Some(Arc::new(source))
                    }
                    // wake = nats insists on the broker: an unverifiable certificate or unreachable broker is a startup error
                    Err(e) if mode == WakeMode::Nats => return Err(e.into()),
                    Err(e) => {
                        tracing::warn!(error = %e, "NATS unavailable; working over HTTP and retrying NATS in the background");
                        None
                    }
                };
                resilient(initial, tls)
            }
        };
        self.run_with_source(source, shutdown).await;
        Ok(())
    }

    fn nats_connector(&self, tls: TlsConfig) -> ConnectNats {
        let client = self.client.clone();
        let agent_id = self.agent_id.clone();
        Arc::new(move || {
            let (client, agent_id, tls) = (client.clone(), agent_id.clone(), tls.clone());
            Box::pin(async move {
                let info = client.get("/v1/connection").await.map_err(Error::from)?;
                let nats = NatsInfo::from_connection(&info).ok_or_else(|| Error::unavailable("the domain no longer offers NATS"))?;
                Ok(Arc::new(NatsWakeSource::connect(&nats, agent_id, &tls).await?) as Arc<dyn WakeSource>)
            })
        })
    }

    async fn register_runtime(&self, shutdown: &CancellationToken) {
        let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(30));
        loop {
            match self.client.register_runtime(json!({"sidecar": env!("CARGO_PKG_VERSION")})).await {
                Ok(_) => return,
                Err(e) => {
                    let delay = backoff.next_delay();
                    tracing::warn!(error = %e, retry_in_ms = delay.as_millis() as u64, "runtime registration failed; retrying");
                    tokio::select! {
                        _ = shutdown.cancelled() => return,
                        _ = tokio::time::sleep(delay) => {},
                    }
                }
            }
        }
    }

    pub async fn run_with_source(self: Arc<Self>, source: Arc<dyn WakeSource>, shutdown: CancellationToken) {
        let permits = Arc::new(Semaphore::new(self.cfg.concurrency.max(1)));
        let tracker = Arc::new(tokio::sync::Notify::new());
        let active = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let hb = self.clone();
        let hb_shutdown = shutdown.clone();
        let heartbeat = tokio::spawn(async move {
            let every = Duration::from_secs(hb.cfg.runtime_heartbeat_seconds.max(1));
            loop {
                tokio::select! {
                    _ = hb_shutdown.cancelled() => break,
                    _ = tokio::time::sleep(every) => {},
                }
                if let Err(e) = hb.client.runtime_heartbeat().await {
                    tracing::warn!(error = %e, "runtime heartbeat failed");
                }
                let publisher = hb.stream.lock().expect("stream slot").clone();
                if let Some(p) = publisher {
                    p.presence(&hb.agent_id).await;
                }
            }
        });
        let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(30));
        loop {
            let wakes = tokio::select! {
                _ = shutdown.cancelled() => break,
                w = source.next() => w,
            };
            let wakes = match wakes {
                Ok(w) => {
                    backoff.reset();
                    w
                }
                Err(e) => {
                    let delay = backoff.next_delay();
                    tracing::warn!(error = %e, retry_in_ms = delay.as_millis() as u64, "wake source failed");
                    tokio::select! {
                        _ = shutdown.cancelled() => break,
                        _ = tokio::time::sleep(delay) => {},
                    }
                    continue;
                }
            };
            for w in wakes {
                let Ok(permit) = permits.clone().acquire_owned().await else { break };
                let worker = self.clone();
                let stop = shutdown.clone();
                let tracker = tracker.clone();
                let active = active.clone();
                active.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                tokio::spawn(async move {
                    worker.handle_wake(w, stop).await;
                    drop(permit);
                    active.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                    tracker.notify_waiters();
                });
            }
        }
        // graceful shutdown: give running work a short window, then end the runtime; leases of abandoned work expire
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while active.load(std::sync::atomic::Ordering::SeqCst) > 0 && tokio::time::Instant::now() < deadline {
            let _ = tokio::time::timeout(Duration::from_millis(200), tracker.notified()).await;
        }
        heartbeat.abort();
        let _ = self.client.raw(reqwest::Method::DELETE, "/v1/runtimes/self", None, None, None).await;
    }

    async fn handle_wake(self: Arc<Self>, wake: Wake, shutdown: CancellationToken) {
        match wake.kind.clone() {
            WakeKind::Task { task_id } => {
                if !self.inflight.lock().expect("inflight").insert(task_id.clone()) {
                    wake.ack().await;
                    return;
                }
                let outcome = self.claim(&task_id).await;
                match outcome {
                    ClaimOutcome::Claimed(claim) => {
                        wake.ack().await;
                        self.run_claimed(*claim, shutdown).await;
                    }
                    ClaimOutcome::AckOnly => wake.ack().await,
                    ClaimOutcome::Transient => {}
                }
                self.inflight.lock().expect("inflight").remove(&task_id);
            }
            WakeKind::Message { message_id } => {
                self.handle_message(&message_id, shutdown).await;
                wake.ack().await;
            }
            WakeKind::TaskEvent { .. } => wake.ack().await,
        }
    }

    async fn claim(&self, task_id: &str) -> ClaimOutcome {
        match self.client.post(&format!("/v1/tasks/{task_id}/claim"), &json!({"leaseSeconds": self.cfg.lease_seconds})).await {
            Ok(v) => ClaimOutcome::Claimed(Box::new(v)),
            Err(e)
                if matches!(
                    e.code,
                    ErrorCode::AlreadyClaimed
                        | ErrorCode::TaskTerminal
                        | ErrorCode::InvalidTransition
                        | ErrorCode::NotFound
                        | ErrorCode::PolicyDenied
                        | ErrorCode::StaleRevision
                        | ErrorCode::ValidationFailed
                ) =>
            {
                tracing::debug!(task = task_id, code = ?e.code, "claim not needed");
                ClaimOutcome::AckOnly
            }
            Err(e) => {
                tracing::warn!(task = task_id, error = %e, "claim failed transiently");
                ClaimOutcome::Transient
            }
        }
    }

    async fn context_packs(&self, task: &Value) -> Vec<Value> {
        let mut packs = vec![];
        let task_id = task["taskId"].as_str().unwrap_or_default();
        for cref in task["contextRefs"].as_array().cloned().unwrap_or_default() {
            let (Some(id), Some(version)) = (cref["contextPackId"].as_str(), cref["version"].as_u64()) else { continue };
            let sections = cref["sections"]
                .as_array()
                .map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(","))
                .unwrap_or_else(|| CONTEXT_SECTIONS.join(","));
            match self.client.get(&format!("/v1/context-packs/{id}/{version}?taskId={task_id}&sections={sections}")).await {
                Ok(mut p) => {
                    if let Some(o) = p.as_object_mut() {
                        o.remove("traceId");
                    }
                    packs.push(p);
                }
                Err(e) => packs.push(json!({"contextPackId": id, "version": version, "error": {"code": e.code.as_str(), "message": e.message}})),
            }
        }
        packs
    }

    async fn run_claimed(&self, claim: Value, shutdown: CancellationToken) {
        let task = claim["task"].clone();
        let task_id = task["taskId"].as_str().unwrap_or_default().to_string();
        let fence = claim["fencingToken"].as_u64().unwrap_or_default();
        let lease = spawn_keepalive(self.client.clone(), task_id.clone(), fence, self.cfg.lease_seconds, self.cfg.heartbeat_ratio);
        let result = self.execute(&claim, &task_id, fence, &lease, &shutdown).await;
        lease.stop();
        if let Err(e) = result {
            tracing::warn!(task = %task_id, error = %e, "task execution ended without a committed outcome");
        }
    }

    async fn execute(&self, claim: &Value, task_id: &str, fence: u64, lease: &lease::LeaseHandle, shutdown: &CancellationToken) -> Result<(), ClientError> {
        let task = claim["task"].clone();
        let capability = claim["capability"].clone();
        let timeout = capability["timeoutSeconds"].as_u64().map(Duration::from_secs);
        self.client.progress_task(task_id, &json!({"fencingToken": fence, "status": "running", "message": "started"})).await?;
        let packs = self.context_packs(&task).await;
        let mut inputs: Vec<Value> = vec![];
        let mut seen_inputs: HashSet<String> = HashSet::new();
        loop {
            let job = Job {
                kind: "task".into(),
                task: task.clone(),
                capability: capability.clone(),
                context_packs: packs.clone(),
                inputs: inputs.clone(),
                fencing_token: fence,
                runtime_instance_id: self.runtime_id.clone(),
                message: None,
            };
            let cancel = CancellationToken::new();
            let (tx, rx) = mpsc::unbounded_channel();
            let pump = self.pump_events(task_id.to_string(), fence, rx);
            let adapter = self.adapter.clone();
            let ctl = JobCtl { events: tx, cancel: cancel.clone() };
            let run = adapter.run(job, ctl);
            tokio::pin!(run);
            let timeout_sleep = async {
                match timeout {
                    Some(t) => tokio::time::sleep(t).await,
                    None => std::future::pending::<()>().await,
                }
            };
            tokio::pin!(timeout_sleep);
            let mut timed_out = false;
            let mut lost = false;
            let outcome = loop {
                tokio::select! {
                    o = &mut run => break o,
                    _ = lease.lost(), if !lost => { lost = true; cancel.cancel(); }
                    _ = lease.cancel_requested(), if !cancel.is_cancelled() => { cancel.cancel(); }
                    _ = &mut timeout_sleep, if !timed_out => { timed_out = true; cancel.cancel(); }
                    _ = shutdown.cancelled(), if !cancel.is_cancelled() => { cancel.cancel(); }
                }
            };
            pump.await;
            if lost || lease.is_lost() {
                tracing::warn!(task = task_id, "lease lost; discarding the agent's outcome");
                return Ok(());
            }
            if timed_out {
                let failure = Failure {
                    code: "timeout".into(),
                    message: format!("the capability's timeout of {}s elapsed", timeout.map(|t| t.as_secs()).unwrap_or_default()),
                    retryable: false,
                    details: None,
                };
                return self.commit_failure(task_id, fence, failure).await;
            }
            match outcome {
                AdapterOutcome::Completed { result, artifacts } => return self.commit_result(task_id, fence, result, artifacts).await,
                AdapterOutcome::Failed(f) => return self.commit_failure(task_id, fence, f).await,
                AdapterOutcome::Canceled => {
                    if lease.is_cancel_requested() {
                        return match self.client.ack_cancel(task_id, fence).await {
                            Ok(_) => Ok(()),
                            Err(e) if is_lease_loss(e.code) => Ok(()),
                            Err(e) => Err(e),
                        };
                    }
                    let failure = Failure {
                        code: "agent_aborted".into(),
                        message: "the agent stopped before finishing (sidecar shutting down)".into(),
                        retryable: true,
                        details: None,
                    };
                    return self.commit_failure(task_id, fence, failure).await;
                }
                AdapterOutcome::InputRequired { question } => {
                    self.client
                        .progress_task(
                            task_id,
                            &json!({"fencingToken": fence, "status": "input_required", "question": question, "message": "waiting for input"}),
                        )
                        .await?;
                    match self.await_input(task_id, &task, lease, shutdown, &mut seen_inputs).await? {
                        Some(new_inputs) => inputs.extend(new_inputs),
                        None => {
                            if lease.is_cancel_requested() {
                                let _ = self.client.ack_cancel(task_id, fence).await;
                            }
                            return Ok(());
                        }
                    }
                }
            }
        }
    }

    /// Waits until the requester answered (task back to `running`) and returns the new input payloads.
    async fn await_input(
        &self,
        task_id: &str,
        task: &Value,
        lease: &lease::LeaseHandle,
        shutdown: &CancellationToken,
        seen: &mut HashSet<String>,
    ) -> Result<Option<Vec<Value>>, ClientError> {
        loop {
            if lease.is_lost() || lease.is_cancel_requested() || shutdown.is_cancelled() {
                return Ok(None);
            }
            let current = self.client.get_task(task_id).await?;
            if current.state.is_terminal() {
                return Ok(None);
            }
            if current.state == somework_core::fsm::TaskState::Running {
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        let mut fresh = vec![];
        if let Some(conv) = task["conversationId"].as_str() {
            let page = self.client.get(&format!("/v1/conversations/{conv}/messages?limit=200")).await?;
            for m in page["messages"].as_array().cloned().unwrap_or_default() {
                if m["type"] == "task.input" && m["taskId"] == task_id {
                    let id = m["messageId"].as_str().unwrap_or_default().to_string();
                    if seen.insert(id) {
                        fresh.push(m["content"]["data"]["data"].clone());
                    }
                }
            }
        }
        Ok(Some(fresh))
    }

    /// Forwards agent events: progress is throttled into durable checkpoints, chunks go to ephemeral streaming.
    fn pump_events(&self, task_id: String, fence: u64, mut rx: mpsc::UnboundedReceiver<AdapterEvent>) -> impl std::future::Future<Output = ()> + use<> {
        let client = self.client.clone();
        let throttle = Duration::from_millis(self.cfg.progress_throttle_ms);
        let publisher = self.stream.lock().expect("stream slot").clone();
        async move {
            let mut pending: Option<Value> = None;
            let mut last_sent = tokio::time::Instant::now() - throttle;
            loop {
                let wait = if pending.is_some() { throttle.saturating_sub(last_sent.elapsed()) } else { Duration::from_secs(3600) };
                tokio::select! {
                    event = rx.recv() => match event {
                        Some(AdapterEvent::Progress { message, checkpoint, percent }) => {
                            pending = Some(json!({"fencingToken": fence, "message": message, "checkpoint": checkpoint, "percent": percent}));
                        }
                        Some(AdapterEvent::Chunk { kind, text }) => {
                            if let Some(p) = &publisher {
                                p.publish(&task_id, fence, &kind, &text).await;
                            }
                        }
                        None => break,
                    },
                    _ = tokio::time::sleep(wait), if pending.is_some() => {}
                }
                if pending.is_some()
                    && last_sent.elapsed() >= throttle
                    && let Some(body) = pending.take()
                {
                    let _ = client.progress_task(&task_id, &body).await;
                    last_sent = tokio::time::Instant::now();
                }
            }
            if let Some(body) = pending.take() {
                let _ = client.progress_task(&task_id, &body).await;
            }
        }
    }

    async fn commit_result(&self, task_id: &str, fence: u64, result: Value, artifacts: Vec<Value>) -> Result<(), ClientError> {
        let body = json!({"fencingToken": fence, "result": result, "artifacts": artifacts});
        for attempt in 0..5u32 {
            match self.client.post(&format!("/v1/tasks/{task_id}/complete"), &body).await {
                Ok(_) => return Ok(()),
                Err(e) if e.code == ErrorCode::SchemaViolation || e.code == ErrorCode::ArtifactNotReady || e.code == ErrorCode::IntegrityFailure => {
                    let failure = Failure { code: "invalid_result".into(), message: e.message.clone(), retryable: false, details: e.details.clone() };
                    return self.commit_failure(task_id, fence, failure).await;
                }
                Err(e) if is_lease_loss(e.code) => {
                    tracing::warn!(task = task_id, code = ?e.code, "result discarded: lease no longer held");
                    return Ok(());
                }
                Err(e) if e.is_retryable() => tokio::time::sleep(Duration::from_millis(200 * 2u64.pow(attempt))).await,
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    async fn commit_failure(&self, task_id: &str, fence: u64, failure: Failure) -> Result<(), ClientError> {
        for attempt in 0..5u32 {
            match self.client.fail_task(task_id, fence, &failure).await {
                Ok(_) => return Ok(()),
                Err(e) if is_lease_loss(e.code) => return Ok(()),
                Err(e) if e.is_retryable() => tokio::time::sleep(Duration::from_millis(200 * 2u64.pow(attempt))).await,
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    async fn handle_message(&self, message_id: &str, shutdown: CancellationToken) {
        let Ok(message) = self.client.get(&format!("/v1/messages/{message_id}")).await else { return };
        if message["sender"]["id"].as_str() == Some(self.agent_id.as_str()) {
            return; // own-origin messages never wake the agent
        }
        let job = Job {
            kind: "message".into(),
            task: Value::Null,
            capability: Value::Null,
            context_packs: vec![],
            inputs: vec![],
            fencing_token: 0,
            runtime_instance_id: self.runtime_id.clone(),
            message: Some(message.clone()),
        };
        let (tx, _rx) = mpsc::unbounded_channel();
        let reply = self.adapter.on_message(job, JobCtl { events: tx, cancel: shutdown }).await;
        let _ = self.client.post("/v1/messages/read", &json!({"messageIds": [message_id]})).await;
        if let (Some(text), Some(conv), Some(sender)) = (reply, message["conversationId"].as_str(), message["sender"].as_object()) {
            let recipient = json!({"kind": sender["kind"], "id": sender["id"]});
            let _ = self
                .client
                .send_message(&json!({"type": "chat.message", "conversationId": conv, "recipients": [recipient], "content": {"mediaType": "text/plain", "data": text}, "causationId": message_id, "idempotencyKey": format!("reply:{message_id}")}))
                .await;
        }
    }
}
