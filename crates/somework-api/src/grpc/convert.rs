//! Domain JSON -> protobuf messages. Typed essentials are lifted out of the canonical JSON; the complete document
//! is kept alongside as a `Struct` so nothing is lost.

use serde_json::Value;

use super::{json::json_to_struct, pb};

pub fn str_of(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

pub fn u64_of(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or_default()
}

pub fn i64_of(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(Value::as_i64).unwrap_or_default()
}

pub fn bool_of(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or_default()
}

pub fn strings_of(v: &Value, key: &str) -> Vec<String> {
    v.get(key).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default()
}

pub fn structure(v: &Value, key: &str) -> Option<prost_types::Struct> {
    v.get(key).and_then(json_to_struct)
}

pub fn task_state(raw: &str) -> pb::TaskState {
    match raw {
        "submitted" => pb::TaskState::Submitted,
        "queued" => pb::TaskState::Queued,
        "claimed" => pb::TaskState::Claimed,
        "running" => pb::TaskState::Running,
        "input_required" => pb::TaskState::InputRequired,
        "blocked" => pb::TaskState::Blocked,
        "cancel_requested" => pb::TaskState::CancelRequested,
        "succeeded" => pb::TaskState::Succeeded,
        "failed" => pb::TaskState::Failed,
        "rejected" => pb::TaskState::Rejected,
        "canceled" => pb::TaskState::Canceled,
        "expired" => pb::TaskState::Expired,
        _ => pb::TaskState::Unspecified,
    }
}

pub fn task(v: &Value) -> pb::Task {
    pb::Task {
        task_id: str_of(v, "taskId"),
        state: task_state(&str_of(v, "state")) as i32,
        revision: u64_of(v, "revision"),
        attempt: u64_of(v, "attempt"),
        conversation_id: str_of(v, "conversationId"),
        capability: v.get("capability").map(|c| pb::CapabilityRef { id: str_of(c, "id"), version: str_of(c, "version") }),
        task: json_to_struct(v),
    }
}

pub fn lease(v: &Value) -> Option<pb::Lease> {
    v.as_object().map(|_| pb::Lease {
        lease_id: str_of(v, "leaseId"),
        runtime_instance_id: str_of(v, "runtimeInstanceId"),
        fencing_token: u64_of(v, "fencingToken"),
        expires_at: str_of(v, "expiresAt"),
    })
}

pub fn task_event(v: &Value) -> pb::TaskEvent {
    pb::TaskEvent {
        task_id: str_of(v, "taskId"),
        event_sequence: i64_of(v, "eventSequence"),
        event_id: str_of(v, "eventId"),
        r#type: str_of(v, "type"),
        from_state: str_of(v, "fromState"),
        to_state: str_of(v, "toState"),
        revision: i64_of(v, "revision"),
        actor: structure(v, "actor"),
        data: structure(v, "data"),
        trace_id: str_of(v, "traceId"),
        created_at: str_of(v, "createdAt"),
    }
}

pub fn message_record(v: &Value, trace_id: &str) -> pb::MessageRecord {
    pb::MessageRecord {
        message_id: str_of(v, "messageId"),
        seq: i64_of(v, "seq"),
        r#type: str_of(v, "type"),
        conversation_id: str_of(v, "conversationId"),
        trigger_mode: str_of(v, "triggerMode"),
        envelope: json_to_struct(v),
        trace_id: trace_id.to_string(),
    }
}

pub fn event(v: &Value) -> pb::Event {
    pb::Event {
        seq: i64_of(v, "seq"),
        event_id: str_of(v, "eventId"),
        r#type: str_of(v, "type"),
        task_id: str_of(v, "taskId"),
        conversation_id: str_of(v, "conversationId"),
        message_id: str_of(v, "messageId"),
        revision: i64_of(v, "revision"),
        wake: bool_of(v, "wake"),
        payload: structure(v, "payload"),
        created_at: str_of(v, "createdAt"),
    }
}

pub fn offer(v: &Value, trace_id: &str) -> pb::ContextOffer {
    pb::ContextOffer {
        offer_id: str_of(v, "offerId"),
        context_pack_id: str_of(v, "contextPackId"),
        version: u64_of(v, "version"),
        mode: str_of(v, "mode"),
        task_id: str_of(v, "taskId"),
        sections: strings_of(v, "sections"),
        status: str_of(v, "status"),
        expires_at: str_of(v, "expiresAt"),
        offer: json_to_struct(v),
        trace_id: trace_id.to_string(),
    }
}

pub fn artifact(v: &Value, trace_id: &str) -> pb::ArtifactMetadata {
    pb::ArtifactMetadata {
        artifact_id: str_of(v, "artifactId"),
        version: u64_of(v, "version"),
        uri: str_of(v, "uri"),
        media_type: str_of(v, "mediaType"),
        size_bytes: u64_of(v, "sizeBytes"),
        sha256: v.pointer("/digest/value").and_then(Value::as_str).unwrap_or_default().to_string(),
        classification: str_of(v, "classification"),
        artifact: json_to_struct(v),
        trace_id: trace_id.to_string(),
    }
}

pub fn progress_status(raw: i32) -> Option<&'static str> {
    match pb::ProgressStatus::try_from(raw).unwrap_or(pb::ProgressStatus::Unspecified) {
        pb::ProgressStatus::Unspecified => None,
        pb::ProgressStatus::Running => Some("running"),
        pb::ProgressStatus::InputRequired => Some("input_required"),
        pb::ProgressStatus::Blocked => Some("blocked"),
    }
}

pub fn context_refs(refs: Vec<pb::ContextRef>) -> Value {
    Value::Array(
        refs.into_iter()
            .map(|r| {
                let mut o = serde_json::json!({"contextPackId": r.context_pack_id, "version": r.version});
                if !r.sections.is_empty() {
                    o["sections"] = serde_json::json!(r.sections);
                }
                o
            })
            .collect(),
    )
}

pub fn members(ms: Vec<pb::Member>) -> Value {
    Value::Array(ms.into_iter().map(|m| serde_json::json!({"kind": m.kind, "id": m.id})).collect())
}
