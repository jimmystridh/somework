use std::{pin::Pin, time::Duration};

use futures::Stream;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use somework_domain::Ctx;
use tonic::{Request, Response, Status};

use super::{
    call_ctx, convert as c, fail, invalid,
    json::{Doc, json_to_struct, pb_to_json},
    pb, respond,
};
use crate::state::AppState;

fn from_doc<T: DeserializeOwned>(ctx: &Ctx, doc: Value) -> Result<T, Status> {
    serde_json::from_value(doc).map_err(|e| invalid(ctx, format!("invalid request: {e}")))
}

fn to_json<T: Serialize>(ctx: &Ctx, value: &T) -> Result<Value, Status> {
    serde_json::to_value(value).map_err(|e| fail(ctx, somework_core::Error::internal(format!("serialize response: {e}"))))
}

/// Same value REST puts in `traceId`.
fn tid(ctx: &Ctx) -> String {
    ctx.trace.traceparent()
}

pub struct Catalog(pub AppState);
pub struct Messages(pub AppState);
pub struct Events(pub AppState);
pub struct Artifacts(pub AppState);
pub struct Subscriptions(pub AppState);

// ---- catalog --------------------------------------------------------------------------------------------------------

#[tonic::async_trait]
impl pb::catalog_service_server::CatalogService for Catalog {
    async fn search(&self, req: Request<pb::SearchRequest>) -> Result<Response<pb::SearchResponse>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let r = req.into_inner();
        let constraints = r.constraints.map(|k| {
            Doc::new()
                .str("sideEffectsAtMost", &k.side_effects_at_most)
                .str("dataClassification", &k.data_classification)
                .strs("allowedDomains", &k.allowed_domains)
                .build()
        });
        let doc = Doc::new()
            .str("query", &r.query)
            .strs("requiredCapabilities", &r.required_capabilities)
            .strs("tags", &r.tags)
            .structure("input", r.input)
            .structure("inputSchema", r.input_schema)
            .structure("outputSchema", r.output_schema)
            .raw("constraints", constraints.unwrap_or(Value::Null))
            .strs("availability", &r.availability)
            .strs("trustTiers", &r.trust_tiers)
            .u64("limit", r.limit as u64)
            .build();
        let out = self.0.domain.search_catalog(&ctx, from_doc(&ctx, doc)?).await.map_err(|e| fail(&ctx, e))?;
        let v = to_json(&ctx, &out)?;
        let matches = v["matches"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|m| pb::SearchMatch {
                entry_id: c::str_of(m, "entryId"),
                agent_id: c::str_of(m, "agentId"),
                domain_id: c::str_of(m, "domainId"),
                score: m["score"].as_f64().unwrap_or_default(),
                availability: c::str_of(m, "availability"),
                matched_capabilities: m["matchedCapabilities"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .map(|k| pb::CapabilityRef { id: c::str_of(k, "id"), version: c::str_of(k, "version") })
                    .collect(),
                why: c::strings_of(m, "why"),
            })
            .collect();
        Ok(respond(&ctx, pb::SearchResponse { matches, trace_id: tid(&ctx) }))
    }

    async fn get_agent(&self, req: Request<pb::GetAgentRequest>) -> Result<Response<pb::GetAgentResponse>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let r = req.into_inner();
        let out = self.0.domain.get_agent(&ctx, &r.agent_id).await.map_err(|e| fail(&ctx, e))?;
        let v = to_json(&ctx, &out)?;
        Ok(respond(
            &ctx,
            pb::GetAgentResponse {
                entry_id: c::str_of(&v, "entryId"),
                agent_id: v.pointer("/agentCard/agentId").and_then(Value::as_str).unwrap_or_default().into(),
                entry: json_to_struct(&v),
                trace_id: tid(&ctx),
            },
        ))
    }

    async fn get_capability(&self, req: Request<pb::GetCapabilityRequest>) -> Result<Response<pb::GetCapabilityResponse>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let r = req.into_inner();
        let out = self.0.domain.get_capability(&ctx, &r.id, &r.version).await.map_err(|e| fail(&ctx, e))?;
        Ok(respond(&ctx, pb::GetCapabilityResponse { capability: json_to_struct(&to_json(&ctx, &out)?), trace_id: tid(&ctx) }))
    }
}

// ---- messages -------------------------------------------------------------------------------------------------------

#[tonic::async_trait]
impl pb::message_service_server::MessageService for Messages {
    async fn send(&self, req: Request<pb::SendMessageRequest>) -> Result<Response<pb::MessageRecord>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let r = req.into_inner();
        let content = match r.data {
            Some(data) => {
                let media = if r.media_type.is_empty() { "application/json".to_string() } else { r.media_type.clone() };
                json!({"mediaType": media, "data": pb_to_json(data)})
            }
            None if !r.media_type.is_empty() => json!({"mediaType": r.media_type, "data": null}),
            None => Value::Null,
        };
        let doc = Doc::new()
            .str("type", &r.r#type)
            .str("messageId", &r.message_id)
            .str("conversationId", &r.conversation_id)
            .raw("recipients", c::members(r.recipients))
            .raw("content", content)
            .str("correlationId", &r.correlation_id)
            .str("causationId", &r.causation_id)
            .str("replyTo", &r.reply_to)
            .str("expiresAt", &r.expires_at)
            .str("priority", &r.priority)
            .str("triggerMode", &r.trigger_mode)
            .structs("artifacts", r.artifacts)
            .map("labels", r.labels)
            .str("idempotencyKey", &r.idempotency_key)
            .build();
        let out = self.0.domain.send_message(&ctx, from_doc(&ctx, doc)?).await.map_err(|e| fail(&ctx, e))?;
        Ok(respond(&ctx, c::message_record(&to_json(&ctx, &out)?, &tid(&ctx))))
    }

    async fn list(&self, req: Request<pb::ListMessagesRequest>) -> Result<Response<pb::ListMessagesResponse>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let r = req.into_inner();
        let out = self.0.domain.list_messages(&ctx, &r.conversation_id, r.cursor, if r.limit == 0 { 50 } else { r.limit }).await.map_err(|e| fail(&ctx, e))?;
        let v = to_json(&ctx, &out)?;
        let trace = tid(&ctx);
        let messages = v["messages"].as_array().cloned().unwrap_or_default().iter().map(|m| c::message_record(m, &trace)).collect();
        Ok(respond(
            &ctx,
            pb::ListMessagesResponse {
                messages,
                next_cursor: v["nextCursor"].as_i64().unwrap_or_default(),
                has_more: !v["nextCursor"].is_null(),
                trace_id: trace,
            },
        ))
    }
}

// ---- events ---------------------------------------------------------------------------------------------------------

type BoxStream<T> = Pin<Box<dyn Stream<Item = Result<T, Status>> + Send + 'static>>;

#[tonic::async_trait]
impl pb::event_service_server::EventService for Events {
    type WatchStream = BoxStream<pb::Event>;

    async fn watch(&self, req: Request<pb::WatchEventsRequest>) -> Result<Response<Self::WatchStream>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let r = req.into_inner();
        let mut cursor = if r.from_start {
            0
        } else if r.after != 0 {
            r.after
        } else {
            self.0.domain.event_cursor(&ctx).await.map_err(|e| fail(&ctx, e))?
        };
        let limit = if r.limit == 0 { 100 } else { r.limit };
        let domain = self.0.domain.clone();
        let response_ctx = ctx.clone();
        let stream = async_stream::stream! {
            loop {
                match domain.watch_events(&ctx, cursor, limit, Duration::from_secs(20)).await {
                    Ok(events) => {
                        for e in events {
                            cursor = cursor.max(e.seq);
                            match serde_json::to_value(&e) {
                                Ok(v) => yield Ok(c::event(&v)),
                                Err(err) => { yield Err(fail(&ctx, somework_core::Error::internal(err.to_string()))); return; }
                            }
                        }
                    }
                    Err(err) => { yield Err(fail(&ctx, err)); return; }
                }
            }
        };
        Ok(respond(&response_ctx, Box::pin(stream) as Self::WatchStream))
    }

    async fn ack(&self, req: Request<pb::AckEventsRequest>) -> Result<Response<pb::AckEventsResponse>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let r = req.into_inner();
        self.0.domain.ack_events(&ctx, r.cursor).await.map_err(|e| fail(&ctx, e))?;
        Ok(respond(&ctx, pb::AckEventsResponse { cursor: r.cursor, trace_id: tid(&ctx) }))
    }

    async fn publish(&self, req: Request<pb::PublishEventRequest>) -> Result<Response<pb::PublishEventResponse>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let r = req.into_inner();
        let doc = Doc::new()
            .str("topic", &r.topic)
            .str("key", &r.key)
            .str("source", &r.source)
            .structure("data", r.data)
            .str("classification", &r.classification)
            .opt_bool("verified", r.verified)
            .str("occurredAt", &r.occurred_at)
            .build();
        let out = self.0.domain.publish_event(&ctx, from_doc(&ctx, doc)?).await.map_err(|e| fail(&ctx, e))?;
        Ok(respond(&ctx, pb::PublishEventResponse { seq: out.seq, event_id: out.event_id, duplicate: out.duplicate, trace_id: tid(&ctx) }))
    }
}

// ---- artifacts ------------------------------------------------------------------------------------------------------

#[tonic::async_trait]
impl pb::artifact_service_server::ArtifactService for Artifacts {
    async fn begin_upload(&self, req: Request<pb::BeginUploadRequest>) -> Result<Response<pb::UploadGrant>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let r = req.into_inner();
        let doc = Doc::new()
            .str("artifactId", &r.artifact_id)
            .str("filename", &r.filename)
            .str("mediaType", &r.media_type)
            .u64("sizeBytes", r.size_bytes)
            .str("sha256", &r.sha256)
            .str("classification", &r.classification)
            .structure("provenance", r.provenance)
            .str("expiresAt", &r.expires_at)
            .str("conversationId", &r.conversation_id)
            .build();
        let out = self.0.domain.begin_artifact_upload(&ctx, from_doc(&ctx, doc)?).await.map_err(|e| fail(&ctx, e))?;
        let v = to_json(&ctx, &out)?;
        let headers =
            v["headers"].as_object().map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string())).collect()).unwrap_or_default();
        Ok(respond(
            &ctx,
            pb::UploadGrant {
                artifact_id: c::str_of(&v, "artifactId"),
                version: c::u64_of(&v, "version"),
                uri: c::str_of(&v, "uri"),
                expires_at: c::str_of(&v, "expiresAt"),
                method: c::str_of(&v, "method"),
                url: c::str_of(&v, "url"),
                headers,
                multipart: c::structure(&v, "multipart"),
                trace_id: tid(&ctx),
            },
        ))
    }

    async fn complete_upload(&self, req: Request<pb::CompleteUploadRequest>) -> Result<Response<pb::ArtifactMetadata>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let r = req.into_inner();
        let parts: Vec<Value> = r.parts.into_iter().map(|p| json!({"partNumber": p.part_number, "etag": p.etag})).collect();
        let doc = Doc::new().u64("version", r.version).raw("parts", Value::Array(parts)).build();
        let out = self.0.domain.complete_artifact_upload(&ctx, &r.artifact_id, from_doc(&ctx, doc)?).await.map_err(|e| fail(&ctx, e))?;
        Ok(respond(&ctx, c::artifact(&to_json(&ctx, &out)?, &tid(&ctx))))
    }

    async fn get_metadata(&self, req: Request<pb::GetArtifactRequest>) -> Result<Response<pb::ArtifactMetadata>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let r = req.into_inner();
        let out = self.0.domain.get_artifact(&ctx, &r.artifact_id, r.version).await.map_err(|e| fail(&ctx, e))?;
        Ok(respond(&ctx, c::artifact(&to_json(&ctx, &out)?, &tid(&ctx))))
    }

    async fn get_download(&self, req: Request<pb::GetDownloadRequest>) -> Result<Response<pb::DownloadGrant>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let r = req.into_inner();
        let out = self.0.domain.artifact_download_grant(&ctx, &r.artifact_id, r.version).await.map_err(|e| fail(&ctx, e))?;
        let v = to_json(&ctx, &out)?;
        let trace = tid(&ctx);
        Ok(respond(
            &ctx,
            pb::DownloadGrant {
                artifact: Some(c::artifact(&v["artifact"], &trace)),
                url: c::str_of(&v, "url"),
                expires_at: c::str_of(&v, "expiresAt"),
                trace_id: trace,
            },
        ))
    }
}

// ---- subscriptions ------------------------------------------------------------------------------------

#[tonic::async_trait]
impl pb::subscription_service_server::SubscriptionService for Subscriptions {
    async fn create(&self, req: Request<pb::CreateSubscriptionRequest>) -> Result<Response<pb::Subscription>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let r = req.into_inner();
        let doc = Doc::new().str("kind", &r.kind).str("selector", &r.selector).opt_bool("wakeOnMatch", r.wake_on_match).build();
        let out = self.0.domain.create_subscription(&ctx, from_doc(&ctx, doc)?).await.map_err(|e| fail(&ctx, e))?;
        let v = to_json(&ctx, &out)?;
        Ok(respond(
            &ctx,
            pb::Subscription {
                subscription_id: c::str_of(&v, "subscriptionId"),
                kind: c::str_of(&v, "kind"),
                selector: c::str_of(&v, "selector"),
                wake_on_match: c::bool_of(&v, "wakeOnMatch"),
                status: c::str_of(&v, "status"),
                subject: c::str_of(&v, "subject"),
                trace_id: tid(&ctx),
            },
        ))
    }

    async fn delete(&self, req: Request<pb::DeleteSubscriptionRequest>) -> Result<Response<pb::DeleteSubscriptionResponse>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let r = req.into_inner();
        self.0.domain.delete_subscription(&ctx, &r.subscription_id).await.map_err(|e| fail(&ctx, e))?;
        Ok(respond(&ctx, pb::DeleteSubscriptionResponse { trace_id: tid(&ctx) }))
    }
}
