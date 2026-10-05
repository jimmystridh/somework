use async_trait::async_trait;
use serde_json::Value;
use somework_core::Error;

/// Live task output (ephemeral core NATS streaming, STR-01). Provided by the NATS plane when configured.
#[async_trait]
pub trait StreamSource: Send + Sync + 'static {
    /// Subscribes to the ephemeral stream of `task_id`. Chunks carry `seq`, `fencingToken`, `kind` and `text`.
    async fn subscribe(&self, task_id: &str) -> Result<futures::stream::BoxStream<'static, Value>, Error>;
}

/// Transport connection details handed to an authenticated workload (the sidecar). It never carries Matrix or
/// object-store credentials; for NATS it carries only credentials scoped to that agent's own subjects.
#[async_trait]
pub trait ConnectionProvider: Send + Sync + 'static {
    async fn connection_info(&self, ctx: &crate::Ctx) -> Result<Value, Error>;
}
