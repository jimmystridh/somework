#![allow(dead_code)]

use std::time::Duration;

use async_nats::jetstream::{self, consumer::pull};
use futures::StreamExt;
use serde_json::{Value, json};
use somework_core::{contracts::SideEffects, subjects};
use somework_domain::policy::Permissions;
use somework_testkit::{Agent, Stack, StackBuilder, capability, nats::NatsServer, process::eventually};

pub fn worker_perms(se: SideEffects) -> Permissions {
    let mut p = Permissions::default_agent();
    p.side_effects_at_most = Some(se);
    p
}

pub struct Env {
    pub nats: NatsServer,
    pub stack: Stack,
}

pub async fn start_env() -> Env {
    start_env_with(|_| {}).await
}

pub async fn start_env_with(tweak: impl FnOnce(&mut somework_nats::NatsConfig)) -> Env {
    let nats = NatsServer::start("development").await;
    let mut cfg = nats.plane_config();
    tweak(&mut cfg);
    let stack = StackBuilder::new().config(|c| c.nats = Some(cfg)).start().await;
    Env { nats, stack }
}

pub fn review_cap() -> Value {
    capability("code.review", "2.1", "read", "Review pull requests for correctness and security")
}

pub async fn reviewer(stack: &Stack, id: &str) -> Agent {
    stack.worker(id, vec![review_cap()], worker_perms(SideEffects::Read)).await
}

pub fn submit_body() -> Value {
    json!({"capability": {"id": "code.review", "version": "2.1"}, "input": {"repository": "billing/import-service", "commit": "61a8d52"}})
}

/// An agent's own, scoped NATS connection obtained exactly like a sidecar would: `GET /v1/connection`.
pub struct AgentNats {
    pub client: async_nats::Client,
    pub js: jetstream::Context,
    pub info: Value,
    pub events: tokio::sync::mpsc::UnboundedReceiver<String>,
}

pub async fn connect_agent(agent: &Agent) -> AgentNats {
    let info = agent.client.get("/v1/connection").await.expect("connection info");
    let nats = &info["nats"];
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let client = async_nats::ConnectOptions::with_user_and_password(nats["user"].as_str().unwrap().into(), nats["password"].as_str().unwrap().into())
        .event_callback(move |ev| {
            let tx = tx.clone();
            async move {
                if let async_nats::Event::ServerError(e) = &ev {
                    let _ = tx.send(e.to_string());
                }
            }
        })
        .connect(nats["url"].as_str().unwrap())
        .await
        .expect("agent nats connect");
    let js = jetstream::new(client.clone());
    AgentNats { client, js, info, events: rx }
}

impl AgentNats {
    pub async fn consumer(&self, stream: &str, name: &str) -> jetstream::consumer::Consumer<pull::Config> {
        // streams and consumers are provisioned asynchronously after the server starts accepting requests
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            let attempt = async { self.js.get_stream(stream).await.ok()?.get_consumer(name).await.ok() }.await;
            match attempt {
                Some(consumer) => return consumer,
                None if tokio::time::Instant::now() < deadline => tokio::time::sleep(std::time::Duration::from_millis(100)).await,
                None => panic!("stream {stream} / consumer {name} were never provisioned"),
            }
        }
    }

    pub async fn pool_consumer(&self) -> jetstream::consumer::Consumer<pull::Config> {
        let pool = &self.info["nats"]["poolConsumers"][0];
        self.consumer(pool["stream"].as_str().unwrap(), pool["consumer"].as_str().unwrap()).await
    }

    pub async fn inbox_consumer(&self) -> jetstream::consumer::Consumer<pull::Config> {
        let n = &self.info["nats"];
        self.consumer(n["inboxStream"].as_str().unwrap(), n["inboxConsumer"].as_str().unwrap()).await
    }

    pub async fn subscription_consumer(&self) -> jetstream::consumer::Consumer<pull::Config> {
        let n = &self.info["nats"];
        self.consumer(n["subscriptionStream"].as_str().unwrap(), n["subscriptionConsumer"].as_str().unwrap()).await
    }
}

/// Pulls the next message from `consumer`, polling until `timeout`.
pub async fn next_message(consumer: &jetstream::consumer::Consumer<pull::Config>, timeout: Duration) -> Option<(jetstream::Message, Value)> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return None;
        }
        let mut batch = consumer.fetch().max_messages(1).expires(Duration::from_millis(500)).messages().await.ok()?;
        if let Some(Ok(msg)) = batch.next().await {
            let payload = serde_json::from_slice(&msg.payload).unwrap_or(Value::Null);
            return Some((msg, payload));
        }
    }
}

pub async fn drain(consumer: &jetstream::consumer::Consumer<pull::Config>, timeout: Duration) -> Vec<Value> {
    let mut out = vec![];
    while let Some((msg, payload)) = next_message(consumer, timeout).await {
        msg.ack().await.ok();
        out.push(payload);
    }
    out
}

pub async fn outbox_pending(stack: &Stack, sink: &str) -> i64 {
    let v = stack.admin.get("/v1/admin/outbox").await.expect("outbox stats");
    v["sinks"]
        .as_array()
        .and_then(|a| a.iter().find(|s| s["sink"] == sink))
        .map(|s| s["pending"].as_i64().unwrap_or(0) + s["failed"].as_i64().unwrap_or(0))
        .unwrap_or(0)
}

pub async fn wait_outbox_empty(stack: &Stack, sink: &str) {
    eventually("outbox drained", Duration::from_secs(15), || async { (outbox_pending(stack, sink).await == 0).then_some(()) }).await;
}

pub fn pool_filter(info: &Value) -> String {
    info["nats"]["poolConsumers"][0]["filter"].as_str().unwrap().to_string()
}

pub fn expected_pool_subject(agent_id: &str) -> String {
    subjects::work_pool(agent_id)
}
