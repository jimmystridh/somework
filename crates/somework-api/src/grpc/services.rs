use std::{pin::Pin, time::Duration};

use futures::Stream;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use somework_domain::Ctx;
use tonic::{Request, Response, Status};

use super::{
    call_ctx, convert as c, fail, invalid,
    json::{Doc, json_to_struct, pb_to_json, struct_to_json},
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

fn some_struct(v: Option<prost_types::Struct>) -> Option<Value> {
    v.map(struct_to_json)
}

pub struct Catalog(pub AppState);
pub struct Messages(pub AppState);
pub struct Events(pub AppState);
pub struct Tasks(pub AppState);
pub struct Contexts(pub AppState);
pub struct Artifacts(pub AppState);
pub struct Subscriptions(pub AppState);
pub struct Authorization(pub AppState);

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
            .str("taskId", &r.task_id)
            .raw("recipients", c::members(r.recipients))
            .raw("content", content)
            .str("correlationId", &r.correlation_id)
            .str("causationId", &r.causation_id)
            .str("replyTo", &r.reply_to)
            .str("expiresAt", &r.expires_at)
            .str("priority", &r.priority)
            .str("triggerMode", &r.trigger_mode)
            .structs("artifacts", r.artifacts)
            .raw("contextRefs", c::context_refs(r.context_refs))
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
}

// ---- tasks ----------------------------------------------------------------------------------------------------------

fn failure_doc(f: Option<pb::Failure>) -> Value {
    match f {
        Some(f) => {
            let mut o = json!({"code": f.code, "message": f.message, "retryable": f.retryable});
            if let Some(d) = f.details {
                o["details"] = struct_to_json(d);
            }
            o
        }
        None => Value::Null,
    }
}

#[tonic::async_trait]
impl pb::task_service_server::TaskService for Tasks {
    type WatchStream = BoxStream<pb::TaskUpdate>;

    async fn submit(&self, req: Request<pb::SubmitTaskRequest>) -> Result<Response<pb::SubmitTaskResponse>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let r = req.into_inner();
        let doc = Doc::new()
            .raw("capability", r.capability.map(|k| json!({"id": k.id, "version": k.version})).unwrap_or(Value::Null))
            .str("targetAgentId", &r.target_agent_id)
            .str("conversationId", &r.conversation_id)
            .str("parentTaskId", &r.parent_task_id)
            .opt_u64("parentFencingToken", r.parent_fencing_token)
            .structure("input", r.input)
            .raw("contextRefs", c::context_refs(r.context_refs))
            .str("deadlineAt", &r.deadline_at)
            .structure("constraints", r.constraints)
            .build();
        let out = self.0.domain.submit_task(&ctx, from_doc(&ctx, doc)?).await.map_err(|e| fail(&ctx, e))?;
        let v = to_json(&ctx, &out)?;
        Ok(respond(&ctx, pb::SubmitTaskResponse { task: Some(c::task(&v)), approval_id: c::str_of(&v, "approvalId"), trace_id: tid(&ctx) }))
    }

    async fn get(&self, req: Request<pb::GetTaskRequest>) -> Result<Response<pb::TaskResponse>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let r = req.into_inner();
        let out = self.0.domain.get_task(&ctx, &r.task_id).await.map_err(|e| fail(&ctx, e))?;
        Ok(respond(&ctx, pb::TaskResponse { task: Some(c::task(&to_json(&ctx, &out)?)), trace_id: tid(&ctx) }))
    }

    async fn list_events(&self, req: Request<pb::ListTaskEventsRequest>) -> Result<Response<pb::ListTaskEventsResponse>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let r = req.into_inner();
        let out = self.0.domain.list_task_events(&ctx, &r.task_id, r.after, if r.limit == 0 { 200 } else { r.limit }).await.map_err(|e| fail(&ctx, e))?;
        let events = to_json(&ctx, &out)?.as_array().cloned().unwrap_or_default().iter().map(c::task_event).collect();
        Ok(respond(&ctx, pb::ListTaskEventsResponse { events, trace_id: tid(&ctx) }))
    }

    async fn claim(&self, req: Request<pb::ClaimTaskRequest>) -> Result<Response<pb::ClaimTaskResponse>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let r = req.into_inner();
        let doc = Doc::new().i64("leaseSeconds", r.lease_seconds).opt_u64("expectedRevision", r.expected_revision).build();
        let out = self.0.domain.claim_task(&ctx, &r.task_id, from_doc(&ctx, doc)?).await.map_err(|e| fail(&ctx, e))?;
        let v = to_json(&ctx, &out)?;
        Ok(respond(
            &ctx,
            pb::ClaimTaskResponse {
                task: Some(c::task(&v["task"])),
                lease: c::lease(&v["lease"]),
                fencing_token: c::u64_of(&v, "fencingToken"),
                authorization_token: c::str_of(&v, "authorizationToken"),
                capability: c::structure(&v, "capability"),
                authority: c::structure(&v, "authority"),
                trace_id: tid(&ctx),
            },
        ))
    }

    async fn heartbeat(&self, req: Request<pb::HeartbeatTaskRequest>) -> Result<Response<pb::HeartbeatTaskResponse>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let r = req.into_inner();
        let doc = Doc::new().u64("fencingToken", r.fencing_token).i64("leaseSeconds", r.lease_seconds).build();
        let out = self.0.domain.heartbeat_task(&ctx, &r.task_id, from_doc(&ctx, doc)?).await.map_err(|e| fail(&ctx, e))?;
        let v = to_json(&ctx, &out)?;
        Ok(respond(
            &ctx,
            pb::HeartbeatTaskResponse {
                lease: c::lease(&v["lease"]),
                state: c::task_state(&c::str_of(&v, "state")) as i32,
                revision: c::u64_of(&v, "revision"),
                cancel_requested: c::bool_of(&v, "cancelRequested"),
                authorization_token: c::str_of(&v, "authorizationToken"),
                trace_id: tid(&ctx),
            },
        ))
    }

    async fn progress(&self, req: Request<pb::ProgressTaskRequest>) -> Result<Response<pb::TaskResponse>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let r = req.into_inner();
        let mut doc = Doc::new()
            .u64("fencingToken", r.fencing_token)
            .opt_u64("expectedRevision", r.expected_revision)
            .str("message", &r.message)
            .structure("checkpoint", r.checkpoint)
            .f64("percent", r.percent)
            .structure("question", r.question)
            .strs("blockedOn", &r.blocked_on);
        if let Some(status) = c::progress_status(r.status) {
            doc = doc.str("status", status);
        }
        let out = self.0.domain.progress_task(&ctx, &r.task_id, from_doc(&ctx, doc.build())?).await.map_err(|e| fail(&ctx, e))?;
        Ok(respond(&ctx, pb::TaskResponse { task: Some(c::task(&to_json(&ctx, &out)?)), trace_id: tid(&ctx) }))
    }

    async fn provide_input(&self, req: Request<pb::ProvideInputRequest>) -> Result<Response<pb::TaskResponse>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let r = req.into_inner();
        let doc = Doc::new().structure("data", r.data).opt_u64("expectedRevision", r.expected_revision).build();
        let out = self.0.domain.provide_input(&ctx, &r.task_id, from_doc(&ctx, doc)?).await.map_err(|e| fail(&ctx, e))?;
        Ok(respond(&ctx, pb::TaskResponse { task: Some(c::task(&to_json(&ctx, &out)?)), trace_id: tid(&ctx) }))
    }

    async fn complete(&self, req: Request<pb::CompleteTaskRequest>) -> Result<Response<pb::TaskResponse>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let r = req.into_inner();
        let doc = Doc::new()
            .u64("fencingToken", r.fencing_token)
            .opt_u64("expectedRevision", r.expected_revision)
            .structure("result", r.result)
            .structs("artifacts", r.artifacts)
            .build();
        let out = self.0.domain.complete_task(&ctx, &r.task_id, from_doc(&ctx, doc)?).await.map_err(|e| fail(&ctx, e))?;
        Ok(respond(&ctx, pb::TaskResponse { task: Some(c::task(&to_json(&ctx, &out)?)), trace_id: tid(&ctx) }))
    }

    async fn fail(&self, req: Request<pb::FailTaskRequest>) -> Result<Response<pb::TaskResponse>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let r = req.into_inner();
        let doc =
            Doc::new().u64("fencingToken", r.fencing_token).opt_u64("expectedRevision", r.expected_revision).raw("failure", failure_doc(r.failure)).build();
        let out = self.0.domain.fail_task(&ctx, &r.task_id, from_doc(&ctx, doc)?).await.map_err(|e| super::fail(&ctx, e))?;
        Ok(respond(&ctx, pb::TaskResponse { task: Some(c::task(&to_json(&ctx, &out)?)), trace_id: tid(&ctx) }))
    }

    async fn cancel(&self, req: Request<pb::CancelTaskRequest>) -> Result<Response<pb::TaskResponse>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let r = req.into_inner();
        let doc = Doc::new()
            .opt_u64("expectedRevision", r.expected_revision)
            .str("reason", &r.reason)
            .bool("acknowledge", r.acknowledge)
            .u64("fencingToken", r.fencing_token)
            .build();
        let out = self.0.domain.cancel_task(&ctx, &r.task_id, from_doc(&ctx, doc)?).await.map_err(|e| super::fail(&ctx, e))?;
        Ok(respond(&ctx, pb::TaskResponse { task: Some(c::task(&to_json(&ctx, &out)?)), trace_id: tid(&ctx) }))
    }

    async fn watch(&self, req: Request<pb::WatchTaskRequest>) -> Result<Response<Self::WatchStream>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let task_id = req.into_inner().task_id;
        let domain = self.0.domain.clone();
        // Snapshot first (so authorization errors surface as the call's status), then follow new task events.
        let snapshot = domain.get_task(&ctx, &task_id).await.map_err(|e| fail(&ctx, e))?;
        let snapshot_json = to_json(&ctx, &snapshot)?;
        let snapshot_revision = c::u64_of(&snapshot_json, "revision");
        let terminal = snapshot.task.state.is_terminal();
        let first = pb::TaskUpdate { task: Some(c::task(&snapshot_json)), event: None, snapshot: true };
        let response_ctx = ctx.clone();
        let stream = async_stream::stream! {
            yield Ok(first);
            if terminal {
                return;
            }
            let mut after = 0i64;
            loop {
                let notified = domain.event_notify.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                let events = match domain.list_task_events(&ctx, &task_id, after, 200).await {
                    Ok(e) => e,
                    Err(err) => { yield Err(fail(&ctx, err)); return; }
                };
                let mut ended = false;
                for e in events {
                    after = after.max(e.event_sequence);
                    if (e.revision as u64) <= snapshot_revision {
                        continue;
                    }
                    let current = match domain.get_task(&ctx, &task_id).await {
                        Ok(t) => t,
                        Err(err) => { yield Err(fail(&ctx, err)); return; }
                    };
                    let (ev, task_json) = match (serde_json::to_value(&e), serde_json::to_value(&current)) {
                        (Ok(a), Ok(b)) => (a, b),
                        _ => { yield Err(fail(&ctx, somework_core::Error::internal("serialize task update"))); return; }
                    };
                    ended = current.task.state.is_terminal() && e.to_state.as_deref() == Some(current.task.state.as_str());
                    yield Ok(pb::TaskUpdate { task: Some(c::task(&task_json)), event: Some(c::task_event(&ev)), snapshot: false });
                }
                if ended {
                    return;
                }
                let _ = tokio::time::timeout(Duration::from_secs(1), notified).await;
            }
        };
        Ok(respond(&response_ctx, Box::pin(stream) as Self::WatchStream))
    }
}

// ---- context --------------------------------------------------------------------------------------------------------

#[tonic::async_trait]
impl pb::context_service_server::ContextService for Contexts {
    async fn create(&self, req: Request<pb::CreateContextPackRequest>) -> Result<Response<pb::ContextPackRecord>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let pack = some_struct(req.into_inner().pack).ok_or_else(|| invalid(&ctx, "pack is required"))?;
        let out = self.0.domain.create_context_pack(&ctx, pack).await.map_err(|e| fail(&ctx, e))?;
        let v = to_json(&ctx, &out)?;
        Ok(respond(
            &ctx,
            pb::ContextPackRecord {
                context_pack_id: c::str_of(&v, "contextPackId"),
                version: c::u64_of(&v, "version"),
                digest: c::str_of(&v, "digest"),
                classification: c::str_of(&v, "classification"),
                size_bytes: c::u64_of(&v, "sizeBytes"),
                created_at: c::str_of(&v, "createdAt"),
                trace_id: tid(&ctx),
            },
        ))
    }

    async fn get(&self, req: Request<pb::GetContextPackRequest>) -> Result<Response<pb::ContextPackView>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let r = req.into_inner();
        let sections = if r.sections.is_empty() { None } else { Some(r.sections) };
        let task = if r.task_id.is_empty() { None } else { Some(r.task_id.as_str()) };
        let out = self.0.domain.get_context_pack(&ctx, &r.context_pack_id, r.version, sections, task).await.map_err(|e| fail(&ctx, e))?;
        let v = to_json(&ctx, &out)?;
        Ok(respond(
            &ctx,
            pb::ContextPackView {
                context_pack_id: c::str_of(&v, "contextPackId"),
                version: c::u64_of(&v, "version"),
                digest: c::str_of(&v, "digest"),
                classification: c::str_of(&v, "classification"),
                disclosed_sections: c::strings_of(&v, "disclosedSections"),
                withheld_sections: c::strings_of(&v, "withheldSections"),
                section_index: c::structure(&v, "sectionIndex"),
                pack: c::structure(&v, "pack"),
                trace_id: tid(&ctx),
            },
        ))
    }

    async fn offer(&self, req: Request<pb::OfferContextRequest>) -> Result<Response<pb::ContextOffer>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let r = req.into_inner();
        let doc = Doc::new()
            .raw("to", r.to.map(|m| json!({"kind": m.kind, "id": m.id})).unwrap_or(Value::Null))
            .str("mode", &r.mode)
            .str("taskId", &r.task_id)
            .strs("sections", &r.sections)
            .i64("expiresInSeconds", r.expires_in_seconds)
            .str("note", &r.note)
            .build();
        let out = self.0.domain.offer_context(&ctx, &r.context_pack_id, r.version, from_doc(&ctx, doc)?).await.map_err(|e| fail(&ctx, e))?;
        Ok(respond(&ctx, c::offer(&to_json(&ctx, &out)?, &tid(&ctx))))
    }

    async fn accept(&self, req: Request<pb::AcceptContextRequest>) -> Result<Response<pb::AcceptContextResponse>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let r = req.into_inner();
        let doc = Doc::new().str("offerId", &r.offer_id).i64("leaseSeconds", r.lease_seconds).build();
        let out = self.0.domain.accept_context(&ctx, &r.context_pack_id, r.version, from_doc(&ctx, doc)?).await.map_err(|e| fail(&ctx, e))?;
        let v = to_json(&ctx, &out)?;
        let trace = tid(&ctx);
        Ok(respond(
            &ctx,
            pb::AcceptContextResponse {
                offer: Some(c::offer(&v["offer"], &trace)),
                task: v.get("task").filter(|t| !t.is_null()).map(c::task),
                lease: v.get("lease").and_then(c::lease),
                fencing_token: c::u64_of(&v, "fencingToken"),
                authorization_token: c::str_of(&v, "authorizationToken"),
                trace_id: trace,
            },
        ))
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
            .str("sourceTaskId", &r.source_task_id)
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
        let task = if r.task_id.is_empty() { None } else { Some(r.task_id.as_str()) };
        let out = self.0.domain.get_artifact(&ctx, &r.artifact_id, r.version, task).await.map_err(|e| fail(&ctx, e))?;
        Ok(respond(&ctx, c::artifact(&to_json(&ctx, &out)?, &tid(&ctx))))
    }

    async fn get_download(&self, req: Request<pb::GetDownloadRequest>) -> Result<Response<pb::DownloadGrant>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let r = req.into_inner();
        let doc = Doc::new().str("taskId", &r.task_id).opt_u64("fencingToken", r.fencing_token).build();
        let out = self.0.domain.artifact_download_grant(&ctx, &r.artifact_id, r.version, from_doc(&ctx, doc)?).await.map_err(|e| fail(&ctx, e))?;
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

// ---- subscriptions & authorization ------------------------------------------------------------------------------------

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

#[tonic::async_trait]
impl pb::authorization_service_server::AuthorizationService for Authorization {
    async fn delegate(&self, req: Request<pb::DelegateRequest>) -> Result<Response<pb::DelegatedGrant>, Status> {
        let ctx = call_ctx(&self.0, req.metadata()).await?;
        let r = req.into_inner();
        let doc = Doc::new()
            .raw("subject", r.subject.map(|m| json!({"kind": m.kind, "id": m.id})).unwrap_or(Value::Null))
            .strs("actions", &r.actions)
            .strs("capabilities", &r.capabilities)
            .strs("resources", &r.resources)
            .structure("constraints", r.constraints)
            .str("classificationMax", &r.classification_max)
            .i64("ttlSeconds", r.ttl_seconds)
            .build();
        let out = self.0.domain.delegate_grant(&ctx, from_doc(&ctx, doc)?).await.map_err(|e| fail(&ctx, e))?;
        let v = to_json(&ctx, &out)?;
        Ok(respond(
            &ctx,
            pb::DelegatedGrant {
                token: c::str_of(&v, "token"),
                jti: c::str_of(&v, "jti"),
                parent_jti: c::str_of(&v, "parentJti"),
                expires_at: c::str_of(&v, "expiresAt"),
                remaining_depth: c::u64_of(&v, "remainingDepth") as u32,
                trace_id: tid(&ctx),
            },
        ))
    }
}
