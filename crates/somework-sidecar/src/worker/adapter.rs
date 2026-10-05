//! Execution adapters: how a claimed task reaches the agent runtime. Agents never talk to the domain themselves;
//! the sidecar passes the task document in and takes a structured outcome back.

use std::{collections::BTreeMap, process::Stdio, sync::Arc};

use async_trait::async_trait;
use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use somework_core::contracts::Failure;

use crate::config::DEFAULT_CHILD_ENV;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;

/// What the agent receives: `kind` is `task` or `message`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub kind: String,
    pub task: Value,
    pub capability: Value,
    pub context_packs: Vec<Value>,
    /// Inputs supplied by the requester after an `input_required` round trip (oldest first).
    pub inputs: Vec<Value>,
    pub fencing_token: u64,
    pub runtime_instance_id: String,
    pub message: Option<Value>,
}

#[derive(Debug, Clone)]
pub enum AdapterEvent {
    Progress { message: Option<String>, checkpoint: Option<Value>, percent: Option<f64> },
    Chunk { kind: String, text: String },
}

#[derive(Debug, Clone)]
pub enum AdapterOutcome {
    Completed { result: Value, artifacts: Vec<Value> },
    Failed(Failure),
    InputRequired { question: Value },
    Canceled,
}

pub struct JobCtl {
    pub events: mpsc::UnboundedSender<AdapterEvent>,
    /// Cooperative cancellation: cancelled when the requester asked to cancel, the lease was lost or the sidecar stops.
    pub cancel: CancellationToken,
}

#[async_trait]
pub trait Adapter: Send + Sync + 'static {
    async fn run(&self, job: Job, ctl: JobCtl) -> AdapterOutcome;

    /// Invoked for wake-up messages directed at the agent; a returned string is sent back as a chat reply.
    async fn on_message(&self, _job: Job, _ctl: JobCtl) -> Option<String> {
        None
    }
}

fn failure(code: &str, message: impl Into<String>) -> AdapterOutcome {
    AdapterOutcome::Failed(Failure { code: code.into(), message: message.into(), retryable: false, details: None })
}

/// Interprets one protocol object (`{"type": "result" | "failure" | "input_required" | ...}`).
fn parse_line(value: &Value) -> Option<Parsed> {
    let kind = value.get("type").and_then(Value::as_str)?;
    match kind {
        "progress" => Some(Parsed::Event(AdapterEvent::Progress {
            message: value["message"].as_str().map(String::from),
            checkpoint: value.get("checkpoint").filter(|c| !c.is_null()).cloned(),
            percent: value["percent"].as_f64(),
        })),
        "chunk" => Some(Parsed::Event(AdapterEvent::Chunk {
            kind: value["kind"].as_str().unwrap_or("text").to_string(),
            text: value["text"].as_str().unwrap_or_default().to_string(),
        })),
        "result" => Some(Parsed::Outcome(AdapterOutcome::Completed {
            result: value.get("result").cloned().unwrap_or_else(|| json!({})),
            artifacts: value["artifacts"].as_array().cloned().unwrap_or_default(),
        })),
        "failure" => Some(Parsed::Outcome(AdapterOutcome::Failed(Failure {
            code: value["code"].as_str().unwrap_or("agent_failure").to_string(),
            message: value["message"].as_str().unwrap_or("the agent reported a failure").to_string(),
            retryable: value["retryable"].as_bool().unwrap_or(false),
            details: value.get("details").filter(|d| d.is_object()).cloned(),
        }))),
        "input_required" => Some(Parsed::Outcome(AdapterOutcome::InputRequired { question: value.get("question").cloned().unwrap_or(Value::Null) })),
        _ => None,
    }
}

enum Parsed {
    Event(AdapterEvent),
    Outcome(AdapterOutcome),
}

pub struct ExecAdapter {
    pub command: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub env_allow: Vec<String>,
    pub max_stderr_notices: usize,
}

impl ExecAdapter {
    /// The executor never inherits the sidecar's environment wholesale: only the default and allowlisted variables that
    /// are actually set, then the explicit overrides.
    fn child_env(&self) -> BTreeMap<String, String> {
        let inherited = DEFAULT_CHILD_ENV.iter().copied().chain(self.env_allow.iter().map(String::as_str));
        let mut env: BTreeMap<String, String> = inherited.filter_map(|name| std::env::var(name).ok().map(|v| (name.to_string(), v))).collect();
        env.extend(self.env.clone());
        env
    }
}

#[async_trait]
impl Adapter for ExecAdapter {
    async fn run(&self, job: Job, ctl: JobCtl) -> AdapterOutcome {
        let Some((program, args)) = self.command.split_first() else { return failure("adapter_misconfigured", "empty adapter command") };
        let mut cmd = Command::new(program);
        cmd.args(args).env_clear().envs(self.child_env()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return failure("adapter_spawn_failed", format!("cannot start `{program}`: {e}")),
        };
        if let Some(mut stdin) = child.stdin.take() {
            let doc = serde_json::to_vec(&job).unwrap_or_default();
            // a command that never reads its stdin must not hang the worker
            tokio::spawn(async move {
                let _ = stdin.write_all(&doc).await;
                let _ = stdin.write_all(b"\n").await;
            });
        }
        let stdout = child.stdout.take().map(BufReader::new);
        let stderr = child.stderr.take().map(BufReader::new);
        let events = ctl.events.clone();
        let max_notices = self.max_stderr_notices;
        let stderr_task = tokio::spawn(async move {
            let Some(stderr) = stderr else { return };
            let mut lines = stderr.lines();
            let mut sent = 0;
            while let Ok(Some(line)) = lines.next_line().await {
                if sent < max_notices && !line.trim().is_empty() {
                    let _ = events.send(AdapterEvent::Progress { message: Some(line), checkpoint: None, percent: None });
                    sent += 1;
                }
            }
        });
        let events = ctl.events.clone();
        let reader = async move {
            let mut outcome = None;
            if let Some(stdout) = stdout {
                let mut lines = stdout.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
                    match parse_line(&value) {
                        Some(Parsed::Event(e)) => {
                            let _ = events.send(e);
                        }
                        Some(Parsed::Outcome(o)) => outcome = Some(o),
                        None => {}
                    }
                }
            }
            outcome
        };
        tokio::pin!(reader);
        let result = tokio::select! {
            _ = ctl.cancel.cancelled() => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                stderr_task.abort();
                return AdapterOutcome::Canceled;
            }
            outcome = &mut reader => outcome,
        };
        let status = child.wait().await;
        let _ = stderr_task.await;
        match (result, status) {
            (Some(o), _) => o,
            (None, Ok(s)) if s.success() => failure("adapter_no_result", "the agent exited without emitting a result"),
            (None, Ok(s)) => failure("adapter_exit", format!("the agent exited with {s}")),
            (None, Err(e)) => failure("adapter_wait_failed", e.to_string()),
        }
    }

    async fn on_message(&self, job: Job, ctl: JobCtl) -> Option<String> {
        match self.run(job, ctl).await {
            AdapterOutcome::Completed { result, .. } => result.get("reply").and_then(Value::as_str).map(String::from),
            _ => None,
        }
    }
}

pub struct HttpAdapter {
    pub url: String,
    pub client: reqwest::Client,
}

impl HttpAdapter {
    pub fn new(url: String) -> Self {
        Self { url, client: reqwest::Client::new() }
    }
}

#[async_trait]
impl Adapter for HttpAdapter {
    async fn run(&self, job: Job, ctl: JobCtl) -> AdapterOutcome {
        let request = self.client.post(&self.url).json(&job).send();
        let response = tokio::select! {
            _ = ctl.cancel.cancelled() => return AdapterOutcome::Canceled,
            r = request => r,
        };
        let response = match response {
            Ok(r) => r,
            Err(e) => return failure("adapter_unreachable", e.to_string()),
        };
        if !response.status().is_success() {
            return failure("adapter_http_error", format!("agent endpoint answered {}", response.status()));
        }
        let Ok(body) = response.json::<Value>().await else { return failure("adapter_bad_response", "the agent endpoint did not return JSON") };
        let body = if body.get("type").is_some() { body } else { json!({"type": "result", "result": body}) };
        match parse_line(&body) {
            Some(Parsed::Outcome(o)) => o,
            _ => failure("adapter_bad_response", "unrecognized adapter response"),
        }
    }

    async fn on_message(&self, job: Job, ctl: JobCtl) -> Option<String> {
        match self.run(job, ctl).await {
            AdapterOutcome::Completed { result, .. } => result.get("reply").and_then(Value::as_str).map(String::from),
            _ => None,
        }
    }
}

type CallbackFn = dyn Fn(Job, JobCtl) -> BoxFuture<'static, AdapterOutcome> + Send + Sync;

/// Embeds a Rust closure as the agent (tests, in-process agents).
pub struct CallbackAdapter {
    f: Arc<CallbackFn>,
}

impl CallbackAdapter {
    pub fn new<F>(f: F) -> Self
    where
        F: Fn(Job, JobCtl) -> BoxFuture<'static, AdapterOutcome> + Send + Sync + 'static,
    {
        Self { f: Arc::new(f) }
    }
}

#[async_trait]
impl Adapter for CallbackAdapter {
    async fn run(&self, job: Job, ctl: JobCtl) -> AdapterOutcome {
        (self.f)(job, ctl).await
    }
}

/// A sidecar without an agent attached.
pub struct NoAdapter;

#[async_trait]
impl Adapter for NoAdapter {
    async fn run(&self, _job: Job, _ctl: JobCtl) -> AdapterOutcome {
        failure("no_adapter", "this sidecar has no agent adapter configured")
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn probe(env_allow: &[&str]) -> ExecAdapter {
        let script = r#"printf '{"type":"result","result":{"manifest":"%s","path":"%s","fixed":"%s"}}\n' "$CARGO_MANIFEST_DIR" "$PATH" "$FIXED""#;
        ExecAdapter {
            command: vec!["sh".into(), "-c".into(), script.into()],
            env: BTreeMap::from([("FIXED".to_string(), "explicit".to_string())]),
            env_allow: env_allow.iter().map(|s| s.to_string()).collect(),
            max_stderr_notices: 0,
        }
    }

    async fn run(adapter: &ExecAdapter) -> Value {
        let job = Job {
            kind: "task".into(),
            task: json!({}),
            capability: json!({}),
            context_packs: vec![],
            inputs: vec![],
            fencing_token: 1,
            runtime_instance_id: "rt".into(),
            message: None,
        };
        let (events, _rx) = mpsc::unbounded_channel();
        let outcome =
            tokio::time::timeout(Duration::from_secs(10), adapter.run(job, JobCtl { events, cancel: CancellationToken::new() })).await.expect("probe finished");
        match outcome {
            AdapterOutcome::Completed { result, .. } => result,
            other => panic!("probe did not complete: {other:?}"),
        }
    }

    #[tokio::test]
    async fn executors_start_with_a_minimal_environment() {
        // cargo sets CARGO_MANIFEST_DIR for the test process, so it stands in for any secret in the sidecar's environment
        assert!(std::env::var("CARGO_MANIFEST_DIR").is_ok());
        let seen = run(&probe(&[])).await;
        assert_eq!(seen["manifest"], "", "variables outside the allowlist must not reach the child");
        assert_eq!(seen["path"].as_str().unwrap(), std::env::var("PATH").unwrap(), "PATH is on the default allowlist");
        assert_eq!(seen["fixed"], "explicit", "explicit values from the configuration are passed");
    }

    #[tokio::test]
    async fn allowlisted_variables_are_passed_and_explicit_values_win() {
        let seen = run(&probe(&["CARGO_MANIFEST_DIR"])).await;
        assert_eq!(seen["manifest"].as_str().unwrap(), std::env::var("CARGO_MANIFEST_DIR").unwrap());

        let mut overriding = probe(&["CARGO_MANIFEST_DIR"]);
        overriding.env.insert("CARGO_MANIFEST_DIR".into(), "pinned".into());
        assert_eq!(run(&overriding).await["manifest"], "pinned");
    }
}
