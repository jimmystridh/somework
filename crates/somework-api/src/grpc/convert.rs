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
        conversation_id: str_of(v, "conversationId"),
        message_id: str_of(v, "messageId"),
        wake: bool_of(v, "wake"),
        payload: structure(v, "payload"),
        created_at: str_of(v, "createdAt"),
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

pub fn members(ms: Vec<pb::Member>) -> Value {
    Value::Array(ms.into_iter().map(|m| serde_json::json!({"kind": m.kind, "id": m.id})).collect())
}
