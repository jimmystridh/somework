//! Ephemeral streaming (STR-01) and presence over core NATS. Chunks are never the source of truth: consumers
//! recover the current state from the domain snapshot (STR-02).

use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::json;
use somework_core::subjects;

pub struct StreamPublisher {
    client: async_nats::Client,
    runtime_instance_id: String,
    seq: AtomicU64,
}

impl StreamPublisher {
    pub fn new(client: async_nats::Client, runtime_instance_id: String) -> Self {
        Self { client, runtime_instance_id, seq: AtomicU64::new(0) }
    }

    pub async fn publish(&self, task_id: &str, fencing_token: u64, kind: &str, text: &str) {
        let subject = if kind == "tool" { subjects::stream_task_tool(task_id) } else { subjects::stream_task_text(task_id) };
        let payload = json!({"taskId": task_id, "runtimeInstanceId": self.runtime_instance_id, "fencingToken": fencing_token, "seq": self.seq.fetch_add(1, Ordering::Relaxed), "kind": kind, "text": text});
        let _ = self.client.publish(subject, payload.to_string().into()).await;
    }

    pub async fn presence(&self, agent_id: &str) {
        let payload = json!({"agentId": agent_id, "runtimeInstanceId": self.runtime_instance_id, "at": chrono::Utc::now().to_rfc3339()});
        let _ = self.client.publish(subjects::presence(agent_id), payload.to_string().into()).await;
    }
}
