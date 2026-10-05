//! A2A v1 wire model (HTTP+JSON binding, protobuf-JSON field names) built from platform objects.

use serde_json::{Map, Value, json};
use somework_core::contracts::Capability;
use somework_domain::tasks::TaskView;

pub const PROTOCOL_VERSION: &str = "1.0";
pub const BINDING: &str = "HTTP+JSON";
pub const A2A_PRINCIPAL_PEER: &str = "a2a";

pub fn task_state(state: &str) -> &'static str {
    match state {
        "submitted" | "queued" => "TASK_STATE_SUBMITTED",
        "claimed" | "running" | "blocked" | "cancel_requested" => "TASK_STATE_WORKING",
        "input_required" => "TASK_STATE_INPUT_REQUIRED",
        "succeeded" => "TASK_STATE_COMPLETED",
        "failed" | "expired" => "TASK_STATE_FAILED",
        "rejected" => "TASK_STATE_REJECTED",
        "canceled" => "TASK_STATE_CANCELED",
        _ => "TASK_STATE_UNSPECIFIED",
    }
}

pub fn is_terminal_state(a2a_state: &str) -> bool {
    matches!(a2a_state, "TASK_STATE_COMPLETED" | "TASK_STATE_FAILED" | "TASK_STATE_REJECTED" | "TASK_STATE_CANCELED")
}

fn agent_message(task_id: &str, context_id: &str, text: String) -> Value {
    json!({"messageId": format!("{task_id}-status"), "contextId": context_id, "taskId": task_id, "role": "ROLE_AGENT", "parts": [{"text": text}]})
}

pub fn artifact_url(base: &str, task_id: &str, artifact_id: &str, version: u64) -> String {
    format!("{}/artifacts/{}/{}/{}", base.trim_end_matches('/'), task_id, artifact_id, version)
}

/// Result and platform artifacts as A2A artifacts. File parts point at gateway-mediated URLs that still require auth.
pub fn artifacts_of(task: &TaskView, base: &str) -> Vec<Value> {
    let t = &task.task;
    let mut out = vec![];
    if let Some(result) = &t.result {
        out.push(json!({"artifactId": format!("{}-result", t.task_id), "name": "result", "description": "Structured task result", "parts": [{"data": result, "mediaType": "application/json"}]}));
    }
    for a in &t.result_artifacts {
        out.push(json!({
            "artifactId": format!("{}-{}-v{}", t.task_id, a.artifact_id, a.version),
            "name": a.filename.clone().unwrap_or_else(|| a.artifact_id.clone()),
            "parts": [{"url": artifact_url(base, &t.task_id, &a.artifact_id, a.version), "filename": a.filename, "mediaType": a.media_type}],
            "metadata": {"sha256": a.digest.value, "sizeBytes": a.size_bytes}
        }));
    }
    out
}

pub fn status_of(task: &TaskView) -> Value {
    let t = &task.task;
    let context = t.conversation_id.clone().unwrap_or_default();
    let mut status = Map::new();
    status.insert("state".into(), json!(task_state(t.state.as_str())));
    status.insert("timestamp".into(), json!(t.updated_at));
    if let Some(f) = &t.failure {
        status.insert("message".into(), agent_message(&t.task_id, &context, format!("{}: {}", f.code, f.message)));
    } else if let Some(q) = task.blocker.as_ref().and_then(|b| b.get("question")).filter(|q| !q.is_null()) {
        status.insert("message".into(), agent_message(&t.task_id, &context, q.to_string()));
    }
    Value::Object(status)
}

pub fn task_to_a2a(task: &TaskView, base: &str) -> Value {
    let t = &task.task;
    let mut out = json!({
        "id": t.task_id,
        "contextId": t.conversation_id.clone().unwrap_or_default(),
        "status": status_of(task),
        "metadata": {"somework": {"capability": {"id": t.capability.id, "version": t.capability.version}, "revision": t.revision, "sideEffects": task.side_effects.as_str()}},
    });
    let artifacts = artifacts_of(task, base);
    if !artifacts.is_empty() {
        out["artifacts"] = Value::Array(artifacts);
    }
    out
}

pub fn status_update(task: &TaskView) -> Value {
    json!({"statusUpdate": {"taskId": task.task.task_id, "contextId": task.task.conversation_id.clone().unwrap_or_default(), "status": status_of(task)}})
}

pub fn skill_of(cap: &Capability) -> Value {
    let mut tags = cap.tags.clone();
    tags.push(format!("side-effects:{}", cap.side_effects.as_str()));
    let mut skill = json!({
        "id": cap.id,
        "name": cap.name,
        "description": cap.description,
        "tags": tags,
        "inputModes": if cap.input_media_types.is_empty() { vec!["application/json".to_string()] } else { cap.input_media_types.clone() },
        "outputModes": if cap.output_media_types.is_empty() { vec!["application/json".to_string()] } else { cap.output_media_types.clone() },
    });
    if !cap.examples.is_empty() {
        skill["examples"] = json!(cap.examples.iter().map(|e| e.to_string()).collect::<Vec<_>>());
    }
    skill
}

/// Schema of a skill's input and output travel as an extension on the card so schema-aware clients can validate.
pub fn skill_schema_extension(caps: &[Capability]) -> Value {
    let schemas: Map<String, Value> = caps
        .iter()
        .map(|c| (format!("{}@{}", c.id, c.version), json!({"inputSchema": c.input_schema, "outputSchema": c.output_schema, "sideEffects": c.side_effects})))
        .collect();
    json!({"uri": "urn:somework:a2a:skill-schemas:v1", "description": "JSON Schemas of SomeWork capabilities exposed as skills", "required": false, "params": {"skills": schemas}})
}

pub struct CardInput<'a> {
    pub name: &'a str,
    pub description: &'a str,
    pub base_url: &'a str,
    pub caps: &'a [Capability],
    pub provider: Option<(&'a str, &'a str)>,
}

pub fn agent_card(i: CardInput<'_>) -> Value {
    let mut card = json!({
        "name": i.name,
        "description": i.description,
        "supportedInterfaces": [{"url": i.base_url, "protocolBinding": BINDING, "protocolVersion": PROTOCOL_VERSION}],
        "version": env!("CARGO_PKG_VERSION"),
        "capabilities": {"streaming": true, "pushNotifications": false, "extendedAgentCard": true, "extensions": [skill_schema_extension(i.caps)]},
        "securitySchemes": {"bearer": {"httpAuthSecurityScheme": {"scheme": "Bearer", "bearerFormat": "JWT", "description": "Short-lived SomeWork workload assertion issued for an enrolled A2A client"}}},
        "securityRequirements": [{"schemes": {"bearer": {}}}],
        "defaultInputModes": ["application/json", "text/plain"],
        "defaultOutputModes": ["application/json"],
        "skills": i.caps.iter().map(skill_of).collect::<Vec<_>>(),
    });
    if let Some((org, url)) = i.provider {
        card["provider"] = json!({"organization": org, "url": url});
    }
    card
}

/// Maps an A2A error onto the REST error envelope used by the official SDKs.
pub fn error_body(http: u16, status: &str, reason: &str, message: &str) -> Value {
    json!({"error": {"code": http, "status": status, "message": message, "details": [{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": reason, "domain": "a2a-protocol.org"}]}})
}
