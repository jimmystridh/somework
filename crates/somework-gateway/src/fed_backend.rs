//! Egress backend speaking the SomeWork federation protocol to a peer gateway.

use async_trait::async_trait;
use reqwest::Method;
use serde_json::{Value, json};
use somework_core::contracts::{Action, CONTEXT_SECTIONS};
use somework_domain::{Domain, tasks::TaskView};

use crate::{
    disclosure::pack_for_peer,
    egress::{AgentInfo, BackendError, RemoteArtifact, RemoteBackend, RemoteRef, RemoteSnapshot, RemoteState, SubmitOutcome},
    peer_client::{PeerCallError, PeerClient},
};

pub struct FederationBackend {
    pub domain: Domain,
    pub client: PeerClient,
}

pub fn peer_of_agent(agent_id: &str) -> Option<String> {
    agent_id.strip_prefix("remote:").and_then(|r| r.split('/').next()).map(String::from)
}

fn refusal_code(body: &Value) -> String {
    body["error"]["code"].as_str().map(|c| format!("remote_{c}")).unwrap_or_else(|| "remote_refused".into())
}

fn map_state(s: &str) -> RemoteState {
    match s {
        "queued" => RemoteState::Queued,
        "input_required" => RemoteState::InputRequired,
        "succeeded" => RemoteState::Succeeded,
        "failed" | "expired" => RemoteState::Failed,
        "rejected" => RemoteState::Rejected,
        "canceled" => RemoteState::Canceled,
        _ => RemoteState::Running,
    }
}

fn transient(e: PeerCallError) -> BackendError {
    match e {
        PeerCallError::Transient(m) => BackendError::Transient(m),
        PeerCallError::Refused { status, body } => BackendError::Gone(format!("peer refused ({status}): {}", refusal_code(&body))),
        PeerCallError::Local(e) => BackendError::Gone(e.to_string()),
    }
}

#[async_trait]
impl RemoteBackend for FederationBackend {
    async fn submit(&self, task: &TaskView, agent: &AgentInfo) -> Result<SubmitOutcome, BackendError> {
        let peer_id = peer_of_agent(&agent.agent_id).ok_or_else(|| BackendError::Gone("not a federated agent".into()))?;
        let peer = self.client.peers().get(&peer_id).await.map_err(|e| BackendError::Gone(e.to_string()))?;
        let Some(peer) = peer.filter(|p| p.is_active()) else {
            return Ok(SubmitOutcome::Rejected { code: "peer_unavailable".into(), message: format!("peer {peer_id} is not an active federation peer") });
        };
        if !somework_core::classification::any_glob(&peer.policy.imports, &task.task.capability.id) {
            return Ok(SubmitOutcome::Rejected {
                code: "import_not_permitted".into(),
                message: format!("capability {} may not be invoked on {peer_id}", task.task.capability.id),
            });
        }
        // outgoing disclosure: the first attached ContextPack, reduced to what this peer may see
        let mut context_pack = Value::Null;
        if let Some(cref) = task.task.context_refs.first() {
            let sections: Vec<String> = CONTEXT_SECTIONS.iter().map(|s| s.to_string()).collect();
            let sys = self.domain.system_ctx();
            if let Ok(view) = self.domain.get_context_pack(&sys, &cref.context_pack_id, cref.version, Some(sections), Some(&task.task.task_id)).await {
                let scale = {
                    let mut conn = self.domain.db.pool().acquire().await.map_err(|e| BackendError::Gone(e.to_string()))?;
                    self.domain.active_policy(&mut conn).await.map_err(|e| BackendError::Gone(e.to_string()))?.scale()
                };
                match pack_for_peer(&view.pack, &peer, &scale, self.domain.domain_id()) {
                    Some(p) => context_pack = p,
                    None => {
                        return Ok(SubmitOutcome::Rejected {
                            code: "context_not_disclosable".into(),
                            message: "the attached ContextPack may not be disclosed to this peer".into(),
                        });
                    }
                }
            }
        }
        let body = json!({
            "capability": task.task.capability,
            "input": task.task.input,
            "contextPack": context_pack,
            "deadlineAt": task.task.deadline_at,
            "originTaskId": task.task.task_id,
        });
        let body = if context_pack.is_null() {
            let mut b = body;
            b.as_object_mut().map(|o| o.remove("contextPack"));
            b
        } else {
            body
        };
        let actions = [Action::TaskSubmit, Action::CapabilityInvoke, Action::ContextWrite];
        match self
            .client
            .call(
                &peer_id,
                Method::POST,
                "/federation/v1/tasks",
                Some(&body),
                &actions,
                Some(&task.task.task_id),
                std::slice::from_ref(&task.task.capability.id),
            )
            .await
        {
            Ok((_, resp)) => Ok(SubmitOutcome::Accepted(RemoteRef {
                external_task_id: resp["taskId"].as_str().unwrap_or_default().to_string(),
                external_context_id: None,
                peer_domain_id: Some(peer_id.clone()),
                remote_interface: peer.gateway_url.clone().unwrap_or_default(),
                protocol_version: "somework-federation/1".into(),
                card_digest: agent.source_digest.clone(),
                remote_principal: Some(format!("domain:{peer_id}")),
            })),
            Err(PeerCallError::Refused { status, body }) => {
                Ok(SubmitOutcome::Rejected { code: refusal_code(&body), message: format!("the remote domain refused the request ({status})") })
            }
            Err(PeerCallError::Transient(m)) => Err(BackendError::Transient(m)),
            Err(PeerCallError::Local(e)) => Err(BackendError::Gone(e.to_string())),
        }
    }

    async fn poll(&self, remote: &RemoteRef, cursor: i64) -> Result<RemoteSnapshot, BackendError> {
        let peer = remote.peer_domain_id.clone().unwrap_or_default();
        let id = &remote.external_task_id;
        let (_, task) =
            self.client.call(&peer, Method::GET, &format!("/federation/v1/tasks/{id}"), None, &[Action::TaskRead], Some(id), &[]).await.map_err(transient)?;
        let (_, events) = self
            .client
            .call(&peer, Method::GET, &format!("/federation/v1/tasks/{id}/events?after={cursor}"), None, &[Action::TaskRead], Some(id), &[])
            .await
            .map_err(transient)?;
        let mut snapshot = RemoteSnapshot { cursor, ..Default::default() };
        for e in events["events"].as_array().cloned().unwrap_or_default() {
            snapshot.cursor = snapshot.cursor.max(e["sequence"].as_i64().unwrap_or(0));
            if let Some(m) = e["message"].as_str() {
                snapshot.progress.push(m.to_string());
            }
        }
        snapshot.state = Some(map_state(task["state"].as_str().unwrap_or("running")));
        snapshot.result = task.get("result").filter(|r| !r.is_null()).cloned();
        snapshot.failure_code = task["failure"]["code"].as_str().map(|c| format!("remote_{c}"));
        snapshot.failure_message = task["failure"]["message"].as_str().map(String::from);
        for a in task["artifacts"].as_array().cloned().unwrap_or_default() {
            snapshot.artifacts.push(RemoteArtifact {
                artifact_id: a["artifactId"].as_str().unwrap_or_default().into(),
                version: a["version"].as_u64().unwrap_or(1),
                filename: a["filename"].as_str().map(String::from),
                media_type: a["mediaType"].as_str().unwrap_or("application/octet-stream").into(),
                size_bytes: a["sizeBytes"].as_u64().unwrap_or(0),
                sha256: a["digest"]["value"].as_str().unwrap_or_default().into(),
                classification: a["classification"].as_str().unwrap_or("internal").into(),
                location: format!(
                    "/federation/v1/tasks/{id}/artifacts/{}/{}",
                    a["artifactId"].as_str().unwrap_or_default(),
                    a["version"].as_u64().unwrap_or(1)
                ),
            });
        }
        Ok(snapshot)
    }

    async fn cancel(&self, remote: &RemoteRef) -> Result<(), BackendError> {
        let peer = remote.peer_domain_id.clone().unwrap_or_default();
        let id = &remote.external_task_id;
        self.client
            .call(&peer, Method::POST, &format!("/federation/v1/tasks/{id}/cancel"), Some(&json!({})), &[Action::TaskCancel], Some(id), &[])
            .await
            .map(|_| ())
            .map_err(transient)
    }

    async fn fetch_artifact(&self, remote: &RemoteRef, artifact: &RemoteArtifact) -> Result<Vec<u8>, BackendError> {
        let peer = remote.peer_domain_id.clone().unwrap_or_default();
        self.client.call_bytes(&peer, &artifact.location, &remote.external_task_id).await.map_err(transient)
    }
}
