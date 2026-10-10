//! The SomeWork section of the dashboard: metadata about the agent-collaboration domain, never its content.
//! Every field that the domain does not expose, or that could not be read in the last sample, is an `Option`/empty
//! list so the UI can say "unknown" instead of inventing a value. Nothing here can carry a job input, a result,
//! a message body or an artifact: the server only copies allowlisted, length-limited identifiers and numbers, and the
//! short plain-text wording an agent gives its own jobs (label, what it waits for, how it ended).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::timestamp_ms;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SomeWork {
    /// When the domain was last read successfully.
    pub observed_at: Option<String>,
    pub error: Option<String>,
    pub server_time: String,
    pub domain: DomainHealth,
    pub agents: Vec<SwAgent>,
    pub work: Work,
    pub consumers: Vec<ConsumerLag>,
    pub events: Events,
    /// Model usage and cost from the central Prometheus; `None` when it is not configured or could not be read.
    pub usage: Option<UsageView>,
}

/// Tokens by kind and cost in US dollars over a period.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UsageAmount {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub cost_usd: f64,
}

impl UsageAmount {
    pub fn is_empty(&self) -> bool {
        self.input == 0 && self.output == 0 && self.cache_read == 0 && self.cache_write == 0 && self.cost_usd <= 0.0
    }
}

/// What one agent spent on one model, over the last 24 hours, 7 days and 30 days.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UsageRow {
    pub agent: String,
    pub provider: String,
    pub model: String,
    pub day: UsageAmount,
    pub week: UsageAmount,
    pub month: UsageAmount,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UsageView {
    pub observed_at: Option<String>,
    /// Most expensive over the last 30 days first.
    pub rows: Vec<UsageRow>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DomainHealth {
    pub domain_id: Option<String>,
    pub ready: Option<bool>,
    pub policy_version: Option<String>,
    pub object_store: Option<String>,
    pub audit: AuditStatus,
    pub outbox: Vec<OutboxSink>,
    pub denials_24h: Option<u64>,
    pub draft_catalog_entries: Option<u64>,
    pub online_runtimes: Option<u64>,
    pub runtime_restarts_total: Option<u64>,
    pub jetstream_redeliveries_total: Option<u64>,
    pub policy_allow_total: Option<u64>,
    pub policy_deny_total: Option<u64>,
    pub requests_total: Option<u64>,
    pub requests_server_errors: Option<u64>,
    pub requests_denied: Option<u64>,
    pub artifact_upload_bytes: Option<u64>,
    pub certificates: Vec<Certificate>,
    /// From the domain's `/v1/admin/system` (`ops.read`); all `None`/empty with a domain that does not have it.
    pub version: Option<String>,
    pub uptime_seconds: Option<u64>,
    pub database_bytes: Option<u64>,
    pub database_free_bytes: Option<u64>,
    pub wal_bytes: Option<u64>,
    pub migrations_applied: Option<u64>,
    pub principals: Vec<PrincipalState>,
    /// Things the dashboard would like to show but the domain API does not expose today.
    pub not_exposed: Vec<String>,
}

/// One principal of the domain: whether it may act and the most a grant of it may do (`read`, `write`, `irreversible`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PrincipalState {
    pub kind: String,
    pub id: String,
    pub status: String,
    pub side_effects: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AuditStatus {
    pub intact: Option<bool>,
    pub first_broken_seq: Option<i64>,
    pub checked_at: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OutboxSink {
    pub sink: String,
    pub pending: u64,
    pub failed: u64,
    pub dead: u64,
    pub published: u64,
    pub oldest_pending_age_seconds: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Certificate {
    pub name: String,
    pub not_after: Option<String>,
    pub days_left: Option<i64>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Liveness {
    Alive,
    Stale,
    Offline,
    #[default]
    Unknown,
}

impl Liveness {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Alive => "alive",
            Self::Stale => "stale",
            Self::Offline => "offline",
            Self::Unknown => "unknown",
        }
    }
    pub fn healthy(&self) -> bool {
        matches!(self, Self::Alive)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CapabilityRef {
    pub id: String,
    pub version: String,
    pub side_effects: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SwAgent {
    pub id: String,
    pub display_name: Option<String>,
    /// `provider` (advertises capabilities in an approved card) or `requester` (only talks).
    pub role: String,
    pub capabilities: Vec<CapabilityRef>,
    pub approval: Option<String>,
    pub availability: Option<String>,
    pub liveness: Liveness,
    pub last_seen_at: Option<String>,
    pub active_runtimes: u64,
    pub total_runtimes: u64,
    pub sdk: Option<String>,
    pub inbox_lag: Option<u64>,
    /// Jobs of this agent that run now and jobs that wait, from the job events it publishes.
    pub running_jobs: u64,
    pub waiting_jobs: u64,
    /// What the waiting jobs wait for, each once (`app-stack (held by verify SAD-1)`).
    pub blocked_on: Vec<String>,
}

/// What the agents' job events say: the jobs that wait or run now, the ones that finished lately, and how many started and ended per hour.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Work {
    /// Waiting and running jobs, longest-lived first.
    pub active: Vec<LiveJob>,
    /// Newest first.
    pub finished: Vec<LiveJob>,
    pub completed_24h: u64,
    pub failed_24h: u64,
    pub cancelled_24h: u64,
    /// Oldest first, one bucket per hour for the last 24 hours.
    pub throughput: Vec<HourBucket>,
    /// How far back the domain's event log reaches, so the 24 h numbers are not mistaken for more than they are.
    pub history_from: Option<String>,
}

/// One job as its agent's events tell it. `label` and `summary` are the agent's own short wording, shown as plain text.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LiveJob {
    pub id: String,
    pub agent: String,
    pub label: String,
    pub capability: Option<String>,
    pub requested_by: Option<String>,
    /// `waiting`, `running` or `finished`.
    pub state: String,
    /// What a waiting job waits for.
    pub waiting_for: Option<String>,
    /// When the job entered its present state.
    pub since: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub seconds: Option<f64>,
    /// `completed`, `failed` or `cancelled`, once finished.
    pub result: Option<String>,
    pub summary: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HourBucket {
    pub hour_start: String,
    pub started: u64,
    pub completed: u64,
    pub failed: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConsumerLag {
    pub stream: String,
    pub consumer: String,
    pub principal: Option<String>,
    pub kind: String,
    pub lag: u64,
}

/// The events part of the SomeWork view: rules, the counters of the pipeline, the hub that feeds it and what
/// the agents do with the events they are woken by. Metadata only: no event data, no handler source, no error text.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Events {
    /// False when the domain did not answer the rules request (an older domain without rules answers 404).
    pub rules_known: bool,
    pub rules: Vec<RuleView>,
    pub pipeline: Pipeline,
    pub hub: HubView,
    pub agents: Vec<AgentEvents>,
    /// Agents whose health endpoints are configured on this dashboard; 0 means the part stays "not configured".
    pub agents_configured: u64,
    /// The Grafana the log links point to (`GRAFANA_URL`), only when it is a plain https address.
    pub grafana_url: Option<String>,
    pub alerts: Vec<EventAlert>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RuleView {
    pub name: String,
    pub owner: String,
    pub selector: String,
    pub status: String,
    pub last_fired_at: Option<String>,
    pub fired: u64,
    /// Skipped firings by reason (duplicate, depth, rate, denied, error, paused).
    pub skipped: BTreeMap<String, u64>,
    /// Newest first.
    pub firings: Vec<Firing>,
}

impl RuleView {
    pub fn skipped_total(&self) -> u64 {
        self.skipped.values().sum()
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Firing {
    /// `pending`, `fired` or `skipped`.
    pub status: String,
    pub reason: Option<String>,
    pub at: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Pipeline {
    pub events_published: Option<u64>,
    pub events_duplicate: Option<u64>,
}

/// `not configured` (no hub address), `unreachable` (configured, last read failed) or `ok`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HubView {
    pub state: String,
    pub receiver_up: Option<bool>,
    pub receiver_queued: Option<u64>,
    pub receiver_oldest_age_seconds: Option<f64>,
    pub inbox_size: Option<u64>,
    pub sources: Vec<HubSource>,
    pub schedules: Vec<HubSchedule>,
    pub dead_letters: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HubSource {
    pub name: String,
    pub received: u64,
    pub published: u64,
    pub duplicate: u64,
    pub dropped: u64,
    pub dead_lettered: u64,
    pub dead_letters: u64,
    pub forwarded: u64,
    pub failures: u64,
    /// Only known when the hub's admin statistics could be read.
    pub paused: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HubSchedule {
    pub name: String,
    pub next_run_at: Option<String>,
    pub ticks: u64,
    pub missed: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentEvents {
    pub id: String,
    /// False when the agent's status endpoint did not answer.
    pub reachable: bool,
    pub handlers: Vec<HandlerView>,
    pub pools: Option<TokenPools>,
    /// A log stream selector for this agent (`{container="somework-pi-agent-1"}`), from `agents-health.json`; with `Events::grafana_url` it makes a link.
    pub logs: Option<String>,
    /// How the agent is set up, from its `/profile` endpoint; `None` when it did not answer or is too old to have one.
    pub setup: Option<AgentSetup>,
    /// Its recent jobs, newest first, from its `/history` endpoint; empty when it did not answer or is too old to have one.
    pub jobs: Vec<JobView>,
}

/// One finished job of an agent, from its own journal: what it was about, how it ended and what it cost. `summary` is the agent's short redacted
/// wording of the outcome (a verdict's notes, a fix's description, a failure message), shown as plain text.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct JobView {
    pub job: String,
    pub capability: String,
    /// `completed` or `failed`.
    pub state: String,
    pub outcome: Option<String>,
    /// A ticket key or an Aikido issue.
    pub subject: Option<String>,
    pub ended_at: Option<String>,
    pub started_at: Option<String>,
    pub seconds: Option<f64>,
    pub tokens: Option<u64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cost_usd: Option<f64>,
    pub summary: Option<String>,
    pub pr_url: Option<String>,
    pub branch: Option<String>,
    pub checks_passed: Option<u64>,
    pub checks_failed: Option<u64>,
}

/// An agent's setup as it describes itself: prompt, tools, budgets, model, repository access, conversation and event settings. Copied by name
/// from the agent's profile document, which holds no secret; text fields are length-limited and shown as plain text.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentSetup {
    pub role: String,
    pub version: String,
    /// Identifies the setup; the version and the prompt text are not part of it.
    pub hash: String,
    /// When the setup last changed (first seen with this hash by the agent).
    pub changed_at: Option<String>,
    pub capabilities: Vec<String>,
    pub model: String,
    pub allowed_models: Vec<String>,
    pub prompt_sha256: String,
    pub prompt_characters: u64,
    /// `None` when the agent was told not to show it (`PROFILE_PROMPT=0`).
    pub prompt: Option<String>,
    /// Every coding tool when the role names none.
    pub all_tools: bool,
    pub tools: Vec<String>,
    pub command_approvals: Vec<ApprovalPattern>,
    pub tool_approvals: Vec<String>,
    pub extra_approval_patterns: u64,
    pub default_tokens: u64,
    pub default_minutes: u64,
    pub budget_required: bool,
    pub max_tokens_cap: u64,
    pub max_minutes_cap: u64,
    pub daily_token_limit: u64,
    pub concurrency: u64,
    pub repository: RepositoryAccess,
    pub skills: Vec<String>,
    pub chat_mode: String,
    pub chat_approvers: Vec<String>,
    pub events_enabled: bool,
    pub events_notify_to: Option<String>,
    pub observe_enabled: bool,
    pub observe_scope: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ApprovalPattern {
    pub pattern: String,
    pub reason: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RepositoryAccess {
    pub push: bool,
    pub pull_request: bool,
    pub branch_prefix: String,
    pub no_repository: bool,
    /// `token`, `github-app` or `none`.
    pub credential: String,
    pub github_identity: Option<String>,
    pub token_hosts: Vec<String>,
    /// A note the operator keeps up to date (`GIT_TOKEN_EXPIRES`); a date, never the token.
    pub token_expires: Option<String>,
    pub draft_pull_requests: bool,
    pub mirror_repositories: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HandlerView {
    pub name: String,
    pub version: u64,
    pub enabled: bool,
    pub runs: u64,
    pub errors: u64,
    pub drops: u64,
    pub wakes: u64,
    /// A short code (`consecutive_failures`, `wake_rate`, `operator`, `other`), never the agent's own wording.
    pub disabled_reason: Option<String>,
    /// Whether the handler has a recorded error; the error text is never read.
    pub has_error: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TokenPools {
    pub jobs_used: u64,
    pub jobs_limit: u64,
    pub events_used: u64,
    pub events_limit: u64,
    pub throttled: bool,
    pub stopped: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EventAlert {
    /// `critical` or `warning`.
    pub severity: String,
    /// `pool_stopped`, `pool_throttled`, `handler_disabled`, `dead_letters`, `backlog`, `hub_unreachable`, `agent_unreachable`.
    pub kind: String,
    pub subject: String,
    pub text: String,
}

impl SwAgent {
    /// Liveness from the instants of the runtimes: alive within 90 s of a heartbeat, stale after that while the
    /// runtime is still registered, offline when every runtime has ended, unknown when the agent never ran one.
    pub fn classify(active: u64, total: u64, last_seen_ms: Option<i64>, now_ms: i64) -> Liveness {
        match (active, total, last_seen_ms) {
            (0, 0, _) => Liveness::Unknown,
            (0, _, _) => Liveness::Offline,
            (_, _, Some(seen)) if now_ms.saturating_sub(seen) <= 90_000 => Liveness::Alive,
            _ => Liveness::Stale,
        }
    }

    /// Re-evaluates a delivered liveness against the browser's clock so a frozen sample never keeps claiming `alive`.
    pub fn liveness_at(&self, now_ms: i64) -> Liveness {
        if self.liveness == Liveness::Alive
            && self.last_seen_at.as_deref().and_then(timestamp_ms).is_none_or(|seen| now_ms.saturating_sub(seen) > 120_000)
        {
            return Liveness::Stale;
        }
        self.liveness.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn liveness_is_conservative() {
        let now = 1_000_000;
        assert_eq!(SwAgent::classify(1, 3, Some(now - 30_000), now), Liveness::Alive);
        assert_eq!(SwAgent::classify(1, 3, Some(now - 91_000), now), Liveness::Stale);
        assert_eq!(SwAgent::classify(1, 1, None, now), Liveness::Stale);
        assert_eq!(SwAgent::classify(0, 2, Some(now), now), Liveness::Offline);
        assert_eq!(SwAgent::classify(0, 0, None, now), Liveness::Unknown);
    }

    #[test]
    fn a_frozen_sample_stops_claiming_alive() {
        let agent = SwAgent { liveness: Liveness::Alive, last_seen_at: Some("2026-10-05T10:00:00Z".into()), ..Default::default() };
        let seen = timestamp_ms("2026-10-05T10:00:00Z").unwrap();
        assert_eq!(agent.liveness_at(seen + 100_000), Liveness::Alive);
        assert_eq!(agent.liveness_at(seen + 130_000), Liveness::Stale);
    }

    #[test]
    fn unknown_fields_in_the_json_do_not_survive_a_round_trip() {
        let value: SomeWork = serde_json::from_str(r#"{"serverTime":"x","domain":{"domainId":"d","jobInput":"PRIVATE"},"extra":"PRIVATE"}"#).unwrap();
        assert!(!serde_json::to_string(&value).unwrap().contains("PRIVATE"));
    }
}

#[cfg(test)]
mod events_tests {
    use super::*;

    #[test]
    fn the_events_part_defaults_to_unknown_and_drops_unknown_fields() {
        let sample: SomeWork = serde_json::from_str(r#"{"serverTime":"x"}"#).unwrap();
        assert!(!sample.events.rules_known);
        assert!(sample.events.rules.is_empty() && sample.events.alerts.is_empty());
        let stuffed: SomeWork = serde_json::from_str(
            r#"{"serverTime":"x","events":{"rulesKnown":true,"rules":[{"name":"r","eventData":"PRIVATE","firings":[{"status":"fired","detail":"PRIVATE"}]}],"hub":{"state":"ok","headers":"PRIVATE"}}}"#,
        )
        .unwrap();
        assert!(!serde_json::to_string(&stuffed).unwrap().contains("PRIVATE"));
        assert_eq!(stuffed.events.rules[0].firings[0].status, "fired");
    }
}
