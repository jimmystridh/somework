//! An agent's `/history` document (its job journal) turned into what the dashboard shows about its work.
//!
//! Same rule as `setup.rs`: values are picked by name through a reader, nothing is copied wholesale. The only free wording is the summary the agent
//! wrote about the outcome (already redacted and length-limited on its side); it is shown as plain text.

use crate::somework::{count, identifier, short};
use fleet_shared::somework::JobView;
use serde_json::Value;

const MAX_JOBS: usize = 200;
const MAX_SUMMARY_CHARS: usize = 800;

fn text(value: Option<&Value>, max: usize) -> Option<String> {
    let raw = value?.as_str()?;
    let cleaned: String = raw.chars().filter(|c| !c.is_control() || matches!(c, '\n' | '\t')).take(max).collect();
    (!cleaned.trim().is_empty()).then_some(cleaned)
}

/// An RFC 3339 time: the characters a timestamp has, and nothing longer.
fn time(value: Option<&Value>) -> Option<String> {
    let raw = value?.as_str()?;
    let ok = raw.len() >= 10 && raw.len() <= 32 && raw.chars().all(|c| c.is_ascii_digit() || matches!(c, '-' | ':' | 'T' | 'Z' | '.' | '+'));
    ok.then(|| raw.to_string())
}

/// A pull request address on a code host: https, no credentials, no query, plain path characters.
fn pull_request(value: Option<&Value>) -> Option<String> {
    let raw = value?.as_str()?;
    let rest = raw.strip_prefix("https://")?;
    let ok = raw.len() <= 200 && !rest.contains('@') && rest.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '/' | '-' | '_')) && rest.contains('/');
    ok.then(|| raw.to_string())
}

fn branch(value: Option<&Value>) -> Option<String> {
    let raw = value?.as_str()?;
    let ok = !raw.is_empty() && raw.len() <= 120 && raw.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '/' | '-' | '_'));
    ok.then(|| raw.to_string())
}

fn money(value: Option<&Value>) -> Option<f64> {
    value?.as_f64().filter(|n| n.is_finite() && *n >= 0.0 && *n < 1.0e6)
}

fn subject(value: Option<&Value>) -> Option<String> {
    let raw = value?.as_str()?;
    let ok = !raw.is_empty() && raw.len() <= 60 && raw.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '#' | ' ' | '.' | ':'));
    ok.then(|| raw.to_string())
}

fn job(entry: &Value) -> Option<JobView> {
    let state = match entry.get("state").and_then(Value::as_str)? {
        "completed" => "completed",
        "failed" => "failed",
        _ => return None,
    };
    let source = if entry.get("source").and_then(Value::as_str) == Some("chat") { "chat" } else { "task" };
    let checks = entry.get("checks");
    Some(JobView {
        task: short(&identifier(entry.get("taskId"))?),
        capability: identifier(entry.get("capability"))?,
        source: source.into(),
        state: state.into(),
        outcome: identifier(entry.get("outcome")),
        subject: subject(entry.get("subject")),
        ended_at: time(entry.get("at")),
        started_at: time(entry.get("startedAt")),
        seconds: entry.get("ms").and_then(Value::as_f64).filter(|ms| ms.is_finite() && *ms >= 0.0).map(|ms| ms / 1000.0),
        tokens: count(entry.get("tokens")),
        input_tokens: count(entry.get("inputTokens")),
        output_tokens: count(entry.get("outputTokens")),
        cost_usd: money(entry.get("costUsd")),
        summary: text(entry.get("summary"), MAX_SUMMARY_CHARS),
        pr_url: pull_request(entry.get("prUrl")),
        branch: branch(entry.get("branch")),
        checks_passed: count(checks.and_then(|c| c.get("passed"))),
        checks_failed: count(checks.and_then(|c| c.get("failed"))),
    })
}

/// The jobs of a `/history` document, newest first as the agent sent them, at most `MAX_JOBS`.
pub fn jobs(document: &Value) -> Vec<JobView> {
    document.get("jobs").and_then(Value::as_array).map(|list| list.iter().filter_map(job).take(MAX_JOBS).collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_qa_verdict_and_an_aikido_fix_are_read_by_name() {
        let doc = json!({"jobs": [
            {"taskId": "task_01M4DHV0PE75CDMQNPG7H74Y2S", "capability": "qa.verify@1", "source": "task", "state": "completed", "at": "2026-10-08T11:06:28.475Z", "startedAt": "2026-10-08T10:58:45.418Z",
             "ms": 463057, "outcome": "not_fixed", "subject": "SAD-2512", "summary": "the grid still shows the old value", "checks": {"passed": 1, "failed": 2}, "tokens": 234926, "inputTokens": 200000, "outputTokens": 34926, "costUsd": 1.25},
            {"taskId": "task_B", "capability": "code.fix@1", "source": "task", "state": "completed", "at": "2026-10-08T12:00:00Z", "ms": 1000, "outcome": "pr_opened", "subject": "Aikido #50177726",
             "prUrl": "https://github.com/Visma-Administration/visma.administration/pull/5264", "branch": "agent/aikido-50177726-b6e2e3fd"}]});
        let out = jobs(&doc);
        assert_eq!(out.len(), 2);
        let qa = &out[0];
        assert_eq!((qa.task.as_str(), qa.capability.as_str(), qa.outcome.as_deref(), qa.subject.as_deref()), ("…G7H74Y2S", "qa.verify@1", Some("not_fixed"), Some("SAD-2512")));
        assert_eq!((qa.checks_passed, qa.checks_failed, qa.tokens, qa.input_tokens, qa.output_tokens), (Some(1), Some(2), Some(234926), Some(200000), Some(34926)));
        assert_eq!(qa.seconds.map(|s| s.round() as i64), Some(463));
        assert_eq!(qa.cost_usd, Some(1.25));
        assert_eq!(out[1].pr_url.as_deref(), Some("https://github.com/Visma-Administration/visma.administration/pull/5264"));
        assert_eq!(out[1].branch.as_deref(), Some("agent/aikido-50177726-b6e2e3fd"));
    }

    #[test]
    fn unknown_fields_and_unsafe_values_do_not_reach_the_page() {
        let doc = json!({"jobs": [{"taskId": "task_1", "capability": "x@1", "state": "completed", "secret": "SECRET", "token": "SECRET", "subject": "<script>", "prUrl": "https://user:pw@evil.example/x", "branch": "a b;c", "summary": "ok\u{7}\u{1b}[31m", "costUsd": -1}]});
        let out = jobs(&doc);
        assert_eq!(out.len(), 1);
        let rendered = format!("{:?}", out[0]);
        assert!(!rendered.contains("SECRET"), "{rendered}");
        assert_eq!((out[0].subject.as_ref(), out[0].pr_url.as_ref(), out[0].branch.as_ref(), out[0].cost_usd), (None, None, None, None));
        assert!(!out[0].summary.as_deref().unwrap_or_default().chars().any(|c| c.is_control()));
    }

    #[test]
    fn entries_without_a_known_state_or_identifiers_are_dropped_and_the_list_is_capped() {
        assert!(jobs(&json!({"jobs": [{"state": "running", "taskId": "t", "capability": "c@1"}, {"state": "failed"}]})).is_empty());
        let many: Vec<Value> = (0..300).map(|i| json!({"taskId": format!("task_{i}"), "capability": "c@1", "state": "failed"})).collect();
        assert_eq!(jobs(&json!({ "jobs": many })).len(), MAX_JOBS);
        assert!(jobs(&json!({"nothing": 1})).is_empty());
    }
}
