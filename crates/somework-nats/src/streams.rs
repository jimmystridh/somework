//! Ephemeral core-NATS streaming (STR-01): token/tool chunks never touch the database, and a consumer that
//! misses them recovers from the durable task snapshot (STR-02).

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use async_trait::async_trait;
use bytes::Bytes;
use futures::{StreamExt, stream::BoxStream};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use somework_core::{Error, ids::subject_token, subjects};
use somework_domain::{Domain, directory::TaskFence, streams::StreamSource};

use crate::plane::NatsPlane;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChunkKind {
    Text,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamChunk {
    pub task_id: String,
    pub runtime_instance_id: String,
    pub fencing_token: u64,
    pub seq: u64,
    pub kind: ChunkKind,
    pub text: String,
}

/// Used by sidecars (connected with their scoped agent credentials) to emit live progress.
pub struct ChunkPublisher {
    client: async_nats::Client,
}

impl ChunkPublisher {
    pub fn new(client: async_nats::Client) -> Self {
        Self { client }
    }

    pub async fn publish(&self, chunk: &StreamChunk) -> Result<(), Error> {
        let subject = match chunk.kind {
            ChunkKind::Text => subjects::stream_task_text(&chunk.task_id),
            ChunkKind::Tool => subjects::stream_task_tool(&chunk.task_id),
        };
        let payload = serde_json::to_vec(chunk)?;
        self.client.publish(subject, Bytes::from(payload)).await.map_err(|e| Error::unavailable(format!("publish chunk: {e}")))
    }
}

pub struct NatsStreamSource {
    plane: Arc<NatsPlane>,
}

impl NatsStreamSource {
    pub fn new(plane: Arc<NatsPlane>) -> Self {
        Self { plane }
    }
}

struct FenceCache {
    domain: Domain,
    task_id: String,
    cached: Mutex<Option<(Instant, Option<TaskFence>)>>,
}

impl FenceCache {
    async fn current(&self) -> Option<TaskFence> {
        if let Some((at, fence)) = self.cached.lock().as_ref()
            && at.elapsed() < Duration::from_millis(250)
        {
            return fence.clone();
        }
        let fence = self.domain.task_fence(&self.task_id).await.ok().flatten();
        *self.cached.lock() = Some((Instant::now(), fence.clone()));
        fence
    }
}

#[async_trait]
impl StreamSource for NatsStreamSource {
    async fn subscribe(&self, task_id: &str) -> Result<BoxStream<'static, Value>, Error> {
        let subject = format!("somework.stream.task.{}.>", subject_token(task_id));
        let sub = self.plane.client.subscribe(subject).await.map_err(|e| Error::unavailable(format!("subscribe: {e}")))?;
        let cache = Arc::new(FenceCache { domain: self.plane.domain.clone(), task_id: task_id.to_string(), cached: Mutex::new(None) });
        let task_id = task_id.to_string();
        let stream = sub.filter_map(move |msg| {
            let cache = cache.clone();
            let task_id = task_id.clone();
            async move {
                let chunk: Value = serde_json::from_slice(&msg.payload).ok()?;
                if chunk["taskId"].as_str() != Some(task_id.as_str()) {
                    return None;
                }
                // chunks from a worker that lost its lease (or never held it) are dropped, whatever subject they used
                let fence = cache.current().await?;
                let leased = matches!(fence.state.as_str(), "claimed" | "running" | "input_required" | "blocked" | "cancel_requested");
                let fence_ok = chunk["fencingToken"].as_i64() == Some(fence.fencing_token);
                let runtime_ok = fence.runtime_instance_id.as_deref() == chunk["runtimeInstanceId"].as_str();
                if !(leased && fence_ok && runtime_ok) {
                    return None;
                }
                Some(json!({
                    "taskId": task_id,
                    "seq": chunk["seq"],
                    "fencingToken": chunk["fencingToken"],
                    "runtimeInstanceId": chunk["runtimeInstanceId"],
                    "kind": chunk["kind"],
                    "text": chunk["text"],
                }))
            }
        });
        Ok(stream.boxed())
    }
}
