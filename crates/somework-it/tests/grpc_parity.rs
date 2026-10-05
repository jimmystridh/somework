//! The same scenario scripted once over REST and once over gRPC must produce an identical transcript: states,
//! revisions, attempts, fencing tokens, event sequences and problem codes.

mod grpc_common;

use async_trait::async_trait;
use grpc_common::*;
use serde_json::{Value, json};
use somework_api::grpc::{pb, struct_to_json};
use somework_core::contracts::SideEffects;
use somework_testkit::{Agent, Stack};

#[async_trait]
trait Driver {
    async fn submit(&mut self, key: Option<&str>, capability: (&str, &str), input: Value) -> Result<Value, String>;
    async fn claim(&mut self, who: &Agent, task_id: &str) -> Result<Value, String>;
    async fn progress(&mut self, who: &Agent, task_id: &str, fence: u64) -> Result<Value, String>;
    async fn complete(&mut self, who: &Agent, task_id: &str, fence: u64, result: Value) -> Result<Value, String>;
    async fn cancel(&mut self, task_id: &str, expected_revision: Option<u64>) -> Result<Value, String>;
    async fn get(&mut self, task_id: &str) -> Result<Value, String>;
    async fn event_kinds(&mut self, task_id: &str) -> Vec<String>;
}

fn summary(state: &str, revision: u64, attempt: u64) -> Value {
    json!({"state": state, "revision": revision, "attempt": attempt})
}

async fn scenario(d: &mut dyn Driver, worker: &Agent, worker2: &Agent) -> Vec<(String, Value)> {
    let mut log: Vec<(String, Value)> = vec![];
    let ok_input = json!({"repository": "billing/import-service", "commit": "61a8d52"});
    let step = |name: &str, r: Result<Value, String>| {
        (
            name.to_string(),
            match r {
                Ok(v) => v,
                Err(code) => json!({"error": code}),
            },
        )
    };

    let first = d.submit(Some("parity-1"), ("code.review", "2.1"), ok_input.clone()).await.unwrap();
    let task_id = first["taskId"].as_str().unwrap().to_string();
    log.push(("submit".into(), first["summary"].clone()));
    let replay = d.submit(Some("parity-1"), ("code.review", "2.1"), ok_input.clone()).await.unwrap();
    log.push(("submit-replay-same-task".into(), json!(replay["taskId"] == first["taskId"])));
    log.push(step("submit-conflicting-key", d.submit(Some("parity-1"), ("code.review", "2.1"), json!({"repository": "other"})).await));
    log.push(step("submit-schema-violation", d.submit(None, ("code.review", "2.1"), json!({"commit": "x"})).await));
    log.push(step("submit-unknown-capability", d.submit(None, ("nope.nope", "1"), ok_input.clone()).await));
    log.push(step("stale-revision-cancel", d.cancel(&task_id, Some(1)).await));

    let claim = d.claim(worker, &task_id).await.unwrap();
    log.push(("claim".into(), claim["summary"].clone()));
    log.push(("fencing-token".into(), claim["fencingToken"].clone()));
    log.push(step("second-claim", d.claim(worker2, &task_id).await));
    log.push(step("stale-fence-progress", d.progress(worker, &task_id, 99).await));
    log.push(step("progress", d.progress(worker, &task_id, 1).await));
    log.push(step("complete-invalid-result", d.complete(worker, &task_id, 1, json!({"verdict": "maybe"})).await));
    log.push(step("complete", d.complete(worker, &task_id, 1, json!({"verdict": "approve"})).await));
    log.push(step("cancel-terminal", d.cancel(&task_id, None).await));
    log.push(step("get-unknown", d.get("task_missing").await));
    log.push(step("get", d.get(&task_id).await));
    log.push(("event-kinds".into(), json!(d.event_kinds(&task_id).await)));
    log
}

struct RestDriver {
    requester: Agent,
}

fn rest_summary(v: &Value) -> Value {
    summary(v["state"].as_str().unwrap_or_default(), v["revision"].as_u64().unwrap_or_default(), v["attempt"].as_u64().unwrap_or_default())
}

fn rest_err(e: somework_client::ClientError) -> String {
    e.code.as_str().to_string()
}

#[async_trait]
impl Driver for RestDriver {
    async fn submit(&mut self, key: Option<&str>, capability: (&str, &str), input: Value) -> Result<Value, String> {
        let body = json!({"capability": {"id": capability.0, "version": capability.1}, "input": input});
        let v = self.requester.client.raw(reqwest::Method::POST, "/v1/tasks", Some(&body), key, None).await.map_err(rest_err)?;
        Ok(json!({"taskId": v["taskId"], "summary": rest_summary(&v)}))
    }
    async fn claim(&mut self, who: &Agent, task_id: &str) -> Result<Value, String> {
        let v = who.client.post(&format!("/v1/tasks/{task_id}/claim"), &json!({"leaseSeconds": 30})).await.map_err(rest_err)?;
        Ok(json!({"summary": rest_summary(&v["task"]), "fencingToken": v["fencingToken"]}))
    }
    async fn progress(&mut self, who: &Agent, task_id: &str, fence: u64) -> Result<Value, String> {
        let v = who.client.post(&format!("/v1/tasks/{task_id}/progress"), &json!({"fencingToken": fence, "message": "analyzing"})).await.map_err(rest_err)?;
        Ok(rest_summary(&v))
    }
    async fn complete(&mut self, who: &Agent, task_id: &str, fence: u64, result: Value) -> Result<Value, String> {
        let v = who.client.post(&format!("/v1/tasks/{task_id}/complete"), &json!({"fencingToken": fence, "result": result})).await.map_err(rest_err)?;
        Ok(rest_summary(&v))
    }
    async fn cancel(&mut self, task_id: &str, expected_revision: Option<u64>) -> Result<Value, String> {
        let v = self
            .requester
            .client
            .raw(reqwest::Method::POST, &format!("/v1/tasks/{task_id}/cancel"), Some(&json!({})), None, expected_revision)
            .await
            .map_err(rest_err)?;
        Ok(rest_summary(&v))
    }
    async fn get(&mut self, task_id: &str) -> Result<Value, String> {
        let v = self.requester.client.get(&format!("/v1/tasks/{task_id}")).await.map_err(rest_err)?;
        Ok(rest_summary(&v))
    }
    async fn event_kinds(&mut self, task_id: &str) -> Vec<String> {
        let v = self.requester.client.get(&format!("/v1/tasks/{task_id}/events")).await.unwrap();
        v["events"].as_array().unwrap().iter().map(|e| e["type"].as_str().unwrap().to_string()).collect()
    }
}

struct GrpcDriver<'a> {
    g: &'a GrpcStack,
    requester: Creds,
}

fn grpc_summary(t: &pb::Task) -> Value {
    let state = match pb::TaskState::try_from(t.state).unwrap() {
        pb::TaskState::Submitted => "submitted",
        pb::TaskState::Queued => "queued",
        pb::TaskState::Claimed => "claimed",
        pb::TaskState::Running => "running",
        pb::TaskState::Succeeded => "succeeded",
        pb::TaskState::Canceled => "canceled",
        pb::TaskState::CancelRequested => "cancel_requested",
        other => panic!("unexpected state {other:?}"),
    };
    summary(state, t.revision, t.attempt)
}

fn grpc_err(s: tonic::Status) -> String {
    reason(&s)
}

#[async_trait]
impl Driver for GrpcDriver<'_> {
    async fn submit(&mut self, key: Option<&str>, capability: (&str, &str), input: Value) -> Result<Value, String> {
        let req = pb::SubmitTaskRequest {
            capability: Some(pb::CapabilityRef { id: capability.0.into(), version: capability.1.into() }),
            input: Some(struct_of(input)),
            ..Default::default()
        };
        let req = match key {
            Some(k) => with_md(req, &[("idempotency-key", k)]),
            None => tonic::Request::new(req),
        };
        let r = self.g.tasks(&self.requester).submit(req).await.map_err(grpc_err)?.into_inner().task.unwrap();
        Ok(json!({"taskId": r.task_id, "summary": grpc_summary(&r)}))
    }
    async fn claim(&mut self, who: &Agent, task_id: &str) -> Result<Value, String> {
        let r = self
            .g
            .tasks(&Creds::agent(who))
            .claim(pb::ClaimTaskRequest { task_id: task_id.into(), lease_seconds: 30, ..Default::default() })
            .await
            .map_err(grpc_err)?
            .into_inner();
        Ok(json!({"summary": grpc_summary(r.task.as_ref().unwrap()), "fencingToken": r.fencing_token}))
    }
    async fn progress(&mut self, who: &Agent, task_id: &str, fence: u64) -> Result<Value, String> {
        let r = self
            .g
            .tasks(&Creds::agent(who))
            .progress(pb::ProgressTaskRequest { task_id: task_id.into(), fencing_token: fence, message: "analyzing".into(), ..Default::default() })
            .await
            .map_err(grpc_err)?
            .into_inner();
        Ok(grpc_summary(r.task.as_ref().unwrap()))
    }
    async fn complete(&mut self, who: &Agent, task_id: &str, fence: u64, result: Value) -> Result<Value, String> {
        let r = self
            .g
            .tasks(&Creds::agent(who))
            .complete(pb::CompleteTaskRequest { task_id: task_id.into(), fencing_token: fence, result: Some(struct_of(result)), ..Default::default() })
            .await
            .map_err(grpc_err)?
            .into_inner();
        Ok(grpc_summary(r.task.as_ref().unwrap()))
    }
    async fn cancel(&mut self, task_id: &str, expected_revision: Option<u64>) -> Result<Value, String> {
        let r = self
            .g
            .tasks(&self.requester)
            .cancel(pb::CancelTaskRequest { task_id: task_id.into(), expected_revision, ..Default::default() })
            .await
            .map_err(grpc_err)?
            .into_inner();
        Ok(grpc_summary(r.task.as_ref().unwrap()))
    }
    async fn get(&mut self, task_id: &str) -> Result<Value, String> {
        let r = self.g.tasks(&self.requester).get(pb::GetTaskRequest { task_id: task_id.into() }).await.map_err(grpc_err)?.into_inner();
        Ok(grpc_summary(r.task.as_ref().unwrap()))
    }
    async fn event_kinds(&mut self, task_id: &str) -> Vec<String> {
        let r =
            self.g.tasks(&self.requester).list_events(pb::ListTaskEventsRequest { task_id: task_id.into(), ..Default::default() }).await.unwrap().into_inner();
        r.events.into_iter().map(|e| e.r#type).collect()
    }
}

async fn setup(stack: &Stack) -> (Agent, Agent, Agent) {
    let worker = stack
        .worker(
            "agent/reviewer",
            vec![somework_testkit::capability("code.review", "2.1", "read", "Review pull requests for correctness and security")],
            worker_perms(SideEffects::Read),
        )
        .await;
    let worker2 = worker.new_runtime().await;
    let author = stack.requester("agent/author", &["code.review"], SideEffects::Read).await;
    (worker, worker2, author)
}

#[tokio::test]
async fn rest_and_grpc_produce_identical_transcripts() {
    let rest_stack = somework_testkit::Stack::start().await;
    let (w, w2, author) = setup(&rest_stack).await;
    let rest_log = scenario(&mut RestDriver { requester: author }, &w, &w2).await;
    rest_stack.stop().await;

    let g = GrpcStack::start().await;
    let (w, w2, author) = setup(&g.stack).await;
    let grpc_log = scenario(&mut GrpcDriver { g: &g, requester: Creds::agent(&author) }, &w, &w2).await;
    g.stack.stop().await;

    assert_eq!(rest_log, grpc_log, "REST and gRPC transcripts diverge");
    let expected_errors: Vec<(&str, &str)> = vec![
        ("submit-conflicting-key", "idempotency_conflict"),
        ("submit-schema-violation", "schema_violation"),
        ("submit-unknown-capability", "not_found"),
        ("stale-revision-cancel", "stale_revision"),
        ("second-claim", "already_claimed"),
        ("stale-fence-progress", "stale_fencing_token"),
        ("complete-invalid-result", "schema_violation"),
        ("cancel-terminal", "task_terminal"),
        ("get-unknown", "not_found"),
    ];
    for (name, code) in expected_errors {
        let entry = rest_log.iter().find(|(n, _)| n == name).unwrap_or_else(|| panic!("{name} missing"));
        assert_eq!(entry.1["error"], code, "{name}");
    }
    let final_state = &rest_log.iter().find(|(n, _)| n == "complete").unwrap().1;
    assert_eq!(final_state["state"], "succeeded");
    let _ = struct_to_json;
}
