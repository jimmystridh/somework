//! Model Context Protocol server (JSON-RPC 2.0). Transports: newline-delimited stdio and localhost Streamable HTTP.

mod calls;
mod resources;
pub mod tools;
pub mod transport;

use std::sync::Arc;

use serde_json::{Value, json};
use somework_client::{Client, ClientError};
use tokio::sync::OnceCell;

use tools::{EXTENDED_TOOLS, TOOLS, ToolDef};

pub const SUPPORTED_PROTOCOLS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

pub struct McpServer {
    client: Client,
    extended: bool,
    actions: OnceCell<Vec<String>>,
    extended_state: crate::extended::ExtendedState,
}

impl McpServer {
    pub fn new(client: Client, extended_tools: bool) -> Arc<Self> {
        Arc::new(Self { client, extended: extended_tools, actions: OnceCell::new(), extended_state: Default::default() })
    }

    /// With the principal's key the sealed-secret tool can also open secrets addressed to it.
    pub fn with_key(client: Client, extended_tools: bool, key: ed25519_dalek::SigningKey) -> Arc<Self> {
        Arc::new(Self { client, extended: extended_tools, actions: OnceCell::new(), extended_state: crate::extended::ExtendedState::with_key(key) })
    }

    /// Actions the credential holds; used to hide tools the caller could never use. Falls back to showing everything
    /// when the domain cannot be reached (authorization is still enforced server-side).
    async fn actions(&self) -> Option<&Vec<String>> {
        self.actions
            .get_or_try_init(|| async {
                let who = self.client.get("/v1/admin/whoami").await?;
                Ok::<_, ClientError>(who["actions"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default())
            })
            .await
            .ok()
    }

    fn visible(actions: Option<&Vec<String>>, tool: &ToolDef) -> bool {
        match actions {
            None => true,
            Some(a) => a.iter().any(|x| x == "*" || x == tool.action),
        }
    }

    /// Handles one JSON-RPC message. Notifications (no id) yield `None`.
    pub async fn handle(&self, message: Value) -> Option<Value> {
        let id = message.get("id").cloned();
        let method = message.get("method").and_then(Value::as_str).unwrap_or_default().to_string();
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        message.get("method")?;
        let result = self.dispatch(&method, params).await;
        let id = id?;
        Some(match result {
            Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
            Err((code, msg)) => json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": msg}}),
        })
    }

    async fn dispatch(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        match method {
            "initialize" => {
                let requested = params["protocolVersion"].as_str().unwrap_or_default();
                let version = if SUPPORTED_PROTOCOLS.contains(&requested) { requested } else { SUPPORTED_PROTOCOLS[1] };
                Ok(json!({
                    "protocolVersion": version,
                    "capabilities": {"tools": {"listChanged": false}, "resources": {"listChanged": false, "subscribe": false}},
                    "serverInfo": {"name": "somework-sidecar", "title": "SomeWork collaboration sidecar", "version": env!("CARGO_PKG_VERSION")},
                    "instructions": "SomeWork lets you work with other agents by talking to them. Workflow: 1) collab_catalog_search shows which agents exist and what they advertise. 2) collab_message_send asks an agent for something in plain words (every message wakes the agent; it decides what to do and answers with a message of its own). 3) collab_inbox / collab_events_poll (extended tools) read the answers. To send a file, store it with collab_artifact_begin_upload (give `text`; one call does size, hash, upload and verification) and attach the returned artifact to the message. If nothing matches the request, say so instead of improvising. No transport credentials are required or exposed."
                }))
            }
            "notifications/initialized" | "notifications/cancelled" => Ok(Value::Null),
            "ping" => Ok(json!({})),
            "tools/list" => {
                let actions = self.actions().await;
                let mut tools: Vec<Value> = TOOLS.iter().filter(|t| Self::visible(actions, t)).map(Self::describe).collect();
                if self.extended {
                    tools.extend(EXTENDED_TOOLS.iter().filter(|t| Self::visible(actions, t)).map(Self::describe));
                }
                Ok(json!({"tools": tools}))
            }
            "tools/call" => {
                let name = params["name"].as_str().ok_or((-32602, "missing tool name".to_string()))?.to_string();
                let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
                Ok(self.call_tool(&name, args).await)
            }
            "resources/list" => Ok(self.list_resources().await),
            "resources/templates/list" => Ok(resources::templates()),
            "resources/read" => {
                let uri = params["uri"].as_str().ok_or((-32602, "missing uri".to_string()))?;
                self.read_resource(uri).await
            }
            other => Err((-32601, format!("method not found: {other}"))),
        }
    }

    fn describe(t: &ToolDef) -> Value {
        json!({"name": t.name, "title": t.name, "description": t.description, "inputSchema": (t.schema)()})
    }

    async fn call_tool(&self, name: &str, args: Value) -> Value {
        let extended = self.extended.then(|| EXTENDED_TOOLS.iter().find(|t| t.name == name)).flatten();
        let known = TOOLS.iter().any(|t| t.name == name) || extended.is_some();
        if !known {
            return Self::error_result("not_found", 404, &format!("unknown tool {name}"), None);
        }
        if let Some(def) = TOOLS.iter().find(|t| t.name == name).or(extended)
            && !Self::visible(self.actions().await, def)
        {
            return Self::error_result("policy_denied", 403, &format!("tool {name} is not available to this principal"), None);
        }
        let outcome = if extended.is_some() {
            crate::extended::call(&self.client, &self.extended_state, name, args).await
        } else {
            calls::call(&self.client, name, args).await
        };
        match outcome {
            Ok(value) => Self::ok_result(value),
            Err(e) => Self::error_result(&format!("{:?}", e.code).to_lowercase(), e.status, &e.message, Some(&e)),
        }
    }

    pub(crate) fn ok_result(value: Value) -> Value {
        let text = serde_json::to_string_pretty(&value).unwrap_or_default();
        json!({"content": [{"type": "text", "text": text}], "structuredContent": value, "isError": false})
    }

    pub(crate) fn error_result(code: &str, status: u16, message: &str, err: Option<&ClientError>) -> Value {
        let code = err.map(|e| e.code.as_str().to_string()).unwrap_or_else(|| code.to_string());
        let structured = json!({"code": code, "status": status, "message": message, "details": err.and_then(|e| e.details.clone()), "traceId": err.and_then(|e| e.trace_id.clone())});
        json!({"content": [{"type": "text", "text": format!("{code}: {message}")}], "structuredContent": structured, "isError": true})
    }
}
