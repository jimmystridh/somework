use std::sync::Arc;

use futures::StreamExt;
use serde_json::Value;
use somework_core::ids::decode_subject_token;
use tokio_util::sync::CancellationToken;

use crate::plane::NatsPlane;

/// Refreshes runtime liveness from `somework.presence.<agent>` signals. Unregistered runtimes and signals whose
/// payload disagrees with the subject are ignored: presence is a hint, never an identity.
pub fn spawn_presence_listener(plane: Arc<NatsPlane>, shutdown: CancellationToken) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let Ok(mut sub) = plane.client.subscribe(somework_core::subjects::PRESENCE_FILTER).await else { return };
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => break,
                msg = sub.next() => {
                    let Some(msg) = msg else { break };
                    let Ok(payload) = serde_json::from_slice::<Value>(&msg.payload) else { continue };
                    let (Some(agent), Some(runtime)) = (payload["agentId"].as_str(), payload["runtimeInstanceId"].as_str()) else { continue };
                    let token = msg.subject.as_str().rsplit('.').next().unwrap_or_default();
                    if decode_subject_token(token).as_deref() != Some(agent) {
                        continue;
                    }
                    let _ = plane.domain.touch_runtime(agent, runtime).await;
                }
            }
        }
    })
}
