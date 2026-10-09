//! The events and reactions part of the SomeWork section: rules and their firings (domain, `ops.read`), the pipeline counters
//! (domain `/metrics` and the overview), the hub and receiver (hub `/metrics`, optional `/admin/stats`) and the handlers and token
//! pools reported by each agent's status endpoint.
//!
//! Same rule as the rest of the integration: every value is picked by name and passed through `identifier`/`count`; free text
//! (firing details, handler error messages, disabled reasons in the agent's own wording) is never read.

use crate::{
    prometheus::Metrics,
    somework::{count, identifier, iso, short, time_ms},
};
use fleet_shared::somework::{
    AgentEvents, EventAlert, Events, Firing, HandlerView, HubSchedule, HubSource, HubView, Pipeline, RuleView, TokenPools,
};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};

pub const MAX_RULES: usize = 60;
const FIRINGS_PER_RULE: usize = 5;
const BACKLOG_WARN_SECONDS: f64 = 300.0;
const SKIPPED_ALARM_MIN_FIRINGS: usize = 3;

/// A selector glob: topic characters plus `*`.
fn selector(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    let ok = !text.is_empty() && text.len() <= 120 && text.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '*' | '-'));
    ok.then(|| text.to_string())
}

fn label(series: &crate::prometheus::Series, name: &str) -> Option<String> {
    identifier(Some(&Value::String(series.labels.get(name)?.clone())))
}

fn number(value: Option<&Value>) -> Option<f64> {
    value?.as_f64().filter(|n| n.is_finite() && *n >= 0.0)
}

// ---------------------------------------------------------------- rules

/// The domain's rule-name alphabet; also what makes a name safe to put into a request path.
fn rule_name(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    let ok = (1..=64).contains(&text.len())
        && text.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && text.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'));
    ok.then(|| text.to_string())
}

/// Rules in a `GET /v1/rules` answer with the fingerprint that tells whether their firings must be read again.
pub fn rule_names(rules: Option<&Value>) -> Vec<(String, (u64, u64))> {
    rules
        .and_then(|body| body.get("rules"))
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|rule| Some((rule_name(rule.get("name"))?, rule_fingerprint(rule)))).take(MAX_RULES).collect())
        .unwrap_or_default()
}

fn counters(rule: &Value) -> (u64, BTreeMap<String, u64>) {
    let counters = rule.get("counters");
    let fired = count(counters.and_then(|c| c.get("fired"))).unwrap_or(0);
    let skipped = counters
        .and_then(|c| c.get("skipped"))
        .and_then(Value::as_object)
        .map(|map| map.iter().filter_map(|(reason, n)| Some((identifier(Some(&Value::String(reason.clone())))?, count(Some(n))?))).filter(|(_, n)| *n > 0).collect())
        .unwrap_or_default();
    (fired, skipped)
}

/// What decides whether a rule's recent firings must be read again: the numbers that grow when it fires or skips.
pub fn rule_fingerprint(rule: &Value) -> (u64, u64) {
    let (fired, skipped) = counters(rule);
    (fired, skipped.values().sum())
}

fn firings(body: Option<&Value>) -> Vec<Firing> {
    body.and_then(|body| body.get("firings"))
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .take(FIRINGS_PER_RULE)
                .map(|firing| Firing {
                    status: identifier(firing.get("status")).unwrap_or_else(|| "unknown".into()),
                    reason: identifier(firing.get("reason")),
                    task: identifier(firing.get("taskId")).map(|id| short(&id)),
                    at: time_ms(firing.get("decidedAt")).or_else(|| time_ms(firing.get("createdAt"))).and_then(iso),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn rules(body: Option<&Value>, recent: &BTreeMap<String, Value>) -> Vec<RuleView> {
    body.and_then(|body| body.get("rules"))
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .take(MAX_RULES)
                .filter_map(|rule| {
                    let name = rule_name(rule.get("name"))?;
                    let reaction = rule.get("reaction").filter(|value| value.is_object());
                    let capability = reaction.and_then(|r| r.get("capability")).and_then(|c| {
                        let id = identifier(c.get("id"))?;
                        Some(match c.get("version").map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())) {
                            Some(version) => identifier(Some(&Value::String(format!("{id}@{version}")))).unwrap_or(id),
                            None => id,
                        })
                    });
                    let (fired, skipped) = counters(rule);
                    Some(RuleView {
                        owner: identifier(rule.get("owner")).unwrap_or_default(),
                        selector: selector(rule.get("selector")).unwrap_or_default(),
                        kind: if reaction.is_some() { "reaction" } else { "agent subscription" }.into(),
                        capability,
                        status: identifier(rule.get("status")).unwrap_or_else(|| "unknown".into()),
                        last_fired_at: time_ms(rule.get("lastFiredAt")).and_then(iso),
                        fired,
                        skipped,
                        firings: firings(recent.get(&name)),
                        name,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------- hub

/// What one read of the hub produced. `Unreachable` and `NotConfigured` keep their numbers unknown.
#[derive(Default)]
pub enum HubRead {
    #[default]
    NotConfigured,
    Unreachable,
    Read {
        metrics: Metrics,
        stats: Option<Value>,
    },
}

fn hub(read: &HubRead, now_ms: i64) -> HubView {
    let (metrics, stats) = match read {
        HubRead::NotConfigured => return HubView { state: "not configured".into(), ..Default::default() },
        HubRead::Unreachable => return HubView { state: "unreachable".into(), ..Default::default() },
        HubRead::Read { metrics, stats } => (metrics, stats.as_ref()),
    };
    let mut sources: BTreeMap<String, HubSource> = BTreeMap::new();
    fn entry(sources: &mut BTreeMap<String, HubSource>, name: String) -> &mut HubSource {
        let source = sources.entry(name.clone()).or_default();
        source.name = name;
        source
    }
    for (metric, apply) in [
        ("hub_events_received_total", (|s: &mut HubSource, n| s.received += n) as fn(&mut HubSource, u64)),
        ("hub_events_published_total", |s, n| s.published += n),
        ("hub_events_duplicate_total", |s, n| s.duplicate += n),
        ("hub_events_dropped_total", |s, n| s.dropped += n),
        ("hub_events_dead_lettered_total", |s, n| s.dead_lettered += n),
        ("hub_publish_failures_total", |s, n| s.failures += n),
        ("hub_forwarded_total", |s, n| s.forwarded += n),
        ("hub_dead_letters", |s, n| s.dead_letters += n),
    ] {
        for series in metrics.with_label(metric) {
            let Some(name) = label(series, "source") else { continue };
            if series.value.is_finite() && series.value >= 0.0 {
                apply(entry(&mut sources, name), series.value as u64);
            }
        }
    }
    for item in stats.and_then(|s| s.get("sources")).and_then(Value::as_array).into_iter().flatten() {
        if let Some(name) = identifier(item.get("name")) {
            entry(&mut sources, name).paused = item.get("paused").and_then(Value::as_bool);
        }
    }

    let mut schedules: BTreeMap<String, HubSchedule> = BTreeMap::new();
    for series in metrics.with_label("hub_clock_ticks_total") {
        let Some(name) = label(series, "schedule") else { continue };
        let schedule = schedules.entry(name.clone()).or_insert_with(|| HubSchedule { name, ..Default::default() });
        let n = series.value.max(0.0) as u64;
        match label(series, "outcome").as_deref() {
            Some("missed") | Some("skipped") => schedule.missed += n,
            _ => schedule.ticks += n,
        }
    }
    for item in stats.and_then(|s| s.get("schedules")).and_then(Value::as_array).into_iter().flatten() {
        if let Some(name) = identifier(item.get("name")) {
            let schedule = schedules.entry(name.clone()).or_insert_with(|| HubSchedule { name, ..Default::default() });
            schedule.next_run_at = time_ms(item.get("nextRunAt")).filter(|at| *at > now_ms - 86_400_000).and_then(iso);
        }
    }
    let receiver_stats = stats.and_then(|s| s.get("receiver"));
    let dead_letters = sources.values().map(|s| s.dead_letters).sum();
    HubView {
        state: "ok".into(),
        receiver_up: metrics.max("hub_receiver_up").map(|value| value >= 1.0),
        receiver_queued: metrics.count("hub_receiver_queued").or_else(|| count(receiver_stats.and_then(|r| r.get("queued")))),
        receiver_oldest_age_seconds: metrics
            .max("hub_receiver_oldest_pending_age_seconds")
            .or_else(|| number(receiver_stats.and_then(|r| r.get("oldestAgeSeconds"))))
            .filter(|v| v.is_finite() && *v >= 0.0),
        inbox_size: metrics.count("hub_inbox_size"),
        sources: sources.into_values().collect(),
        schedules: schedules.into_values().collect(),
        dead_letters,
    }
}

// ---------------------------------------------------------------- agents

/// One agent's status endpoint: `None` when it did not answer.
pub struct AgentRead {
    pub id: String,
    pub logs: Option<String>,
    pub status: Option<Value>,
    /// The agent's `/profile` document, when its status address ends in `/status` and the agent answered.
    pub profile: Option<Value>,
    /// The agent's `/history` document (its recent jobs), under the same conditions.
    pub history: Option<Value>,
}

fn disabled_code(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.to_lowercase();
    let code = if text.contains("consecutive") || text.contains("error") || text.contains("timeout") {
        "consecutive_failures"
    } else if text.contains("wake") || text.contains("rate") {
        "wake_rate"
    } else if text.contains("operator") || text.contains("control") || text.contains("kill") {
        "operator"
    } else {
        "other"
    };
    Some(code.into())
}

fn handlers(status: &Value) -> Vec<HandlerView> {
    status
        .get("handlers")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .take(40)
                .filter_map(|handler| {
                    let enabled = handler.get("enabled").and_then(Value::as_bool).unwrap_or(false);
                    Some(HandlerView {
                        name: identifier(handler.get("name"))?,
                        version: count(handler.get("version")).unwrap_or(0),
                        enabled,
                        runs: count(handler.get("runs")).unwrap_or(0),
                        errors: count(handler.get("errors")).unwrap_or(0),
                        drops: count(handler.get("drops")).unwrap_or(0),
                        wakes: count(handler.get("wakes")).unwrap_or(0),
                        disabled_reason: if enabled { None } else { disabled_code(handler.get("disabledReason")).or(Some("other".into())) },
                        has_error: handler.get("lastError").is_some_and(|error| error.as_str().is_some_and(|text| !text.is_empty())),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn pools(status: &Value) -> Option<TokenPools> {
    let pools = status.get("tokenPools")?;
    let (tasks, events) = (pools.get("tasks")?, pools.get("events")?);
    Some(TokenPools {
        tasks_used: count(tasks.get("used")).unwrap_or(0),
        tasks_limit: count(tasks.get("limit")).unwrap_or(0),
        events_used: count(events.get("used")).unwrap_or(0),
        events_limit: count(events.get("limit")).unwrap_or(0),
        throttled: events.get("throttled").and_then(Value::as_bool).unwrap_or(false),
        stopped: events.get("stopped").and_then(Value::as_bool).unwrap_or(false),
    })
}

fn agents(reads: &[AgentRead]) -> Vec<AgentEvents> {
    let mut out: Vec<AgentEvents> = reads
        .iter()
        .map(|read| AgentEvents {
            id: read.id.clone(),
            reachable: read.status.is_some(),
            handlers: read.status.as_ref().map(handlers).unwrap_or_default(),
            pools: read.status.as_ref().and_then(pools),
            setup: read.profile.as_ref().and_then(crate::setup::setup),
            jobs: read.history.as_ref().map(crate::history::jobs).unwrap_or_default(),
            logs: read.logs.clone(),
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

// ---------------------------------------------------------------- pipeline and alerts

fn pipeline(domain_metrics: Option<&Metrics>, pending_approvals: Option<u64>) -> Pipeline {
    let skipped = domain_metrics
        .map(|metrics| {
            let mut by_reason = BTreeMap::new();
            for series in metrics.with_label("somework_reactions_skipped_total") {
                if let Some(reason) = label(series, "reason") {
                    *by_reason.entry(reason).or_insert(0) += series.value.max(0.0) as u64;
                }
            }
            by_reason
        })
        .unwrap_or_default();
    Pipeline {
        events_published: domain_metrics.and_then(|m| m.count("somework_events_published_total")),
        events_duplicate: domain_metrics.and_then(|m| m.count("somework_events_duplicate_total")),
        reactions_fired: domain_metrics.and_then(|m| m.count("somework_reactions_fired_total")),
        reactions_skipped: skipped,
        pending_approvals,
    }
}

fn alert(severity: &str, kind: &str, subject: &str, text: String) -> EventAlert {
    EventAlert { severity: severity.into(), kind: kind.into(), subject: subject.into(), text }
}

fn span(seconds: f64) -> String {
    let seconds = seconds.max(0.0) as u64;
    if seconds < 60 { format!("{seconds} s") } else { format!("{} min", seconds / 60) }
}

pub fn alerts(rules: &[RuleView], hub: &HubView, agents: &[AgentEvents], agents_expected: bool) -> Vec<EventAlert> {
    let mut out = Vec::new();
    for agent in agents {
        if !agent.reachable {
            out.push(alert("warning", "agent_unreachable", &agent.id, "status endpoint did not answer".into()));
            continue;
        }
        if let Some(pools) = &agent.pools {
            if pools.stopped {
                out.push(alert("critical", "pool_stopped", &agent.id, format!("events token pool is used up ({} of {}), wakes have stopped", pools.events_used, pools.events_limit)));
            } else if pools.throttled {
                out.push(alert("warning", "pool_throttled", &agent.id, format!("events token pool is throttled ({} of {})", pools.events_used, pools.events_limit)));
            }
        }
        for handler in agent.handlers.iter().filter(|handler| !handler.enabled) {
            let reason = handler.disabled_reason.clone().unwrap_or_else(|| "other".into());
            out.push(alert("warning", "handler_disabled", &format!("{}/{}", agent.id, handler.name), format!("handler is disabled ({reason})")));
        }
    }
    if agents_expected && agents.is_empty() {
        out.push(alert("warning", "agent_unreachable", "agents", "no agent status could be read".into()));
    }
    if hub.state == "unreachable" {
        out.push(alert("warning", "hub_unreachable", "hub", "the hub did not answer the last read".into()));
    }
    if hub.dead_letters > 0 {
        out.push(alert("critical", "dead_letters", "hub", format!("{} webhook(s) in the dead-letter store", hub.dead_letters)));
    }
    if hub.receiver_up == Some(false) {
        out.push(alert("critical", "backlog", "receiver", "the hub cannot reach the receiver".into()));
    }
    if let Some(age) = hub.receiver_oldest_age_seconds.filter(|age| *age > BACKLOG_WARN_SECONDS) {
        out.push(alert("warning", "backlog", "receiver", format!("oldest queued webhook is {} old", span(age))));
    }
    for rule in rules.iter().filter(|rule| rule.kind == "reaction" && rule.status == "active") {
        let decided: Vec<&Firing> = rule.firings.iter().filter(|firing| firing.status == "fired" || firing.status == "skipped").collect();
        if decided.len() >= SKIPPED_ALARM_MIN_FIRINGS && decided.iter().all(|firing| firing.status == "skipped") {
            let reason = decided.iter().find_map(|firing| firing.reason.clone()).unwrap_or_else(|| "unknown".into());
            out.push(alert("warning", "rule_skipped", &rule.name, format!("the last {} firings were all skipped ({reason})", decided.len())));
        }
    }
    out.sort_by(|a, b| (a.severity != "critical").cmp(&(b.severity != "critical")).then_with(|| a.kind.cmp(&b.kind)).then_with(|| a.subject.cmp(&b.subject)));
    out
}

// ---------------------------------------------------------------- assembly

#[derive(Default)]
pub struct EventInputs {
    pub rules: Option<Value>,
    /// Recent firings by rule name (the body of `GET /v1/rules/{name}/firings`).
    pub firings: BTreeMap<String, Value>,
    pub hub: HubRead,
    pub agents: Vec<AgentRead>,
    pub agents_configured: u64,
    pub grafana_url: Option<String>,
}

pub fn assemble(inputs: &EventInputs, domain_metrics: Option<&Metrics>, pending_approvals: Option<u64>, now_ms: i64) -> Events {
    let rules = rules(inputs.rules.as_ref(), &inputs.firings);
    let hub = hub(&inputs.hub, now_ms);
    let agents = agents(&inputs.agents);
    let alerts = alerts(&rules, &hub, &agents, inputs.agents_configured > 0);
    Events {
        rules_known: inputs.rules.is_some(),
        rules,
        pipeline: pipeline(domain_metrics, pending_approvals),
        hub,
        agents,
        agents_configured: inputs.agents_configured,
        grafana_url: inputs.grafana_url.clone(),
        alerts,
    }
}

// ---------------------------------------------------------------- readers for the hub and the agents

pub struct HubClient {
    http: reqwest::Client,
    base: String,
    bearer: Option<String>,
}

impl HubClient {
    pub fn new(base: String, ca_pem: Option<&str>, bearer: Option<String>, allow_plain_http: bool) -> Result<Self, String> {
        let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(4)).connect_timeout(Duration::from_secs(3));
        if base.starts_with("https://") {
            let pem = ca_pem.ok_or("HUB_URL is https but hub-ca.pem is missing from the secrets directory")?;
            if crate::certs::pem_certificates(pem).is_empty() {
                return Err("the hub CA file holds no certificate".into());
            }
            let certificate = reqwest::Certificate::from_pem(pem.as_bytes()).map_err(|_| "the hub CA is not a PEM certificate".to_string())?;
            builder = builder.https_only(true).tls_built_in_root_certs(false).add_root_certificate(certificate);
        } else if !allow_plain_http {
            return Err("HUB_URL must be https".into());
        }
        reqwest::Url::parse(&base).map_err(|_| "HUB_URL is not a URL".to_string())?;
        Ok(Self { http: builder.build().map_err(|_| "cannot build the HTTP client".to_string())?, base: base.trim_end_matches('/').to_string(), bearer })
    }

    /// The hub's `/metrics` (no authentication) and, when a bearer is configured, its `/admin/stats` (a 404 from a hub
    /// without that route just leaves paused flags and next runs unknown).
    pub async fn read(&self) -> HubRead {
        let metrics = match self.http.get(format!("{}/metrics", self.base)).send().await {
            Ok(response) if response.status().is_success() => response.text().await.ok().map(|text| Metrics::parse(&text)),
            _ => None,
        };
        let Some(metrics) = metrics else { return HubRead::Unreachable };
        let stats = match &self.bearer {
            Some(token) => match self.http.get(format!("{}/admin/stats", self.base)).bearer_auth(token).send().await {
                Ok(response) if response.status().is_success() => response.json::<Value>().await.ok(),
                _ => None,
            },
            None => None,
        };
        HubRead::Read { metrics, stats }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct AgentTarget {
    pub id: String,
    pub url: String,
    /// Optional `logs` of the entry: a stream selector for the agent's logs, shown as a link to Grafana.
    pub logs: Option<String>,
}

/// One to three `label="value"` / `label=~"value"` matchers in braces, from a small alphabet: enough for `{container="x"}`, no pipeline stages.
pub fn log_selector(text: &str) -> Option<String> {
    let inner = text.trim().strip_prefix('{')?.strip_suffix('}')?;
    let matchers: Vec<&str> = inner.split(',').map(str::trim).collect();
    if matchers.is_empty() || matchers.len() > 3 {
        return None;
    }
    for matcher in &matchers {
        let (name, rest) = matcher.split_once('=')?;
        let value = rest.strip_prefix('~').unwrap_or(rest);
        let quoted = value.strip_prefix('"')?.strip_suffix('"')?;
        let name_ok = !name.is_empty() && name.len() <= 32 && name.chars().all(|c| c.is_ascii_lowercase() || c == '_');
        let value_ok = !quoted.is_empty() && quoted.len() <= 80 && quoted.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | '/' | ':' | '*' | '+' | '|' | ' '));
        if !name_ok || !value_ok {
            return None;
        }
    }
    Some(format!("{{{}}}", matchers.join(",")))
}

/// `GRAFANA_URL`: a plain https address without credentials, path or query.
pub fn grafana_base(text: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(text.trim()).ok()?;
    let ok = parsed.scheme() == "https" && parsed.host_str().is_some() && parsed.username().is_empty() && parsed.password().is_none() && parsed.query().is_none() && parsed.fragment().is_none() && matches!(parsed.path(), "" | "/");
    ok.then(|| parsed.origin().ascii_serialization())
}

/// `agents-health.json`: `[{"id": "agent/pi-agent", "url": "http://10.10.10.11:8081/status"}, ...]`.
pub fn parse_agent_targets(contents: &[u8]) -> Result<Vec<AgentTarget>, String> {
    let list: Vec<Value> = serde_json::from_slice(contents).map_err(|_| "agents-health.json is not a JSON list".to_string())?;
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for item in list.iter().take(40) {
        let id = identifier(item.get("id")).ok_or("an agents-health.json entry has no usable id")?;
        let url = item.get("url").and_then(Value::as_str).unwrap_or_default();
        let parsed = reqwest::Url::parse(url).map_err(|_| format!("agents-health.json: {id} has no valid url"))?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.username() != "" || parsed.password().is_some() || parsed.query().is_some() {
            return Err(format!("agents-health.json: {id}: the url must be plain http(s) without credentials or a query"));
        }
        if seen.insert(id.clone()) {
            out.push(AgentTarget { id, url: url.to_string(), logs: item.get("logs").and_then(Value::as_str).and_then(log_selector) });
        }
    }
    Ok(out)
}

pub async fn read_agents(http: &reqwest::Client, targets: &[AgentTarget]) -> Vec<AgentRead> {
    let mut set = tokio::task::JoinSet::new();
    for target in targets {
        let (http, target) = (http.clone(), target.clone());
        set.spawn(async move {
            let status = fetch_json(&http, &target.url).await;
            let profile = match profile_url(&target.url) {
                Some(url) if status.is_some() => fetch_json(&http, &url).await,
                _ => None,
            };
            let history = match sibling_url(&target.url, &format!("history?limit={HISTORY_LIMIT}")) {
                Some(url) if status.is_some() => fetch_json(&http, &url).await,
                _ => None,
            };
            AgentRead { id: target.id, logs: target.logs, status, profile, history }
        });
    }
    let mut out = Vec::new();
    while let Some(done) = set.join_next().await {
        if let Ok(read) = done {
            out.push(read);
        }
    }
    out
}

async fn fetch_json(http: &reqwest::Client, url: &str) -> Option<Value> {
    match http.get(url).send().await {
        Ok(response) if response.status().is_success() => response.json::<Value>().await.ok(),
        _ => None,
    }
}

/// The profile and the history live next to the status document on the same health port: `…/status` -> `…/profile`.
fn profile_url(status_url: &str) -> Option<String> {
    sibling_url(status_url, "profile")
}

fn sibling_url(status_url: &str, path: &str) -> Option<String> {
    status_url.strip_suffix("/status").map(|base| format!("{base}/{path}"))
}

const HISTORY_LIMIT: usize = 200;

pub fn agent_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(Duration::from_secs(3)).connect_timeout(Duration::from_secs(2)).build().map_err(|_| "cannot build the HTTP client".to_string())
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_790_000_000_000;

    fn domain_rules() -> Value {
        json!({"rules": [
            {"name": "pr-review-opened", "owner": "automation/pr-review", "selector": "github.pull_request.opened", "status": "active",
             "description": "PRIVATE DESCRIPTION", "where": [{"path": "/data/draft", "equals": "PRIVATE WHERE"}],
             "reaction": {"capability": {"id": "code.review", "version": "3"}, "input": {"repo": "PRIVATE TEMPLATE ${/data/x}"}, "budget": {"maxTokens": 1}},
             "lastFiredAt": "2026-10-05T10:00:00Z", "counters": {"fired": 4, "skipped": {"duplicate": 2, "rate": 0, "approval": 1}}},
            {"name": "alerts-to-manager", "owner": "agent/manager", "selector": "grafana.alert.*", "status": "paused", "wake": true,
             "counters": {"fired": 0, "skipped": {}}},
            {"name": "bad name!", "owner": "x", "selector": "<script>", "status": "active"}
        ]})
    }

    fn firings_body(statuses: &[(&str, Option<&str>)]) -> Value {
        json!({"firings": statuses.iter().enumerate().map(|(i, (status, reason))| json!({
            "rule": "pr-review-opened", "eventId": format!("evt_PRIVATE{i}"), "status": status, "reason": reason,
            "detail": "PRIVATE DETAIL error: password=hunter2", "taskId": format!("tsk_01ABCDEFGH{i}"), "approvalId": "apr_x",
            "createdAt": "2026-10-05T09:00:00Z", "decidedAt": "2026-10-05T09:00:01Z", "data": "PRIVATE EVENT DATA"
        })).collect::<Vec<_>>()})
    }

    fn metrics(text: &str) -> Metrics {
        Metrics::parse(text)
    }

    const HUB_METRICS: &str = r#"
hub_events_received_total{source="github"} 12
hub_events_published_total{source="github"} 10
hub_events_duplicate_total{source="github"} 2
hub_events_dropped_total{reason="no_event",source="github"} 1
hub_events_received_total{source="jira"} 3
hub_events_published_total{source="jira"} 3
hub_events_dead_lettered_total{kind="permanent",source="jira"} 1
hub_dead_letters{source="jira"} 1
hub_publish_failures_total{kind="transient",source="jira"} 4
hub_events_received_total{source="evil <b>"} 9
hub_clock_ticks_total{outcome="published",schedule="nightly_digest"} 5
hub_clock_ticks_total{outcome="missed",schedule="nightly_digest"} 1
hub_receiver_up 1
hub_receiver_queued 2
hub_receiver_oldest_pending_age_seconds 420
hub_inbox_size 0
"#;

    fn pool_status(events_used: u64, throttled: bool, stopped: bool) -> Value {
        json!({"handlers": [
            {"name": "triage", "version": 3, "hash": "PRIVATEHASH", "enabled": true, "runs": 40, "errors": 1, "drops": 30, "wakes": 9, "lastError": "PRIVATE ERROR TEXT"},
            {"name": "flaky", "version": 1, "enabled": false, "runs": 12, "errors": 5, "drops": 0, "wakes": 0, "disabledReason": "5 consecutive errors: PRIVATE REASON"}],
            "tokenPools": {"tasks": {"used": 10, "limit": 700}, "events": {"used": events_used, "limit": 300, "throttled": throttled, "stopped": stopped}},
            "events": {"dropped": [{"summary": "PRIVATE DROPPED SAMPLE"}]}})
    }

    #[test]
    fn rules_show_counters_and_recent_firings_without_content() {
        let mut inputs = EventInputs { rules: Some(domain_rules()), ..Default::default() };
        inputs.firings.insert("pr-review-opened".into(), firings_body(&[("fired", None), ("skipped", Some("duplicate"))]));
        let events = assemble(&inputs, None, None, NOW);
        assert!(events.rules_known);
        assert_eq!(events.rules.len(), 2, "a rule with an unusable name is left out");
        let review = &events.rules[0];
        assert_eq!((review.kind.as_str(), review.status.as_str()), ("reaction", "active"));
        assert_eq!(review.capability.as_deref(), Some("code.review@3"));
        assert_eq!(review.fired, 4);
        assert_eq!(review.skipped.get("duplicate"), Some(&2));
        assert!(!review.skipped.contains_key("rate"), "zero counters are not listed");
        assert_eq!(review.skipped_total(), 3);
        assert_eq!(review.firings.len(), 2);
        assert_eq!(review.firings[1].reason.as_deref(), Some("duplicate"));
        assert!(review.firings[0].task.as_deref().is_some_and(|task| task.starts_with('…') || task.len() <= 8));
        let manager = &events.rules[1];
        assert_eq!((manager.kind.as_str(), manager.status.as_str(), manager.selector.as_str()), ("agent subscription", "paused", "grafana.alert.*"));
    }

    #[test]
    fn nothing_content_bearing_reaches_the_output() {
        let mut inputs = EventInputs {
            rules: Some(domain_rules()),
            hub: HubRead::Read {
                metrics: metrics(HUB_METRICS),
                stats: Some(json!({"sources": [{"name": "github", "paused": false, "token": "PRIVATE TOKEN"}], "schedules": [{"name": "nightly_digest", "nextRunAt": "2026-10-06T00:30:00Z", "cron": "PRIVATE CRON"}],
                    "receiver": {"queued": 2, "headers": "PRIVATE HEADERS"}, "extra": "PRIVATE"})),
            },
            agents: vec![AgentRead { logs: None, profile: None, history: None, id: "agent/triage".into(), status: Some(pool_status(10, false, false)) }],
            agents_configured: 1,
            ..Default::default()
        };
        let domain_metrics = metrics("somework_events_published_total 7\nsomework_reactions_skipped_total{reason=\"rate\"} 2\nsomework_reactions_skipped_total{reason=\"PRIVATE REASON WITH SPACES\"} 1\n");
        inputs.firings.insert("pr-review-opened".into(), firings_body(&[("skipped", Some("error")), ("fired", None)]));
        let output = serde_json::to_string(&assemble(&inputs, Some(&domain_metrics), Some(2), NOW)).unwrap();
        assert!(!output.contains("PRIVATE"), "leaked: {output}");
        assert!(!output.contains("hunter2"), "leaked: {output}");
        assert!(!output.contains("<b>") && !output.contains("<script>"), "markup survived: {output}");
        assert!(output.contains("triage") && output.contains("code.review@3"), "allowlisted identities do show");
    }

    #[test]
    fn pipeline_counters_come_from_the_domain_metrics_and_stay_unknown_without_them() {
        let known = pipeline(
            Some(&metrics("somework_events_published_total 20\nsomework_events_duplicate_total 3\nsomework_reactions_fired_total 8\nsomework_reactions_skipped_total{reason=\"depth\"} 1\nsomework_reactions_skipped_total{reason=\"approval\"} 2\n")),
            Some(1),
        );
        assert_eq!((known.events_published, known.events_duplicate, known.reactions_fired, known.pending_approvals), (Some(20), Some(3), Some(8), Some(1)));
        assert_eq!(known.reactions_skipped.get("approval"), Some(&2));
        let unknown = pipeline(None, None);
        assert_eq!((unknown.events_published, unknown.reactions_fired), (None, None));
        assert!(unknown.reactions_skipped.is_empty());
    }

    #[test]
    fn the_hub_view_has_sources_schedules_and_receiver_lag() {
        let read = HubRead::Read {
            metrics: metrics(HUB_METRICS),
            stats: Some(json!({"sources": [{"name": "jira", "paused": true}], "schedules": [{"name": "nightly_digest", "nextRunAt": "2026-10-06T00:30:00Z"}]})),
        };
        let view = hub(&read, NOW);
        assert_eq!(view.state, "ok");
        let github = view.sources.iter().find(|s| s.name == "github").unwrap();
        assert_eq!((github.received, github.published, github.duplicate, github.dropped, github.paused), (12, 10, 2, 1, None));
        let jira = view.sources.iter().find(|s| s.name == "jira").unwrap();
        assert_eq!((jira.dead_lettered, jira.dead_letters, jira.failures, jira.paused), (1, 1, 4, Some(true)));
        assert!(!view.sources.iter().any(|s| s.name.contains('<')), "a label outside the alphabet is dropped");
        assert_eq!(view.dead_letters, 1);
        assert_eq!((view.receiver_up, view.receiver_queued, view.receiver_oldest_age_seconds, view.inbox_size), (Some(true), Some(2), Some(420.0), Some(0)));
        let schedule = &view.schedules[0];
        assert_eq!((schedule.name.as_str(), schedule.ticks, schedule.missed), ("nightly_digest", 5, 1));
        assert!(schedule.next_run_at.as_deref().is_some_and(|at| at.starts_with("2026-10-06T00:30")));
    }

    #[test]
    fn a_hub_that_is_absent_or_down_is_said_so_not_invented() {
        assert_eq!(hub(&HubRead::NotConfigured, NOW).state, "not configured");
        let down = hub(&HubRead::Unreachable, NOW);
        assert_eq!(down.state, "unreachable");
        assert!(down.sources.is_empty() && down.receiver_queued.is_none());
        let metrics_only = hub(&HubRead::Read { metrics: metrics(HUB_METRICS), stats: None }, NOW);
        assert!(metrics_only.sources.iter().all(|s| s.paused.is_none()), "without admin statistics the paused flag stays unknown");
        assert!(metrics_only.schedules[0].next_run_at.is_none());
    }

    #[test]
    fn handlers_and_pools_are_reduced_to_numbers_flags_and_a_reason_code() {
        let agents = agents(&[AgentRead { logs: None, profile: None, history: None, id: "agent/triage".into(), status: Some(pool_status(250, true, false)) }, AgentRead { logs: None, profile: None, history: None, id: "agent/down".into(), status: None }]);
        let triage = agents.iter().find(|a| a.id == "agent/triage").unwrap();
        assert!(triage.reachable);
        let flaky = triage.handlers.iter().find(|h| h.name == "flaky").unwrap();
        assert_eq!((flaky.enabled, flaky.disabled_reason.as_deref(), flaky.errors), (false, Some("consecutive_failures"), 5));
        let busy = triage.handlers.iter().find(|h| h.name == "triage").unwrap();
        assert_eq!((busy.enabled, busy.has_error, busy.wakes, busy.drops, busy.version), (true, true, 9, 30, 3));
        assert_eq!(busy.disabled_reason, None);
        let pools = triage.pools.clone().unwrap();
        assert_eq!((pools.events_used, pools.events_limit, pools.throttled, pools.stopped, pools.tasks_limit), (250, 300, true, false, 700));
        let down = agents.iter().find(|a| a.id == "agent/down").unwrap();
        assert!(!down.reachable && down.pools.is_none() && down.handlers.is_empty());
    }

    #[test]
    fn alerts_cover_stopped_pools_disabled_handlers_dead_letters_backlog_and_idle_rules() {
        let mut inputs = EventInputs {
            rules: Some(domain_rules()),
            hub: HubRead::Read { metrics: metrics(HUB_METRICS), stats: None },
            agents: vec![AgentRead { logs: None, profile: None, history: None, id: "agent/triage".into(), status: Some(pool_status(300, false, true)) }],
            agents_configured: 1,
            ..Default::default()
        };
        inputs.firings.insert("pr-review-opened".into(), firings_body(&[("skipped", Some("approval")), ("skipped", Some("approval")), ("skipped", Some("rate"))]));
        let alerts = assemble(&inputs, None, None, NOW).alerts;
        let kinds: Vec<(&str, &str)> = alerts.iter().map(|a| (a.severity.as_str(), a.kind.as_str())).collect();
        assert!(kinds.contains(&("critical", "pool_stopped")), "{kinds:?}");
        assert!(kinds.contains(&("critical", "dead_letters")), "{kinds:?}");
        assert!(kinds.contains(&("warning", "handler_disabled")), "{kinds:?}");
        assert!(kinds.contains(&("warning", "backlog")), "420 s is above the 5 minute line: {kinds:?}");
        assert!(kinds.contains(&("warning", "rule_skipped")), "{kinds:?}");
        assert_eq!(alerts[0].severity, "critical", "critical alerts sort first");
        assert!(alerts.iter().all(|a| !a.text.contains("PRIVATE")));
    }

    #[test]
    fn a_quiet_pipeline_raises_no_alert() {
        let mut inputs = EventInputs {
            rules: Some(domain_rules()),
            hub: HubRead::Read { metrics: metrics("hub_receiver_up 1\nhub_receiver_oldest_pending_age_seconds 4\nhub_dead_letters{source=\"github\"} 0\n"), stats: None },
            agents: vec![AgentRead { logs: None, profile: None, history: None, id: "agent/triage".into(), status: Some(json!({"handlers": [{"name": "triage", "enabled": true}], "tokenPools": {"tasks": {"used": 1, "limit": 10}, "events": {"used": 1, "limit": 10, "throttled": false, "stopped": false}}})) }],
            agents_configured: 1,
            ..Default::default()
        };
        inputs.firings.insert("pr-review-opened".into(), firings_body(&[("fired", None), ("skipped", Some("duplicate")), ("fired", None)]));
        assert_eq!(assemble(&inputs, None, None, NOW).alerts, Vec::<EventAlert>::new());
    }

    #[test]
    fn a_domain_without_rules_leaves_the_rules_unknown() {
        let events = assemble(&EventInputs::default(), None, None, NOW);
        assert!(!events.rules_known);
        assert!(events.rules.is_empty());
        assert_eq!(events.hub.state, "not configured");
        assert_eq!(events.agents_configured, 0);
        assert!(events.alerts.is_empty());
    }

    #[test]
    fn agent_targets_must_be_plain_urls_without_credentials() {
        let ok = parse_agent_targets(br#"[{"id":"agent/pi-agent","url":"http://10.10.10.11:8081/status"},{"id":"agent/pi-agent","url":"http://dup/status"}]"#).unwrap();
        assert_eq!(ok, vec![AgentTarget { id: "agent/pi-agent".into(), url: "http://10.10.10.11:8081/status".into(), logs: None }]);
        for bad in [
            r#"[{"id":"a b","url":"http://x/status"}]"#,
            r#"[{"id":"agent/x","url":"ftp://x/status"}]"#,
            r#"[{"id":"agent/x","url":"http://user:pw@x/status"}]"#,
            r#"[{"id":"agent/x","url":"http://x/status?token=1"}]"#,
            r#"{"not":"a list"}"#,
        ] {
            assert!(parse_agent_targets(bad.as_bytes()).is_err(), "{bad}");
        }
    }

    #[tokio::test]
    async fn a_hub_and_agents_stuffed_with_content_yield_only_metadata() {
        use axum::{Json, Router, routing::get};
        let status = pool_status(10, false, false);
        let app = Router::new()
            .route("/metrics", get(|| async { HUB_METRICS }))
            .route("/admin/stats", get(|| async { Json(json!({"sources": [{"name": "github", "paused": false}], "note": "PRIVATE"})) }))
            .route("/status", get(move || { let body = status.clone(); async move { Json(body) } }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let client = HubClient::new(base.clone(), None, Some("t".into()), true).unwrap();
        let HubRead::Read { metrics, stats } = client.read().await else { panic!("the hub answered") };
        assert!(stats.is_some());
        let reads = read_agents(&agent_http_client().unwrap(), &[AgentTarget { id: "agent/triage".into(), url: format!("{base}/status"), logs: None }, AgentTarget { id: "agent/gone".into(), url: "http://127.0.0.1:9/status".into(), logs: None }]).await;
        let events = assemble(&EventInputs { hub: HubRead::Read { metrics, stats }, agents: reads, agents_configured: 2, ..Default::default() }, None, None, NOW);
        assert_eq!(events.agents.iter().filter(|a| a.reachable).count(), 1);
        assert!(events.alerts.iter().any(|a| a.kind == "agent_unreachable" && a.subject == "agent/gone"));
        assert!(!serde_json::to_string(&events).unwrap().contains("PRIVATE"));

        let down = HubClient::new("http://127.0.0.1:9".into(), None, None, true).unwrap();
        assert!(matches!(down.read().await, HubRead::Unreachable));
    }

    #[tokio::test]
    async fn an_agents_history_is_read_with_a_limit_and_reduced_to_job_metadata() {
        use axum::{Json, Router, extract::RawQuery, routing::get};
        let app = Router::new().route("/status", get(|| async { Json(json!({"handlers": []})) })).route(
            "/history",
            get(|RawQuery(query): RawQuery| async move {
                assert_eq!(query.as_deref(), Some("limit=200"));
                Json(json!({"jobs": [{"taskId": "task_01ABCDEFGH", "capability": "qa.verify@1", "state": "completed", "outcome": "verified", "subject": "SAD-1", "secret": "PRIVATE"}]}))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let reads = read_agents(&agent_http_client().unwrap(), &[AgentTarget { id: "agent/qa".into(), url: format!("{base}/status"), logs: None }]).await;
        let events = assemble(&EventInputs { agents: reads, agents_configured: 1, ..Default::default() }, None, None, NOW);
        let jobs = &events.agents[0].jobs;
        assert_eq!((jobs.len(), jobs[0].subject.as_deref(), jobs[0].outcome.as_deref()), (1, Some("SAD-1"), Some("verified")));
        assert!(!serde_json::to_string(&events).unwrap().contains("PRIVATE"));
    }

    #[test]
    fn a_remote_hub_needs_tls_and_its_ca() {
        assert!(HubClient::new("http://hub:9000".into(), None, None, false).is_err());
        assert!(HubClient::new("https://hub:9000".into(), None, None, false).is_err());
        assert!(HubClient::new("https://hub:9000".into(), Some("not a certificate"), None, false).is_err());
    }
}

#[cfg(test)]
mod log_link_tests {
    use super::*;

    #[test]
    fn only_plain_stream_selectors_are_accepted() {
        assert_eq!(log_selector(r#"{container="somework-pi-agent-1"}"#).as_deref(), Some(r#"{container="somework-pi-agent-1"}"#));
        assert_eq!(log_selector(r#"{ host="admin-cloud-windows-2", service_name=~"windows.*" }"#).as_deref(), Some(r#"{host="admin-cloud-windows-2",service_name=~"windows.*"}"#));
        for bad in [r#"{container="x"} |= "password""#, r#"{container="a\b"}"#, "{}", r#"{a="1",b="2",c="3",d="4"}"#, r#"{Container="x"}"#, r#"{container="x;y"}"#, r#"{container="<b>"}"#, "container=x", r#"{container=x}"#] {
            assert_eq!(log_selector(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_grafana_address_must_be_plain_https() {
        assert_eq!(grafana_base("https://grafana.example/").as_deref(), Some("https://grafana.example"));
        assert_eq!(grafana_base("https://grafana.example:8443").as_deref(), Some("https://grafana.example:8443"));
        for bad in ["http://grafana.example", "https://u:p@grafana.example", "https://grafana.example/path", "https://grafana.example/?x=1", "javascript:alert(1)", ""] {
            assert_eq!(grafana_base(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_target_keeps_a_valid_selector_and_drops_an_invalid_one() {
        let targets = parse_agent_targets(br#"[{"id":"agent/a","url":"http://10.0.0.1:8081/status","logs":"{container=\"a\"}"},{"id":"agent/b","url":"http://10.0.0.1:8082/status","logs":"{container=\"b\"} |= \"x\""}]"#).unwrap();
        assert_eq!(targets[0].logs.as_deref(), Some(r#"{container="a"}"#));
        assert_eq!(targets[1].logs, None);
    }
}
