use async_nats::{HeaderMap, jetstream};
use async_trait::async_trait;
use bytes::Bytes;
use somework_core::subjects;
use somework_domain::outbox::{OutboxItem, OutboxSink, SinkError};

/// Publishes outbox rows to JetStream with `Nats-Msg-Id = dedupe_key`, so a retry after a lost ack is
/// absorbed by the stream's duplicate window instead of creating a second message (DEL-02).
pub struct NatsSink {
    js: jetstream::Context,
}

impl NatsSink {
    pub fn new(js: jetstream::Context) -> Self {
        Self { js }
    }
}

#[async_trait]
impl OutboxSink for NatsSink {
    fn name(&self) -> &'static str {
        somework_domain::config::SINK_NATS
    }

    async fn deliver(&self, item: &OutboxItem) -> Result<(), SinkError> {
        self.deliver_batch(std::slice::from_ref(item)).await.remove(0)
    }

    async fn deliver_batch(&self, items: &[OutboxItem]) -> Vec<Result<(), SinkError>> {
        let mut pending = Vec::with_capacity(items.len());
        for item in items {
            if subjects::stream_for_subject(&item.subject).is_none() {
                pending.push(Err(SinkError::permanent(format!("subject {} is not mapped to a JetStream stream", item.subject))));
                continue;
            }
            let mut headers = HeaderMap::new();
            headers.insert("Nats-Msg-Id", item.dedupe_key.as_str());
            let payload = Bytes::from(item.payload.to_string());
            match self.js.publish_with_headers(item.subject.clone(), headers, payload).await {
                Ok(ack) => pending.push(Ok(ack)),
                Err(e) => pending.push(Err(SinkError::transient(format!("publish: {e}")))),
            }
        }
        let mut out = Vec::with_capacity(pending.len());
        for p in pending {
            out.push(match p {
                Err(e) => Err(e),
                Ok(ack) => match ack.await {
                    Ok(_) => Ok(()),
                    Err(e) => Err(SinkError::transient(format!("jetstream ack: {e}"))),
                },
            });
        }
        out
    }
}
