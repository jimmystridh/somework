use async_trait::async_trait;
use serde_json::Value;
use somework_core::Error;

/// Transport connection details handed to an authenticated workload (the sidecar). It never carries Matrix or
/// object-store credentials; for NATS it carries only credentials scoped to that agent's own subjects.
#[async_trait]
pub trait ConnectionProvider: Send + Sync + 'static {
    async fn connection_info(&self, ctx: &crate::Ctx) -> Result<Value, Error>;
}
