use std::{collections::HashMap, sync::Arc, time::Duration};

use async_nats::jetstream::consumer::pull;
use tokio_util::sync::CancellationToken;

use crate::plane::NatsPlane;

/// Periodically mirrors JetStream consumer state into `jetstream_consumer_lag` / `jetstream_redelivery_count`.
pub fn spawn_metrics_loop(plane: Arc<NatsPlane>, shutdown: CancellationToken) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut redelivered: HashMap<String, usize> = HashMap::new();
        let interval = Duration::from_millis(plane.cfg.metrics_interval_ms);
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => break,
                _ = tokio::time::sleep(interval) => {},
            }
            if !plane.is_connected() {
                continue;
            }
            for key in plane.known_consumers() {
                let Ok(stream) = plane.js.get_stream(key.stream).await else { continue };
                let Ok(mut consumer) = stream.get_consumer::<pull::Config>(&key.name).await else { continue };
                let Ok(info) = consumer.info().await else { continue };
                plane
                    .domain
                    .metrics
                    .jetstream_consumer_lag
                    .with_label_values(&[key.stream, key.name.as_str()])
                    .set((info.num_pending as i64) + info.num_ack_pending as i64);
                let id = format!("{}/{}", key.stream, key.name);
                let previous = redelivered.insert(id, info.num_redelivered).unwrap_or(0);
                if info.num_redelivered > previous {
                    plane.domain.metrics.jetstream_redelivery_count.inc_by((info.num_redelivered - previous) as u64);
                }
            }
        }
    })
}
