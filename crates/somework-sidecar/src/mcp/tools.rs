//! The MCP tool surface. Each tool is a thin typed wrapper over one REST call; no business logic lives here.

use serde_json::{Value, json};

pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    /// Platform action the caller must hold for the tool to be offered (hidden otherwise).
    pub action: &'static str,
    pub schema: fn() -> Value,
}

fn actor_ref() -> Value {
    json!({"type": "object", "required": ["kind", "id"], "properties": {"kind": {"enum": ["agent", "human", "service"]}, "id": {"type": "string"}}})
}

fn capability_ref() -> Value {
    json!({"type": "object", "required": ["id", "version"], "properties": {"id": {"type": "string"}, "version": {"type": "string"}}})
}

fn context_refs() -> Value {
    json!({"type": "array", "items": {"type": "object", "required": ["contextPackId", "version"], "properties": {"contextPackId": {"type": "string"}, "version": {"type": "integer", "minimum": 1}, "sections": {"type": "array", "items": {"type": "string"}}}}})
}

fn artifact_refs() -> Value {
    json!({"type": "array", "items": {"type": "object"}, "description": "ArtifactRef objects as returned by collab_artifact_complete_upload"})
}

pub const TOOLS: &[ToolDef] = &[
    ToolDef {
        name: "collab_catalog_search",
        description: "Find agents and capabilities by natural-language intent, capability ids, tags, schema compatibility, side-effect limits and availability. Results are policy-filtered and include each matched capability's description, side-effect class and input/output JSON Schemas (`capabilities`), so you can build a valid task `input` directly.",
        action: "catalog.read",
        schema: || {
            json!({"type": "object", "properties": {
                "query": {"type": "string"},
                "requiredCapabilities": {"type": "array", "items": {"type": "string"}, "description": "Capability ids, optionally id@version"},
                "tags": {"type": "array", "items": {"type": "string"}},
                "input": {"type": "object", "description": "Sample input the capability must accept"},
                "inputSchema": {"type": "object"}, "outputSchema": {"type": "object"},
                "constraints": {"type": "object", "properties": {"sideEffectsAtMost": {"enum": ["none", "read", "write", "irreversible"]}, "dataClassification": {"type": "string"}, "allowedDomains": {"type": "array", "items": {"type": "string"}}}},
                "availability": {"type": "array", "items": {"enum": ["available", "busy", "queueable", "offline", "unknown"]}},
                "trustTiers": {"type": "array", "items": {"enum": ["local", "partner", "external", "untrusted"]}},
                "limit": {"type": "integer", "minimum": 1, "maximum": 50}}, "additionalProperties": false})
        },
    },
    ToolDef {
        name: "collab_agent_get",
        description: "Inspect an AgentCard the caller is allowed to see.",
        action: "catalog.read",
        schema: || json!({"type": "object", "required": ["agentId"], "properties": {"agentId": {"type": "string"}}, "additionalProperties": false}),
    },
    ToolDef {
        name: "collab_message_send",
        description: "Send a typed chat message, notice or event notification. Provide `text` for plain text or `content` for structured data. Notices never wake agents.",
        action: "message.send",
        schema: || {
            json!({"type": "object", "properties": {
                "type": {"enum": ["chat.message", "chat.notice", "event.notification", "task.status"]},
                "conversationId": {"type": "string"}, "taskId": {"type": "string"},
                "recipients": {"type": "array", "items": actor_ref()},
                "text": {"type": "string"},
                "content": {"type": "object", "required": ["mediaType", "data"], "properties": {"mediaType": {"type": "string"}, "data": {}}},
                "triggerMode": {"enum": ["never", "directed", "subscription", "task-state"]},
                "correlationId": {"type": "string"}, "causationId": {"type": "string"}, "replyTo": {"type": "string"},
                "labels": {"type": "object", "additionalProperties": {"type": "string"}},
                "idempotencyKey": {"type": "string"}}, "additionalProperties": false})
        },
    },
    ToolDef {
        name: "collab_task_submit",
        description: "Submit durable work to a capability. `input` must satisfy the capability's inputSchema (shown by collab_catalog_search / collab_agent_get). Small content (up to ~30 KB) can go straight into `input` if the schema has a field for it. Returns the task (usually `queued`); then call collab_task_get with waitSeconds.",
        action: "task.submit",
        schema: || {
            json!({"type": "object", "required": ["capability"], "properties": {
                "capability": capability_ref(), "targetAgentId": {"type": "string"}, "conversationId": {"type": "string"},
                "parentTaskId": {"type": "string"}, "parentFencingToken": {"type": "integer"},
                "input": {"type": "object"}, "contextRefs": context_refs(), "deadlineAt": {"type": "string", "format": "date-time"},
                "constraints": {"type": "object", "properties": {"sideEffectsAtMost": {"enum": ["none", "read", "write", "irreversible"]}}},
                "idempotencyKey": {"type": "string"}}, "additionalProperties": false})
        },
    },
    ToolDef {
        name: "collab_task_get",
        description: "Read the current state, result and failure of a task. With `waitSeconds` the call waits for a terminal state.",
        action: "task.read",
        schema: || json!({"type": "object", "required": ["taskId"], "properties": {"taskId": {"type": "string"}, "waitSeconds": {"type": "integer", "minimum": 0, "maximum": 30}}, "additionalProperties": false}),
    },
    ToolDef {
        name: "collab_task_claim",
        description: "Worker: claim a queued task. The lease, fencing token and task grant are kept by the sidecar; only the fencing token is returned.",
        action: "task.claim",
        schema: || json!({"type": "object", "required": ["taskId"], "properties": {"taskId": {"type": "string"}, "leaseSeconds": {"type": "integer", "minimum": 1}}, "additionalProperties": false}),
    },
    ToolDef {
        name: "collab_task_progress",
        description: "Worker: emit a durable progress checkpoint or move to input_required/blocked.",
        action: "task.update",
        schema: || {
            json!({"type": "object", "required": ["taskId", "fencingToken"], "properties": {
                "taskId": {"type": "string"}, "fencingToken": {"type": "integer"}, "expectedRevision": {"type": "integer"},
                "status": {"enum": ["running", "input_required", "blocked"]}, "message": {"type": "string"},
                "checkpoint": {"type": "object"}, "percent": {"type": "number"}, "question": {"type": "object"},
                "blockedOn": {"type": "array", "items": {"type": "string"}}}, "additionalProperties": false})
        },
    },
    ToolDef {
        name: "collab_task_input",
        description: "Requester: supply the input a task is waiting for (state input_required).",
        action: "task.update",
        schema: || json!({"type": "object", "required": ["taskId", "data"], "properties": {"taskId": {"type": "string"}, "data": {"type": "object"}, "expectedRevision": {"type": "integer"}}, "additionalProperties": false}),
    },
    ToolDef {
        name: "collab_task_complete",
        description: "Worker: commit the validated result of a task (output is checked against the capability's output schema).",
        action: "task.update",
        schema: || json!({"type": "object", "required": ["taskId", "fencingToken", "result"], "properties": {"taskId": {"type": "string"}, "fencingToken": {"type": "integer"}, "expectedRevision": {"type": "integer"}, "result": {"type": "object"}, "artifacts": artifact_refs()}, "additionalProperties": false}),
    },
    ToolDef {
        name: "collab_task_fail",
        description: "Worker: commit a terminal failure.",
        action: "task.update",
        schema: || {
            json!({"type": "object", "required": ["taskId", "fencingToken", "failure"], "properties": {
                "taskId": {"type": "string"}, "fencingToken": {"type": "integer"}, "expectedRevision": {"type": "integer"},
                "failure": {"type": "object", "required": ["code", "message", "retryable"], "properties": {"code": {"type": "string"}, "message": {"type": "string"}, "retryable": {"type": "boolean"}, "details": {"type": "object"}}}}, "additionalProperties": false})
        },
    },
    ToolDef {
        name: "collab_task_cancel",
        description: "Request cancellation of a task, or (worker) acknowledge a cancellation with acknowledge=true and the fencing token.",
        action: "task.cancel",
        schema: || json!({"type": "object", "required": ["taskId"], "properties": {"taskId": {"type": "string"}, "reason": {"type": "string"}, "expectedRevision": {"type": "integer"}, "acknowledge": {"type": "boolean"}, "fencingToken": {"type": "integer"}}, "additionalProperties": false}),
    },
    ToolDef {
        name: "collab_context_create",
        description: "Create an immutable ContextPack: a compact handover manifest (not a transcript) for consultations, subtasks or ownership transfers. Easiest form: give `objective` (and optionally `instruction`, `summary`, `facts`, `openQuestions`, `artifacts`, `mode`); the sidecar fills the rest. For a plain 'please do X with this input' request use collab_task_submit instead.",
        action: "context.write",
        schema: || {
            json!({"type": "object", "properties": {
                "objective": {"type": "string"}, "instruction": {"type": "string", "description": "what the receiver should do (defaults to the objective)"},
                "summary": {"type": "string"}, "mode": {"enum": ["consultation", "subtask", "ownership_transfer"]},
                "classification": {"type": "string", "description": "defaults to internal"}, "expectedOutputCapability": {"type": "string"},
                "completed": {"type": "array", "items": {"type": "string"}}, "remaining": {"type": "array", "items": {"type": "string"}},
                "acceptanceCriteria": {"type": "array", "items": {"type": "string"}}, "openQuestions": {"type": "array", "items": {"type": "string"}},
                "facts": {"type": "array", "items": {"type": ["string", "object"]}, "description": "plain statements, or full Fact objects"}, "hypotheses": {"type": "array", "items": {"type": "object"}},
                "decisions": {"type": "array", "items": {"type": "object"}},
                "artifacts": {"type": "array", "items": {"type": "object"}, "description": "ArtifactRef objects returned by collab_artifact_begin_upload"},
                "pack": {"type": "object", "description": "advanced: a complete ContextPack v1 document instead of the shorthand fields"}}, "additionalProperties": false})
        },
    },
    ToolDef {
        name: "collab_context_offer",
        description: "Offer a ContextPack version to a recipient as consultation, subtask or ownership transfer.",
        action: "context.write",
        schema: || {
            json!({"type": "object", "required": ["contextPackId", "version", "to"], "properties": {
                "contextPackId": {"type": "string"}, "version": {"type": "integer", "minimum": 1}, "to": actor_ref(),
                "mode": {"enum": ["subtask", "ownership_transfer", "consultation"]}, "taskId": {"type": "string"},
                "sections": {"type": "array", "items": {"type": "string"}}, "expiresInSeconds": {"type": "integer"}, "note": {"type": "string"}}, "additionalProperties": false})
        },
    },
    ToolDef {
        name: "collab_context_accept",
        description: "Accept a context offer. Ownership transfers only take effect here, atomically.",
        action: "context.read",
        schema: || json!({"type": "object", "required": ["contextPackId", "version", "offerId"], "properties": {"contextPackId": {"type": "string"}, "version": {"type": "integer"}, "offerId": {"type": "string"}, "leaseSeconds": {"type": "integer"}}, "additionalProperties": false}),
    },
    ToolDef {
        name: "collab_artifact_begin_upload",
        description: "Store a file as an immutable, digest-verified artifact. Pass the content as `text` (UTF-8) or `contentBase64` and the sidecar computes size and SHA-256, uploads it and verifies it in one call, returning the ArtifactRef (use its `uri`/id in a ContextPack or task input). Without content you only get an upload grant.",
        action: "artifact.write",
        schema: || {
            json!({"type": "object", "properties": {
                "text": {"type": "string", "description": "file content as UTF-8 text"},
                "contentBase64": {"type": "string", "description": "file content, base64 (for binary data)"},
                "filename": {"type": "string"}, "mediaType": {"type": "string", "description": "defaults to text/plain for `text`"},
                "artifactId": {"type": "string", "description": "add a new version to an existing artifact"},
                "classification": {"type": "string"}, "sourceTaskId": {"type": "string"}, "provenance": {"type": "object"},
                "sizeBytes": {"type": "integer", "minimum": 0, "description": "only when uploading without content"},
                "sha256": {"type": "string", "pattern": "^[A-Fa-f0-9]{64}$", "description": "only when uploading without content"}}, "additionalProperties": false})
        },
    },
    ToolDef {
        name: "collab_artifact_complete_upload",
        description: "Verify and finalize an upload (size and SHA-256 are checked before the artifact exists).",
        action: "artifact.write",
        schema: || json!({"type": "object", "required": ["artifactId"], "properties": {"artifactId": {"type": "string"}, "version": {"type": "integer"}, "parts": {"type": "array", "items": {"type": "object", "properties": {"partNumber": {"type": "integer"}, "etag": {"type": "string"}}}}}, "additionalProperties": false}),
    },
    ToolDef {
        name: "collab_artifact_get",
        description: "Get artifact metadata; with includeContent=true (<= 1 MiB) the sidecar downloads and digest-verifies the bytes and returns them as base64.",
        action: "artifact.read",
        schema: || json!({"type": "object", "required": ["artifactId", "version"], "properties": {"artifactId": {"type": "string"}, "version": {"type": "integer", "minimum": 1}, "taskId": {"type": "string"}, "includeContent": {"type": "boolean"}}, "additionalProperties": false}),
    },
    ToolDef {
        name: "collab_subscribe",
        description: "Manage durable subscriptions. wakeOnMatch must be stated explicitly.",
        action: "message.read",
        schema: || {
            json!({"type": "object", "required": ["action"], "properties": {
                "action": {"enum": ["create", "delete", "list"]}, "kind": {"enum": ["topic", "capability_queue", "conversation", "task"]},
                "selector": {"type": "string"}, "wakeOnMatch": {"type": "boolean"}, "subscriptionId": {"type": "string"}}, "additionalProperties": false})
        },
    },
];

/// Optional tools (`--extended-tools`) beyond the spec's 18: conversations, inbox/read receipts, polling, sealed secrets.
pub const EXTENDED_TOOLS: &[ToolDef] = &[
    ToolDef {
        name: "collab_whoami",
        description: "Who the sidecar's credential authenticates as.",
        action: "message.read",
        schema: || json!({"type": "object", "properties": {}, "additionalProperties": false}),
    },
    ToolDef {
        name: "collab_conversation_list",
        description: "List conversations you belong to, or with open=true the open rooms you may join.",
        action: "message.read",
        schema: || json!({"type": "object", "properties": {"open": {"type": "boolean"}}, "additionalProperties": false}),
    },
    ToolDef {
        name: "collab_conversation_create",
        description: "Create a room. Open rooms are discoverable and joinable by any principal cleared for their classification.",
        action: "message.send",
        schema: || json!({"type": "object", "required": ["title"], "properties": {"title": {"type": "string"}, "open": {"type": "boolean"}}, "additionalProperties": false}),
    },
    ToolDef {
        name: "collab_conversation_join",
        description: "Join an open room by conversation id or title.",
        action: "message.send",
        schema: || json!({"type": "object", "required": ["conversation"], "properties": {"conversation": {"type": "string"}}, "additionalProperties": false}),
    },
    ToolDef {
        name: "collab_conversation_leave",
        description: "Leave a room by conversation id or title.",
        action: "message.send",
        schema: || json!({"type": "object", "required": ["conversation"], "properties": {"conversation": {"type": "string"}}, "additionalProperties": false}),
    },
    ToolDef {
        name: "collab_inbox",
        description: "Messages addressed to you or posted in your conversations, unread by default.",
        action: "message.read",
        schema: || json!({"type": "object", "properties": {"unread": {"type": "boolean"}}, "additionalProperties": false}),
    },
    ToolDef {
        name: "collab_inbox_mark_read",
        description: "Record read receipts for messages.",
        action: "message.read",
        schema: || json!({"type": "object", "required": ["messageIds"], "properties": {"messageIds": {"type": "array", "items": {"type": "string"}}}, "additionalProperties": false}),
    },
    ToolDef {
        name: "collab_events_poll",
        description: "Live feed of new messages from others since your last poll (your own messages are excluded). The first poll of a session starts at now; use collab_inbox for older unread messages. Optionally long-polls for `wait` seconds (max 30).",
        action: "message.read",
        schema: || json!({"type": "object", "properties": {"wait": {"type": "integer", "minimum": 0, "maximum": 30}}, "additionalProperties": false}),
    },
    ToolDef {
        name: "collab_secret_seal",
        description: "Encrypt a short-lived secret for one agent. The platform stores only ciphertext; it can be opened once by the recipient.",
        action: "message.send",
        schema: || json!({"type": "object", "required": ["to", "secret"], "properties": {"to": {"type": "string", "description": "recipient agent id"}, "secret": {"type": "string"}, "ttlSeconds": {"type": "integer"}, "label": {"type": "string"}}, "additionalProperties": false}),
    },
    ToolDef {
        name: "collab_secret_list",
        description: "Sealed secrets waiting for you (metadata only).",
        action: "message.read",
        schema: || json!({"type": "object", "properties": {}, "additionalProperties": false}),
    },
    ToolDef {
        name: "collab_secret_open",
        description: "Open a sealed secret addressed to you. It can be read once and is gone after its short TTL.",
        action: "message.read",
        schema: || json!({"type": "object", "required": ["secretId"], "properties": {"secretId": {"type": "string"}}, "additionalProperties": false}),
    },
];
