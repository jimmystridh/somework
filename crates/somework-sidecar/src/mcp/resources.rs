use serde_json::{Value, json};

use super::McpServer;

pub fn templates() -> Value {
    json!({"resourceTemplates": [
        {"uriTemplate": "somework://catalog/agents/{agentId}", "name": "agent-card", "description": "AgentCard the caller may see", "mimeType": "application/json"},
        {"uriTemplate": "somework://tasks/{taskId}", "name": "task", "description": "Current task snapshot", "mimeType": "application/json"},
        {"uriTemplate": "somework://contexts/{contextPackId}/versions/{version}", "name": "context-pack", "description": "Policy-filtered ContextPack manifest", "mimeType": "application/json"},
        {"uriTemplate": "somework://artifacts/{artifactId}/versions/{version}/metadata", "name": "artifact-metadata", "description": "Artifact metadata (no bytes)", "mimeType": "application/json"},
        {"uriTemplate": "somework://conversations/{conversationId}/summary", "name": "conversation-summary", "description": "Conversation overview", "mimeType": "application/json"}
    ]})
}

fn decode(segment: &str) -> String {
    urlencoding::decode(segment).map(|c| c.into_owned()).unwrap_or_else(|_| segment.to_string())
}

fn enc(s: &str) -> String {
    urlencoding::encode(s).into_owned()
}

impl McpServer {
    pub(super) async fn list_resources(&self) -> Value {
        let mut resources = vec![];
        if let Ok(who) = self.client.get("/v1/admin/whoami").await
            && who["actor"]["kind"] == "agent"
        {
            let id = who["actor"]["id"].as_str().unwrap_or_default();
            resources.push(json!({"uri": format!("somework://catalog/agents/{}", enc(id)), "name": "own-agent-card", "mimeType": "application/json"}));
        }
        json!({"resources": resources})
    }

    pub(super) async fn read_resource(&self, uri: &str) -> Result<Value, (i64, String)> {
        let rest = uri.strip_prefix("somework://").ok_or((-32602, "unsupported URI scheme".to_string()))?;
        let parts: Vec<String> = rest.split('/').map(decode).collect();
        let path = match parts.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
            ["catalog", "agents", id] => format!("/v1/agents/{}", enc(id)),
            ["tasks", id] => format!("/v1/tasks/{}", enc(id)),
            ["contexts", id, "versions", version] => format!("/v1/context-packs/{}/{}", enc(id), enc(version)),
            ["artifacts", id, "versions", version, "metadata"] => format!("/v1/artifacts/{}/{}", enc(id), enc(version)),
            ["conversations", id, "summary"] => format!("/v1/conversations/{}/summary", enc(id)),
            _ => return Err((-32002, format!("resource not found: {uri}"))),
        };
        match self.client.get(&path).await {
            Ok(mut v) => {
                if let Some(o) = v.as_object_mut() {
                    o.remove("authorizationToken");
                }
                Ok(json!({"contents": [{"uri": uri, "mimeType": "application/json", "text": serde_json::to_string_pretty(&v).unwrap_or_default()}]}))
            }
            Err(e) if e.status == 404 => Err((-32002, format!("resource not found: {uri}"))),
            Err(e) => Err((-32603, format!("{}: {}", e.code.as_str(), e.message))),
        }
    }
}
