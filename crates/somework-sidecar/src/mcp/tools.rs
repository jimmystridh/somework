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

pub const TOOLS: &[ToolDef] = &[
    ToolDef {
        name: "collab_catalog_search",
        description: "Find agents and what they advertise (capabilities) by natural-language intent, capability ids, tags, side-effect limits and availability. A capability is a description of what an agent does, not an endpoint: to get something done, send the agent a message in plain words (collab_message_send). Results include each matched capability's description, side-effect class and input/output JSON Schemas (`capabilities`).",
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
        description: "Send a message to agents or people: `recipients` for a direct message, or `conversationId` for a conversation you are in (every member is addressed). Ask for what you want in plain words; the receiver decides what to do and answers with a message of its own. Provide `text` for plain text or `content` for structured data, and `artifacts` (ArtifactRefs from collab_artifact_begin_upload) to attach files. Notices never wake agents.",
        action: "message.send",
        schema: || {
            json!({"type": "object", "properties": {
                "type": {"enum": ["chat.message", "chat.notice", "event.notification"]},
                "conversationId": {"type": "string"},
                "recipients": {"type": "array", "items": actor_ref()},
                "text": {"type": "string"},
                "content": {"type": "object", "required": ["mediaType", "data"], "properties": {"mediaType": {"type": "string"}, "data": {}}},
                "triggerMode": {"enum": ["never", "directed", "subscription"]},
                "artifacts": {"type": "array", "items": {"type": "object"}, "description": "ArtifactRef objects as returned by collab_artifact_begin_upload"},
                "correlationId": {"type": "string"}, "causationId": {"type": "string"}, "replyTo": {"type": "string"},
                "labels": {"type": "object", "additionalProperties": {"type": "string"}},
                "idempotencyKey": {"type": "string"}}, "additionalProperties": false})
        },
    },
    ToolDef {
        name: "collab_artifact_begin_upload",
        description: "Store a file as an immutable, digest-verified artifact. Pass the content as `text` (UTF-8) or `contentBase64` and the sidecar computes size and SHA-256, uploads it and verifies it in one call, returning the ArtifactRef (attach it to a message with `artifacts`). Without content you only get an upload grant.",
        action: "artifact.write",
        schema: || {
            json!({"type": "object", "properties": {
                "text": {"type": "string", "description": "file content as UTF-8 text"},
                "contentBase64": {"type": "string", "description": "file content, base64 (for binary data)"},
                "filename": {"type": "string"}, "mediaType": {"type": "string", "description": "defaults to text/plain for `text`"},
                "artifactId": {"type": "string", "description": "add a new version to an existing artifact"},
                "classification": {"type": "string"}, "provenance": {"type": "object"},
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
        schema: || json!({"type": "object", "required": ["artifactId", "version"], "properties": {"artifactId": {"type": "string"}, "version": {"type": "integer", "minimum": 1}, "includeContent": {"type": "boolean"}}, "additionalProperties": false}),
    },
    ToolDef {
        name: "collab_subscribe",
        description: "Manage durable subscriptions. wakeOnMatch must be stated explicitly.",
        action: "message.read",
        schema: || {
            json!({"type": "object", "required": ["action"], "properties": {
                "action": {"enum": ["create", "delete", "list"]}, "kind": {"enum": ["topic", "conversation"]},
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
