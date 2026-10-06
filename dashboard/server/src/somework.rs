//! SomeWork integration: reads the domain with the dashboard's own least-privilege principal (`ops.read`,
//! `audit.read`, `catalog.read`) and turns it into the metadata the dashboard may show.
//!
//! The allowlist is structural, not a filter: every value that reaches the output is picked by name from the
//! domain's JSON and passed through `identifier`/`count` (short, restricted character set, no free text). Task
//! inputs, results, message bodies, artifact contents and digests are never read.

use crate::{
    assertion::Identity,
    certs,
    events::{self, EventInputs},
    prometheus::Metrics,
};
use fleet_shared::{
    somework::{
        AuditStatus, Certificate, CapabilityRef, ConsumerLag, DomainHealth, FailureGroup, HourBucket, OutboxSink, PrincipalState, RecentTask,
        SomeWork, Stuck, SwAgent, Waiting, Work,
    },
    timestamp_ms,
};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
    time::{Duration, Instant},
};

const HOUR_MS: i64 = 3_600_000;
const STUCK_AFTER_MS: i64 = 10 * 60_000;
const MAX_TASKS: usize = 4000;
const PAGE: usize = 1000;
const MAX_PAGES: usize = 40;
const AUDIT_VERIFY_EVERY: Duration = Duration::from_secs(600);
const CERT_CHECK_EVERY: Duration = Duration::from_secs(3600);

pub const NOT_EXPOSED: [&str; 5] = [
    "Principal enabled/disabled state and side-effect level (needs principal.manage, which also allows changes)",
    "Database size and backup age (not part of the domain API)",
    "Domain version and uptime",
    "JetStream storage use (the broker's monitoring port is not exposed; consumer lag comes from the domain's metrics)",
    "Requested task content, results and messages (deliberately never read)",
];

// ---------------------------------------------------------------- allowlisted readers

/// A short identifier from a restricted alphabet, or nothing. Used for ids, capability names, states and actors.
pub(crate) fn identifier(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    let ok = !text.is_empty()
        && text.len() <= 96
        && text.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '/' | '@' | '~' | '+' | '-'));
    ok.then(|| text.to_string())
}

pub(crate) fn count(value: Option<&Value>) -> Option<u64> {
    value?.as_u64().or_else(|| value?.as_f64().filter(|n| n.is_finite() && *n >= 0.0).map(|n| n as u64))
}

pub(crate) fn time_ms(value: Option<&Value>) -> Option<i64> {
    timestamp_ms(value?.as_str()?)
}

pub(crate) fn iso(ms: i64) -> Option<String> {
    chrono::DateTime::from_timestamp_millis(ms).map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

/// `agent:agent/x` -> `agent/x`; other kinds keep their prefix.
fn actor(value: Option<&Value>) -> Option<String> {
    let text = identifier(value)?;
    Some(text.strip_prefix("agent:").map(str::to_string).unwrap_or(text))
}

pub(crate) fn short(id: &str) -> String {
    let tail: String = id.chars().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect();
    if id.chars().count() > 8 { format!("…{tail}") } else { tail }
}

// ---------------------------------------------------------------- the task book

#[derive(Clone, Debug, Default)]
struct Task {
    capability: Option<String>,
    state: String,
    attempts: u32,
    submitted_at: Option<i64>,
    running_at: Option<i64>,
    done_at: Option<i64>,
    updated_at: i64,
    waiting_since: Option<i64>,
    requester: Option<String>,
    assignee: Option<String>,
    failure_code: Option<String>,
}

/// What the domain's event stream and audit log have said about tasks, reduced to lifecycle facts.
#[derive(Default)]
pub struct TaskBook {
    tasks: HashMap<String, Task>,
    lease_expiries: std::collections::BTreeMap<i64, i64>,
    first_event_ms: Option<i64>,
}

impl TaskBook {
    pub fn apply_event(&mut self, event: &Value) {
        let kind = event.get("type").and_then(Value::as_str).unwrap_or_default();
        if !kind.starts_with("task.") {
            return;
        }
        let payload = event.get("payload");
        let field = |name: &str| payload.and_then(|p| p.get(name));
        let Some(id) = identifier(event.get("taskId")).or_else(|| identifier(field("taskId"))) else { return };
        let Some(at) = time_ms(event.get("createdAt")) else { return };
        self.first_event_ms = Some(self.first_event_ms.map_or(at, |first| first.min(at)));
        let capability = identifier(field("capabilityId")).map(|id| match identifier(field("capabilityVersion")) {
            Some(version) => format!("{id}@{version}"),
            None => id,
        });
        let task = self.tasks.entry(id).or_default();
        if capability.is_some() {
            task.capability = capability;
        }
        if let Some(attempt) = count(field("attempt")) {
            task.attempts = task.attempts.max(attempt as u32);
        }
        task.updated_at = task.updated_at.max(at);
        match kind {
            "task.queued" => {
                task.submitted_at.get_or_insert(at);
                task.state = "queued".into();
                task.waiting_since = None;
            }
            "task.requeued" => {
                task.state = "queued".into();
                task.waiting_since = None;
            }
            "task.claimed" | "task.running" => {
                task.running_at.get_or_insert(at);
                task.state = "running".into();
            }
            "task.progress" => {
                if task.state.is_empty() {
                    task.state = "running".into();
                }
            }
            "task.input_required" => {
                task.state = "input_required".into();
                task.waiting_since = Some(at);
            }
            "task.input_provided" => {
                task.state = "running".into();
                task.waiting_since = None;
            }
            "task.succeeded" | "task.failed" | "task.canceled" | "task.cancelled" | "task.expired" | "task.rejected" => {
                task.state = kind.trim_start_matches("task.").to_string();
                task.done_at = Some(at);
                task.waiting_since = None;
            }
            other => {
                if let Some(state) = identifier(field("state")) {
                    task.state = state;
                } else {
                    task.state = other.trim_start_matches("task.").to_string();
                }
            }
        }
        if self.tasks.len() > MAX_TASKS {
            self.prune(at);
        }
    }

    pub fn apply_audit(&mut self, row: &Value) {
        let action = row.get("action").and_then(Value::as_str).unwrap_or_default();
        let at = time_ms(row.get("occurredAt"));
        let detail = row.get("detail");
        if action == "task.lease_expired" {
            if let Some(at) = at {
                // keyed by the audit sequence (or the instant when a row has none), so a replayed row is never counted twice
                self.lease_expiries.insert(row.get("seq").and_then(Value::as_i64).unwrap_or(at), at);
            }
            return;
        }
        let Some(id) = identifier(row.get("taskId")) else { return };
        let who = actor(row.get("authenticatedActor"));
        match action {
            "task.submit" => {
                let task = self.tasks.entry(id).or_default();
                task.requester = who;
                if task.capability.is_none() {
                    task.capability = identifier(detail.and_then(|d| d.get("capability")));
                }
            }
            "task.claim" => {
                self.tasks.entry(id).or_default().assignee = who;
            }
            "task.fail" => {
                self.tasks.entry(id).or_default().failure_code = identifier(detail.and_then(|d| d.get("code")));
            }
            _ => {}
        }
    }

    fn prune(&mut self, now_ms: i64) {
        let cutoff = now_ms - 48 * HOUR_MS;
        self.tasks.retain(|_, task| task.done_at.is_none() || task.updated_at >= cutoff);
        if self.tasks.len() > MAX_TASKS {
            let mut by_age: Vec<_> = self.tasks.iter().map(|(id, task)| (task.updated_at, id.clone())).collect();
            by_age.sort();
            for (_, id) in by_age.into_iter().take(self.tasks.len() - MAX_TASKS) {
                self.tasks.remove(&id);
            }
        }
        self.lease_expiries.retain(|_, at| *at >= cutoff);
    }

    fn state_counts(&self) -> BTreeMap<String, u64> {
        let mut out = BTreeMap::new();
        for task in self.tasks.values() {
            *out.entry(task.state.clone()).or_insert(0) += 1;
        }
        out
    }

    fn work(&self, now_ms: i64) -> Work {
        let day_ago = now_ms - 24 * HOUR_MS;
        let mut waiting_input: Vec<Waiting> = self
            .tasks
            .iter()
            .filter(|(_, task)| task.state == "input_required")
            .filter_map(|(id, task)| {
                Some(Waiting { task: short(id), capability: task.capability.clone(), waiting_seconds: (now_ms - task.waiting_since?).max(0) as u64 / 1000 })
            })
            .collect();
        waiting_input.sort_by(|a, b| b.waiting_seconds.cmp(&a.waiting_seconds));

        let mut stuck: Vec<Stuck> = self
            .tasks
            .iter()
            .filter(|(_, task)| task.state == "running" && now_ms - task.updated_at > STUCK_AFTER_MS)
            .map(|(id, task)| Stuck {
                task: short(id),
                capability: task.capability.clone(),
                assignee: task.assignee.clone(),
                reason: "no update from the worker".into(),
                seconds: (now_ms - task.updated_at) as u64 / 1000,
            })
            .collect();
        stuck.sort_by(|a, b| b.seconds.cmp(&a.seconds));

        let mut groups: BTreeMap<(String, String), u64> = BTreeMap::new();
        for task in self.tasks.values().filter(|task| task.state == "failed" && task.done_at.is_some_and(|at| at >= day_ago)) {
            let key = (task.capability.clone().unwrap_or_else(|| "unknown".into()), task.failure_code.clone().unwrap_or_else(|| "unknown".into()));
            *groups.entry(key).or_insert(0) += 1;
        }
        let mut failures_24h: Vec<FailureGroup> = groups.into_iter().map(|((capability, code), count)| FailureGroup { capability, code, count }).collect();
        failures_24h.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.capability.cmp(&b.capability)));

        let this_hour = now_ms - now_ms.rem_euclid(HOUR_MS);
        let mut throughput: Vec<HourBucket> = (0..24)
            .map(|i| HourBucket { hour_start: iso(this_hour - (23 - i) * HOUR_MS).unwrap_or_default(), ..Default::default() })
            .collect();
        let bucket = |at: i64| -> Option<usize> {
            let index = (at - (this_hour - 23 * HOUR_MS)).div_euclid(HOUR_MS);
            (0..24).contains(&index).then_some(index as usize)
        };
        for task in self.tasks.values() {
            if let Some(index) = task.submitted_at.and_then(bucket) {
                throughput[index].submitted += 1;
            }
            if let Some(index) = task.done_at.and_then(bucket) {
                match task.state.as_str() {
                    "succeeded" => throughput[index].succeeded += 1,
                    "failed" => throughput[index].failed += 1,
                    _ => {}
                }
            }
        }

        let mut recent: Vec<(&String, &Task)> = self.tasks.iter().collect();
        recent.sort_by(|a, b| b.1.updated_at.cmp(&a.1.updated_at));
        let recent = recent
            .into_iter()
            .take(30)
            .map(|(id, task)| RecentTask {
                task: short(id),
                capability: task.capability.clone(),
                requester: task.requester.clone(),
                assignee: task.assignee.clone(),
                state: task.state.clone(),
                submitted_at: task.submitted_at.and_then(iso),
                updated_at: iso(task.updated_at),
                duration_seconds: task.done_at.zip(task.submitted_at).map(|(done, start)| (done - start).max(0) as f64 / 1000.0),
                attempts: task.attempts,
                failure_code: task.failure_code.clone(),
            })
            .collect();

        Work {
            by_state: self.state_counts(),
            waiting_input,
            stuck,
            lease_expiries_24h: self.lease_expiries.values().filter(|at| **at >= day_ago).count() as u64,
            failures_24h,
            throughput,
            recent,
            history_from: self.first_event_ms.and_then(iso),
            ..Default::default()
        }
    }
}

// ---------------------------------------------------------------- aggregation (pure)

/// Everything one poll produced; `None` means that read failed and the matching output stays unknown.
#[derive(Default)]
pub struct Inputs {
    pub ready: Option<Value>,
    pub metrics: Option<Metrics>,
    pub overview: Option<Value>,
    /// `/v1/admin/system`: absent from a domain that predates it (that is not a problem, the numbers just stay unknown).
    pub system: Option<Value>,
    pub runtimes: Option<Value>,
    pub catalog: Option<Value>,
    pub audit: AuditStatus,
    pub certificates: Vec<Certificate>,
    pub events: EventInputs,
}

fn consumers(metrics: &Metrics) -> Vec<ConsumerLag> {
    let mut out: Vec<ConsumerLag> = metrics
        .with_label("somework_jetstream_consumer_lag")
        .filter_map(|series| {
            let consumer = series.labels.get("consumer")?.clone();
            let stream = series.labels.get("stream")?.clone();
            let (prefix, rest) = consumer.split_once('_')?;
            let kind: String = match prefix {
                "inbox" => "inbox",
                "pool" => "work",
                "subs" => "subscriptions",
                other => other,
            }
            .into();
            let principal = identifier(Some(&Value::String(rest.replace("~2f", "/"))));
            Some(ConsumerLag { stream, consumer, principal, kind, lag: series.value.max(0.0) as u64 })
        })
        .collect();
    out.sort_by(|a, b| a.principal.cmp(&b.principal).then_with(|| a.kind.cmp(&b.kind)));
    out
}

fn capabilities(card: &Value) -> Vec<CapabilityRef> {
    card.get("capabilities")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|capability| {
                    Some(CapabilityRef {
                        id: identifier(capability.get("id"))?,
                        version: identifier(capability.get("version"))?,
                        side_effects: identifier(capability.get("sideEffects")),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn agents(inputs: &Inputs, consumers: &[ConsumerLag], now_ms: i64) -> Vec<SwAgent> {
    let mut by_id: BTreeMap<String, SwAgent> = BTreeMap::new();
    let entry = |by_id: &mut BTreeMap<String, SwAgent>, id: &str| {
        by_id.entry(id.to_string()).or_insert_with(|| SwAgent { id: id.to_string(), role: "requester".into(), ..Default::default() });
    };
    for item in inputs.catalog.as_ref().and_then(|c| c.get("entries")).and_then(Value::as_array).into_iter().flatten() {
        let Some(card) = item.get("agentCard") else { continue };
        let Some(id) = identifier(card.get("agentId")) else { continue };
        entry(&mut by_id, &id);
        let agent = by_id.get_mut(&id).expect("just inserted");
        agent.role = "provider".into();
        agent.display_name = identifier(card.get("displayName")).or_else(|| card.get("displayName").and_then(Value::as_str).map(|s| s.chars().take(60).filter(|c| !c.is_control()).collect()));
        agent.capabilities = capabilities(card);
        agent.approval = identifier(item.get("approval").and_then(|a| a.get("status")));
        agent.availability = identifier(item.get("availability").and_then(|a| a.get("state")));
        agent.queue_depth = count(item.get("availability").and_then(|a| a.get("queueDepth")));
    }
    let mut seen: HashMap<String, (u64, u64, Option<i64>, Option<String>)> = HashMap::new();
    for runtime in inputs.runtimes.as_ref().and_then(|r| r.get("runtimes")).and_then(Value::as_array).into_iter().flatten() {
        let Some(id) = identifier(runtime.get("agentId")) else { continue };
        let slot = seen.entry(id).or_insert((0, 0, None, None));
        slot.1 += 1;
        if runtime.get("status").and_then(Value::as_str) == Some("active") {
            slot.0 += 1;
        }
        if let Some(at) = time_ms(runtime.get("lastSeenAt")) {
            slot.2 = Some(slot.2.map_or(at, |old| old.max(at)));
        }
        if slot.3.is_none() {
            slot.3 = identifier(runtime.get("meta").and_then(|m| m.get("sdk")));
        }
    }
    for (id, (active, total, last, sdk)) in seen {
        entry(&mut by_id, &id);
        let agent = by_id.get_mut(&id).expect("just inserted");
        agent.active_runtimes = active;
        agent.total_runtimes = total;
        agent.last_seen_at = last.and_then(iso);
        agent.sdk = sdk;
        agent.liveness = SwAgent::classify(active, total, last, now_ms);
    }
    for lag in consumers {
        let Some(principal) = &lag.principal else { continue };
        entry(&mut by_id, principal);
        let agent = by_id.get_mut(principal).expect("just inserted");
        match lag.kind.as_str() {
            "work" => agent.work_lag = Some(lag.lag),
            "inbox" => agent.inbox_lag = Some(lag.lag),
            _ => {}
        }
    }
    let mut out: Vec<SwAgent> = by_id.into_values().collect();
    out.sort_by(|a, b| (a.role != "provider").cmp(&(b.role != "provider")).then_with(|| a.id.cmp(&b.id)));
    out
}

fn domain(inputs: &Inputs) -> DomainHealth {
    let overview = inputs.overview.as_ref();
    let system = inputs.system.as_ref();
    let pick = |name: &str| count(overview.and_then(|o| o.get(name)));
    let metrics = inputs.metrics.as_ref();
    let requests = |keep: &dyn Fn(&str) -> bool| -> Option<u64> {
        let metrics = metrics?;
        let total: f64 = metrics.with_label("somework_api_requests_total").filter(|s| s.labels.get("status").is_some_and(|status| keep(status))).map(|s| s.value).sum();
        Some(total as u64)
    };
    DomainHealth {
        domain_id: identifier(inputs.ready.as_ref().and_then(|r| r.get("domainId"))).or_else(|| identifier(overview.and_then(|o| o.get("domainId")))),
        ready: inputs.ready.as_ref().map(|r| r.get("database").and_then(Value::as_bool) == Some(true) && r.get("objectStore").and_then(Value::as_bool) != Some(false)),
        policy_version: identifier(overview.and_then(|o| o.get("policyVersion"))),
        object_store: identifier(overview.and_then(|o| o.get("objectStore"))),
        audit: inputs.audit.clone(),
        outbox: overview
            .and_then(|o| o.get("outbox"))
            .and_then(Value::as_array)
            .map(|sinks| {
                sinks
                    .iter()
                    .filter_map(|sink| {
                        Some(OutboxSink {
                            sink: identifier(sink.get("sink"))?,
                            pending: count(sink.get("pending")).unwrap_or(0),
                            failed: count(sink.get("failed")).unwrap_or(0),
                            dead: count(sink.get("dead")).unwrap_or(0),
                            published: count(sink.get("published")).unwrap_or(0),
                            oldest_pending_age_seconds: count(sink.get("oldestPendingAgeSeconds")).unwrap_or(0),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
        reconciliation_queue: pick("reconciliationQueue"),
        pending_approvals: pick("pendingApprovals"),
        denials_24h: pick("denialsLast24h"),
        draft_catalog_entries: pick("draftCatalogEntries"),
        online_runtimes: pick("onlineRuntimes"),
        queue_depth: metrics.and_then(|m| m.count("somework_tasks_queued")),
        oldest_queued_age_seconds: metrics.and_then(|m| m.max("somework_task_queue_age_seconds")).filter(|v| v.is_finite() && *v >= 0.0),
        lease_expiries_total: metrics.and_then(|m| m.count("somework_task_lease_expiry_count_total")),
        retries_total: metrics.and_then(|m| m.count("somework_task_retry_count_total")),
        reconciliations_total: metrics.and_then(|m| m.count("somework_task_reconciliation_count_total")),
        runtime_restarts_total: metrics.and_then(|m| m.count("somework_agent_runtime_restarts_total")),
        jetstream_redeliveries_total: metrics.and_then(|m| m.count("somework_jetstream_redelivery_count_total")),
        policy_allow_total: metrics.and_then(|m| m.count("somework_policy_allow_total")),
        policy_deny_total: metrics.and_then(|m| m.count("somework_policy_deny_total")),
        requests_total: requests(&|_| true),
        requests_server_errors: requests(&|status| status.starts_with('5')),
        requests_denied: requests(&|status| status == "401" || status == "403"),
        artifact_upload_bytes: metrics.and_then(|m| m.count("somework_artifact_upload_bytes_total")),
        certificates: inputs.certificates.clone(),
        version: identifier(system.and_then(|s| s.get("version"))),
        uptime_seconds: count(system.and_then(|s| s.get("uptimeSeconds"))),
        database_bytes: count(system.and_then(|s| s.get("database")).and_then(|d| d.get("bytes"))),
        database_free_bytes: count(system.and_then(|s| s.get("database")).and_then(|d| d.get("freeBytes"))),
        wal_bytes: count(system.and_then(|s| s.get("database")).and_then(|d| d.get("walBytes"))),
        migrations_applied: count(system.and_then(|s| s.get("migrationsApplied"))),
        principals: principals(system),
        not_exposed: not_exposed(system.is_some()),
    }
}

fn principals(system: Option<&Value>) -> Vec<PrincipalState> {
    let mut out: Vec<PrincipalState> = system
        .and_then(|s| s.get("principals"))
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .take(200)
                .filter_map(|item| {
                    let status = match item.get("status").and_then(Value::as_str) {
                        Some("active") => "active",
                        Some("disabled") => "disabled",
                        _ => return None,
                    };
                    let side_effects = match item.get("sideEffectsCeiling").and_then(Value::as_str) {
                        Some("read") => "read",
                        Some("write") => "write",
                        Some("irreversible") => "irreversible",
                        _ => "unknown",
                    };
                    Some(PrincipalState { kind: identifier(item.get("kind"))?, id: identifier(item.get("id"))?, status: status.into(), side_effects: side_effects.into() })
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| (&a.kind, &a.id).cmp(&(&b.kind, &b.id)));
    out
}

/// What stays unknown: with the system view only the backup age does.
fn not_exposed(system_known: bool) -> Vec<String> {
    let mut list: Vec<String> = NOT_EXPOSED.iter().map(|text| text.to_string()).collect();
    if system_known {
        list.retain(|text| !text.starts_with("Principal enabled") && !text.starts_with("Domain version"));
        for text in &mut list {
            if text.starts_with("Database size") {
                *text = "Backup age (the domain does not record backups)".to_string();
            }
        }
    }
    list
}

/// The whole SomeWork view for one instant. Pure: the same inputs and clock always give the same output.
pub fn assemble(inputs: &Inputs, book: &TaskBook, now_ms: i64) -> SomeWork {
    let mut work = book.work(now_ms);
    let overview = inputs.overview.as_ref();
    if let Some(states) = overview.and_then(|o| o.get("tasksByState")).and_then(Value::as_object) {
        // the domain's own counts are authoritative; the book only covers what its event retention still holds
        work.by_state = states.iter().filter_map(|(state, n)| Some((identifier(Some(&Value::String(state.clone())))?, count(Some(n))?))).collect();
    }
    work.submitted_total = inputs.metrics.as_ref().and_then(|m| m.count("somework_tasks_submitted_total"));
    work.terminal_total = inputs.metrics.as_ref().and_then(|m| m.count("somework_tasks_terminal_total"));
    let consumers = inputs.metrics.as_ref().map(consumers).unwrap_or_default();
    let domain = domain(inputs);
    let events = events::assemble(&inputs.events, inputs.metrics.as_ref(), domain.pending_approvals, now_ms);
    SomeWork {
        observed_at: inputs.overview.as_ref().map(|_| iso(now_ms).unwrap_or_default()),
        error: None,
        server_time: iso(now_ms).unwrap_or_default(),
        domain,
        agents: agents(inputs, &consumers, now_ms),
        work,
        consumers,
        events,
    }
}

// ---------------------------------------------------------------- collector

pub struct Collector {
    http: reqwest::Client,
    base: String,
    host: String,
    port: u16,
    ca_pem: String,
    identity: Identity,
    book: TaskBook,
    events_after: i64,
    audit_after: i64,
    audit: AuditStatus,
    verified: Option<Instant>,
    certificates: Vec<Certificate>,
    certificates_at: Option<Instant>,
    runtimes: Option<Value>,
    catalog: Option<Value>,
    hub: Option<events::HubClient>,
    agent_http: reqwest::Client,
    agent_targets: Vec<events::AgentTarget>,
    /// Recent firings by rule, read again only when the rule's counters moved.
    firings: BTreeMap<String, ((u64, u64), Value)>,
}

impl Collector {
    pub fn new(base: String, ca_pem: String, key_file: &[u8], allow_plain_http: bool) -> Result<Self, String> {
        let identity = Identity::from_key_file(key_file)?;
        let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(8)).connect_timeout(Duration::from_secs(4));
        if !allow_plain_http {
            if !base.starts_with("https://") {
                return Err("SOMEWORK_URL must be https".into());
            }
            if certs::pem_certificates(&ca_pem).is_empty() {
                return Err("the SomeWork CA file holds no certificate".into());
            }
            let certificate = reqwest::Certificate::from_pem(ca_pem.as_bytes()).map_err(|_| "the SomeWork CA is not a PEM certificate".to_string())?;
            builder = builder.https_only(true).tls_built_in_root_certs(false).add_root_certificate(certificate);
        }
        let http = builder.build().map_err(|_| "cannot build the HTTP client".to_string())?;
        let url = reqwest::Url::parse(&base).map_err(|_| "SOMEWORK_URL is not a URL".to_string())?;
        let host = url.host_str().ok_or("SOMEWORK_URL has no host")?.to_string();
        let port = url.port_or_known_default().unwrap_or(443);
        Ok(Self {
            http,
            base: base.trim_end_matches('/').to_string(),
            host,
            port,
            ca_pem,
            identity,
            book: TaskBook::default(),
            events_after: 0,
            audit_after: 0,
            audit: AuditStatus::default(),
            verified: None,
            certificates: Vec::new(),
            certificates_at: None,
            runtimes: None,
            catalog: None,
            hub: None,
            agent_http: events::agent_http_client()?,
            agent_targets: Vec::new(),
            firings: BTreeMap::new(),
        })
    }

    pub fn with_hub(mut self, hub: events::HubClient) -> Self {
        self.hub = Some(hub);
        self
    }

    pub fn with_agent_targets(mut self, targets: Vec<events::AgentTarget>) -> Self {
        self.agent_targets = targets;
        self
    }

    /// Rules and their recent firings. An older domain without rules answers 404: the rules stay unknown, without a complaint.
    async fn read_rules(&mut self, problems: &mut Vec<String>) -> (Option<Value>, BTreeMap<String, Value>) {
        let rules = match self.json("/v1/rules").await {
            Ok(value) => Some(value),
            Err(error) => {
                if !error.ends_with("HTTP 404") {
                    problems.push(error);
                }
                None
            }
        };
        let names = events::rule_names(rules.as_ref());
        self.firings.retain(|name, _| names.iter().any(|(known, _)| known == name));
        for (name, fingerprint) in &names {
            let current = self.firings.get(name).is_some_and(|(seen, _)| seen == fingerprint);
            if current || *fingerprint == (0, 0) {
                continue;
            }
            match self.json(&format!("/v1/rules/{name}/firings?limit=5")).await {
                Ok(body) => {
                    self.firings.insert(name.clone(), (*fingerprint, body));
                }
                Err(error) => problems.push(error),
            }
        }
        (rules, self.firings.iter().map(|(name, (_, body))| (name.clone(), body.clone())).collect())
    }

    pub fn issuer(&self) -> &str {
        self.identity.issuer()
    }

    async fn get(&self, path: &str, authenticated: bool) -> Result<reqwest::Response, String> {
        let mut request = self.http.get(format!("{}{path}", self.base));
        if authenticated {
            request = request.bearer_auth(self.identity.mint());
        }
        let response = request.send().await.map_err(|_| format!("{path}: unreachable"))?;
        if response.status().is_success() { Ok(response) } else { Err(format!("{path}: HTTP {}", response.status().as_u16())) }
    }

    async fn json(&self, path: &str) -> Result<Value, String> {
        self.get(path, true).await?.json::<Value>().await.map_err(|_| format!("{path}: not JSON"))
    }

    async fn page_events(&mut self) -> Result<(), String> {
        for _ in 0..MAX_PAGES {
            let body = self.json(&format!("/v1/admin/events?after={}&limit={PAGE}", self.events_after)).await?;
            let events = body.get("events").and_then(Value::as_array).cloned().unwrap_or_default();
            let before = self.events_after;
            for event in &events {
                let seq = event.get("seq").and_then(Value::as_i64).unwrap_or(0);
                if seq <= before {
                    continue; // a server that ignores the cursor must not make the same event count twice
                }
                self.book.apply_event(event);
                self.events_after = self.events_after.max(seq);
            }
            if self.events_after == before {
                break;
            }
            if events.len() < PAGE {
                break;
            }
        }
        Ok(())
    }

    async fn page_audit(&mut self) -> Result<(), String> {
        for _ in 0..MAX_PAGES {
            let body = self.json(&format!("/v1/admin/audit?after={}&limit={PAGE}", self.audit_after)).await?;
            let rows = body.get("events").and_then(Value::as_array).cloned().unwrap_or_default();
            let before = self.audit_after;
            for row in &rows {
                let seq = row.get("seq").and_then(Value::as_i64).unwrap_or(0);
                if seq <= before {
                    continue;
                }
                self.book.apply_audit(row);
                self.audit_after = self.audit_after.max(seq);
            }
            if self.audit_after == before {
                break;
            }
            if rows.len() < PAGE {
                break;
            }
        }
        Ok(())
    }

    async fn refresh_certificates(&mut self, now: i64) {
        if self.certificates_at.is_some_and(|at| at.elapsed() < CERT_CHECK_EVERY) {
            return;
        }
        let describe = |name: &str, not_after: Option<i64>| Certificate {
            name: name.into(),
            not_after: not_after.and_then(|s| iso(s * 1000)),
            days_left: not_after.map(|s| (s * 1000 - now).div_euclid(24 * HOUR_MS)),
        };
        let mut found = Vec::new();
        if let Some(leaf) = certs::presented_leaf(&self.host, self.port, &self.ca_pem).await {
            found.push(describe("Domain TLS certificate", certs::not_after(&leaf)));
        }
        if let Some(ca) = certs::pem_certificates(&self.ca_pem).first() {
            found.push(describe("Private CA", certs::not_after(ca)));
        }
        self.certificates = found;
        self.certificates_at = Some(Instant::now());
    }

    /// One poll. Failures leave the affected values unknown (or the previous sample for slow-changing data) and say why.
    pub async fn sample(&mut self) -> SomeWork {
        let now = chrono::Utc::now().timestamp_millis();
        let mut problems: Vec<String> = Vec::new();
        let ready = match self.get("/readyz", false).await {
            Ok(response) => response.json::<Value>().await.ok(),
            Err(error) => {
                problems.push(error);
                None
            }
        };
        let metrics = match self.get("/metrics", false).await {
            Ok(response) => response.text().await.ok().map(|text| Metrics::parse(&text)),
            Err(error) => {
                problems.push(error);
                None
            }
        };
        let overview = self.json("/v1/admin/overview").await.map_err(|error| problems.push(error)).ok();
        let system = if overview.is_some() { self.json("/v1/admin/system").await.ok() } else { None };
        if overview.is_some() {
            match self.json("/v1/runtimes").await {
                Ok(value) => self.runtimes = Some(value),
                Err(error) => problems.push(error),
            }
            match self.json("/v1/catalog/entries").await {
                Ok(value) => self.catalog = Some(value),
                Err(error) => problems.push(error),
            }
            if let Err(error) = self.page_events().await {
                problems.push(error);
            }
            if let Err(error) = self.page_audit().await {
                problems.push(error);
            }
            if self.verified.is_none_or(|at| at.elapsed() >= AUDIT_VERIFY_EVERY) {
                match self.json("/v1/admin/audit/verify").await {
                    Ok(value) => {
                        self.audit = AuditStatus {
                            intact: value.get("intact").and_then(Value::as_bool),
                            first_broken_seq: value.get("firstBrokenSeq").and_then(Value::as_i64),
                            checked_at: iso(now),
                        };
                        self.verified = Some(Instant::now());
                    }
                    Err(error) => problems.push(error),
                }
            }
        }
        let (rules, firings) = if overview.is_some() { self.read_rules(&mut problems).await } else { (None, BTreeMap::new()) };
        let hub = match &self.hub {
            Some(hub) => hub.read().await,
            None => events::HubRead::NotConfigured,
        };
        let agent_reads = events::read_agents(&self.agent_http, &self.agent_targets).await;
        self.refresh_certificates(now).await;
        let inputs = Inputs {
            ready,
            metrics,
            overview,
            system,
            runtimes: self.runtimes.clone(),
            catalog: self.catalog.clone(),
            audit: self.audit.clone(),
            certificates: self.certificates.clone(),
            events: EventInputs { rules, firings, hub, agents: agent_reads, agents_configured: self.agent_targets.len() as u64 },
        };
        let mut sample = assemble(&inputs, &self.book, now);
        if !problems.is_empty() {
            sample.error = Some(format!("Some SomeWork reads failed: {}", problems.join("; ")));
        }
        sample
    }
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_790_000_000_000;

    fn at(seconds_ago: i64) -> String {
        iso(NOW - seconds_ago * 1000).unwrap()
    }

    fn event(kind: &str, task: &str, seconds_ago: i64, extra: Value) -> Value {
        let mut payload = json!({"capabilityId": "code.agent", "capabilityVersion": "1", "attempt": 1, "state": "x"});
        if let (Some(target), Some(source)) = (payload.as_object_mut(), extra.as_object()) {
            target.extend(source.clone());
        }
        json!({"seq": 1, "type": kind, "taskId": task, "createdAt": at(seconds_ago), "payload": payload})
    }

    fn audit(action: &str, task: &str, actor: &str, seconds_ago: i64, detail: Value) -> Value {
        json!({"seq": 1, "action": action, "taskId": task, "authenticatedActor": actor, "occurredAt": at(seconds_ago), "detail": detail, "hash": "SECRETHASH", "requestDigest": "SECRETDIGEST"})
    }

    fn book() -> TaskBook {
        let mut book = TaskBook::default();
        // t1 succeeded, t2 failed, t3 waits for input, t4 running quietly for 20 minutes, t5 queued
        for (id, kind) in [("task_t1", "task.succeeded"), ("task_t2", "task.failed")] {
            book.apply_event(&event("task.queued", id, 600, json!({})));
            book.apply_event(&event("task.running", id, 500, json!({})));
            book.apply_event(&event(kind, id, 300, json!({})));
        }
        book.apply_event(&event("task.queued", "task_t3", 900, json!({})));
        book.apply_event(&event("task.running", "task_t3", 800, json!({})));
        book.apply_event(&event("task.input_required", "task_t3", 700, json!({})));
        book.apply_event(&event("task.queued", "task_t4", 1500, json!({})));
        book.apply_event(&event("task.running", "task_t4", 1400, json!({})));
        book.apply_event(&event("task.queued", "task_t5", 30, json!({})));
        book.apply_audit(&audit("task.submit", "task_t1", "agent:agent/pi-requester", 600, json!({"capability": "code.agent@1", "inputDigest": "SECRETDIGEST"})));
        book.apply_audit(&audit("task.claim", "task_t1", "agent:agent/pi-agent", 500, json!({"fencingToken": 1})));
        book.apply_audit(&audit("task.fail", "task_t2", "agent:agent/pi-agent", 300, json!({"code": "job_error", "message": "SECRET MESSAGE"})));
        book.apply_audit(&audit("task.lease_expired", "task_t2", "service:somework", 400, json!({"outcome": "requeued"})));
        book
    }

    #[test]
    fn lifecycle_is_reduced_to_states_waiting_and_stuck() {
        let work = book().work(NOW);
        assert_eq!(work.by_state["succeeded"], 1);
        assert_eq!(work.by_state["failed"], 1);
        assert_eq!(work.by_state["input_required"], 1);
        assert_eq!(work.by_state["queued"], 1);
        assert_eq!(work.waiting_input.len(), 1);
        assert_eq!(work.waiting_input[0].waiting_seconds, 700);
        assert_eq!(work.stuck.len(), 1);
        assert_eq!(work.stuck[0].reason, "no update from the worker");
        assert_eq!(work.lease_expiries_24h, 1);
        assert_eq!(work.failures_24h, vec![FailureGroup { capability: "code.agent@1".into(), code: "job_error".into(), count: 1 }]);
    }

    #[test]
    fn requester_and_assignee_come_from_the_audit_log() {
        let work = book().work(NOW);
        let t1 = work.recent.iter().find(|task| task.task.ends_with("task_t1")).expect("t1");
        assert_eq!(t1.requester.as_deref(), Some("agent/pi-requester"));
        assert_eq!(t1.assignee.as_deref(), Some("agent/pi-agent"));
        assert_eq!(t1.duration_seconds, Some(300.0));
        assert_eq!(t1.state, "succeeded");
    }

    #[test]
    fn throughput_counts_each_task_once_in_the_right_hour() {
        let work = book().work(NOW);
        assert_eq!(work.throughput.len(), 24);
        let submitted: u64 = work.throughput.iter().map(|b| b.submitted).sum();
        let succeeded: u64 = work.throughput.iter().map(|b| b.succeeded).sum();
        let failed: u64 = work.throughput.iter().map(|b| b.failed).sum();
        assert_eq!((submitted, succeeded, failed), (5, 1, 1));
    }

    #[test]
    fn nothing_from_task_content_can_reach_the_output() {
        // content-bearing fields in every place the domain might put them
        let mut book = TaskBook::default();
        let mut queued = event("task.queued", "task_leak", 60, json!({"input": {"instruction": "PRIVATE INSTRUCTION"}, "result": "PRIVATE RESULT", "message": "PRIVATE MESSAGE", "text": "PRIVATE TEXT"}));
        queued["payload"]["summary"] = json!("PRIVATE SUMMARY");
        queued["body"] = json!("PRIVATE BODY");
        book.apply_event(&queued);
        book.apply_event(&json!({"seq": 2, "type": "message.created", "taskId": "task_leak", "createdAt": at(50), "payload": {"text": "PRIVATE MESSAGE BODY", "sender": "agent/x"}}));
        book.apply_audit(&audit("task.submit", "task_leak", "agent:agent/a", 60, json!({"capability": "code.agent@1", "prompt": "PRIVATE PROMPT", "inputDigest": "PRIVATE DIGEST"})));
        book.apply_audit(&audit("task.fail", "task_leak", "agent:agent/b", 10, json!({"code": "has spaces and PRIVATE FREE TEXT", "message": "PRIVATE FAILURE"})));
        let inputs = Inputs {
            overview: Some(json!({"tasksByState": {"queued": 1}, "domainId": "development", "agentsNote": "PRIVATE OVERVIEW NOTE", "outbox": [{"sink": "nats", "pending": 0, "payload": "PRIVATE OUTBOX"}]})),
            runtimes: Some(json!({"runtimes": [{"agentId": "agent/b", "status": "active", "lastSeenAt": at(5), "startedAt": at(500), "meta": {"sdk": "@somework/sdk", "secret": "PRIVATE META", "host": "PRIVATE HOST"}}]})),
            catalog: Some(json!({"entries": [{"agentCard": {"agentId": "agent/b", "displayName": "B", "description": "PRIVATE DESCRIPTION", "capabilities": [{"id": "code.agent", "version": "1", "sideEffects": "write", "inputSchema": {"description": "PRIVATE SCHEMA"}}]}, "approval": {"status": "approved", "approvedBy": "PRIVATE APPROVER"}, "availability": {"state": "available", "activeInstances": 1, "queueDepth": 0}}]})),
            ..Default::default()
        };
        let output = serde_json::to_string(&assemble(&inputs, &book, NOW)).unwrap();
        assert!(!output.contains("PRIVATE"), "leaked: {output}");
        assert!(!output.contains("SECRET"), "leaked: {output}");
        assert!(output.contains("agent/b"), "the allowlisted identity does show");
    }

    #[test]
    fn the_system_view_gives_version_size_and_principal_states_and_nothing_else() {
        let inputs = Inputs {
            overview: Some(json!({"domainId": "development"})),
            system: Some(json!({
                "version": "0.1.0", "uptimeSeconds": 3700, "database": {"bytes": 8_388_608, "freeBytes": 4096, "walBytes": 1024}, "migrationsApplied": 7,
                "publicKey": "PRIVATE KEY MATERIAL", "principals": [
                    {"kind": "agent", "id": "agent/reviewer", "status": "active", "sideEffectsCeiling": "read", "publicKey": "PRIVATE"},
                    {"kind": "agent", "id": "agent/old", "status": "disabled", "sideEffectsCeiling": "write"},
                    {"kind": "agent", "id": "bad id <b>", "status": "active", "sideEffectsCeiling": "read"},
                    {"kind": "agent", "id": "agent/odd", "status": "banana", "sideEffectsCeiling": "read"},
                    {"kind": "human", "id": "jimmy", "status": "active", "sideEffectsCeiling": "<script>"}]
            })),
            ..Default::default()
        };
        let domain = assemble(&inputs, &TaskBook::default(), NOW).domain;
        assert_eq!((domain.version.as_deref(), domain.uptime_seconds, domain.database_bytes, domain.wal_bytes, domain.migrations_applied), (Some("0.1.0"), Some(3700), Some(8_388_608), Some(1024), Some(7)));
        let states: Vec<(String, String, String)> = domain.principals.iter().map(|p| (p.id.clone(), p.status.clone(), p.side_effects.clone())).collect();
        assert_eq!(
            states,
            vec![("agent/old".into(), "disabled".into(), "write".into()), ("agent/reviewer".into(), "active".into(), "read".into()), ("jimmy".into(), "active".into(), "unknown".into())],
            "unusable ids and states are left out, an unknown ceiling is shown as unknown"
        );
        assert!(!serde_json::to_string(&domain).unwrap().contains("PRIVATE"));
        assert!(domain.not_exposed.iter().any(|text| text.starts_with("Backup age")));
        assert!(!domain.not_exposed.iter().any(|text| text.starts_with("Domain version") || text.starts_with("Principal enabled")));
    }

    #[test]
    fn a_domain_without_the_system_view_leaves_those_numbers_unknown_and_still_lists_what_is_missing() {
        let domain = assemble(&Inputs { overview: Some(json!({"domainId": "development"})), ..Default::default() }, &TaskBook::default(), NOW).domain;
        assert_eq!((domain.version, domain.uptime_seconds, domain.database_bytes), (None, None, None));
        assert!(domain.principals.is_empty());
        assert!(domain.not_exposed.iter().any(|text| text.starts_with("Domain version")));
    }

    #[test]
    fn domain_numbers_come_from_the_overview_and_metrics_and_stay_unknown_without_them() {
        let inputs = Inputs {
            overview: Some(json!({"domainId": "development", "tasksByState": {"succeeded": 15, "failed": 2}, "pendingApprovals": 1, "reconciliationQueue": 0, "denialsLast24h": 3,
                "outbox": [{"sink": "nats", "pending": 2, "failed": 0, "dead": 0, "published": 398, "oldestPendingAgeSeconds": 4}], "policyVersion": "builtin-1"})),
            metrics: Some(Metrics::parse("somework_tasks_queued 2\nsomework_task_queue_age_seconds 12.5\nsomework_api_requests_total{route=\"a\",status=\"200\"} 90\nsomework_api_requests_total{route=\"a\",status=\"500\"} 4\nsomework_api_requests_total{route=\"a\",status=\"403\"} 6\nsomework_jetstream_consumer_lag{consumer=\"inbox_agent~2fmanager\",stream=\"SOMEWORK_INBOX\"} 5\n")),
            ..Default::default()
        };
        let sample = assemble(&inputs, &TaskBook::default(), NOW);
        assert_eq!(sample.work.by_state["succeeded"], 15);
        assert_eq!(sample.domain.pending_approvals, Some(1));
        assert_eq!(sample.domain.queue_depth, Some(2));
        assert_eq!(sample.domain.oldest_queued_age_seconds, Some(12.5));
        assert_eq!(sample.domain.requests_total, Some(100));
        assert_eq!(sample.domain.requests_server_errors, Some(4));
        assert_eq!(sample.domain.requests_denied, Some(6));
        assert_eq!(sample.domain.outbox[0].published, 398);
        assert_eq!(sample.consumers[0].principal.as_deref(), Some("agent/manager"));
        assert_eq!(sample.agents[0].id, "agent/manager");
        assert_eq!(sample.agents[0].inbox_lag, Some(5));
        let blank = assemble(&Inputs::default(), &TaskBook::default(), NOW);
        assert_eq!(blank.domain.pending_approvals, None);
        assert_eq!(blank.domain.queue_depth, None);
        assert_eq!(blank.observed_at, None, "nothing was read, so nothing was observed");
        assert!(!blank.domain.not_exposed.is_empty());
    }

    #[test]
    fn agents_merge_card_runtimes_and_consumers() {
        let inputs = Inputs {
            catalog: Some(json!({"entries": [{"agentCard": {"agentId": "agent/reviewer", "displayName": "Reviewer", "capabilities": [{"id": "code.review", "version": "3", "sideEffects": "read"}]}, "approval": {"status": "approved"}, "availability": {"state": "available", "queueDepth": 0}}]})),
            runtimes: Some(json!({"runtimes": [
                {"agentId": "agent/reviewer", "status": "active", "lastSeenAt": at(20), "meta": {"sdk": "@somework/sdk"}},
                {"agentId": "agent/reviewer", "status": "ended", "lastSeenAt": at(4000)},
                {"agentId": "agent/old", "status": "ended", "lastSeenAt": at(9000)}]})),
            ..Default::default()
        };
        let sample = assemble(&inputs, &TaskBook::default(), NOW);
        let reviewer = sample.agents.iter().find(|a| a.id == "agent/reviewer").unwrap();
        assert_eq!(reviewer.role, "provider");
        assert_eq!(reviewer.liveness.label(), "alive");
        assert_eq!((reviewer.active_runtimes, reviewer.total_runtimes), (1, 2));
        assert_eq!(reviewer.capabilities[0].side_effects.as_deref(), Some("read"));
        let old = sample.agents.iter().find(|a| a.id == "agent/old").unwrap();
        assert_eq!(old.liveness.label(), "offline");
        assert_eq!(sample.agents[0].id, "agent/reviewer", "providers sort first");
    }

    /// A fake domain on a local port: the authenticated routes insist on a three-part bearer assertion, and every response
    /// is stuffed with content that must never reach the dashboard.
    async fn fake_domain() -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use axum::{Json, Router, extract::Request, http::StatusCode, middleware::{self, Next}, response::Response, routing::get};
        use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
        let authenticated = Arc::new(AtomicUsize::new(0));
        let counter = authenticated.clone();
        let guard = move |request: Request, next: Next| {
            let counter = counter.clone();
            async move {
                if request.uri().path().starts_with("/v1/") {
                    let bearer = request.headers().get("authorization").and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
                    let parts = bearer.strip_prefix("Bearer ").map(|token| token.split('.').count());
                    if parts != Some(3) {
                        return Response::builder().status(StatusCode::UNAUTHORIZED).body(axum::body::Body::empty()).unwrap();
                    }
                    counter.fetch_add(1, Ordering::SeqCst);
                }
                next.run(request).await
            }
        };
        let now = chrono::Utc::now();
        let ago = move |seconds: i64| (now - chrono::Duration::seconds(seconds)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let events = json!({"events": [
            {"seq": 1, "type": "task.queued", "taskId": "task_01AAAAAAAA", "createdAt": ago(120), "payload": {"capabilityId": "code.agent", "capabilityVersion": "1", "attempt": 1, "instruction": "PRIVATE INSTRUCTION"}},
            {"seq": 2, "type": "task.running", "taskId": "task_01AAAAAAAA", "createdAt": ago(100), "payload": {"capabilityId": "code.agent", "capabilityVersion": "1", "attempt": 1}},
            {"seq": 3, "type": "task.succeeded", "taskId": "task_01AAAAAAAA", "createdAt": ago(40), "payload": {"capabilityId": "code.agent", "capabilityVersion": "1", "attempt": 1, "result": "PRIVATE RESULT"}},
            {"seq": 4, "type": "message.created", "taskId": "task_01AAAAAAAA", "createdAt": ago(30), "payload": {"text": "PRIVATE MESSAGE"}}]});
        let audit = json!({"events": [
            {"seq": 1, "action": "task.submit", "taskId": "task_01AAAAAAAA", "authenticatedActor": "agent:agent/pi-requester", "occurredAt": ago(120), "detail": {"capability": "code.agent@1", "prompt": "PRIVATE PROMPT"}},
            {"seq": 2, "action": "task.claim", "taskId": "task_01AAAAAAAA", "authenticatedActor": "agent:agent/pi-agent", "occurredAt": ago(100), "detail": {}},
            {"seq": 3, "action": "task.lease_expired", "taskId": "task_01AAAAAAAA", "authenticatedActor": "service:somework", "occurredAt": ago(90), "detail": {"outcome": "requeued"}}]});
        let runtimes = json!({"runtimes": [{"agentId": "agent/pi-agent", "status": "active", "lastSeenAt": ago(5), "startedAt": ago(900), "meta": {"sdk": "@somework/sdk", "token": "PRIVATE TOKEN"}}]});
        let catalog = json!({"entries": [{"agentCard": {"agentId": "agent/pi-agent", "displayName": "Pi", "description": "PRIVATE DESCRIPTION", "capabilities": [{"id": "code.agent", "version": "1", "sideEffects": "write"}]}, "approval": {"status": "approved"}, "availability": {"state": "available", "activeInstances": 1, "queueDepth": 0}}]});
        let overview = json!({"domainId": "development", "tasksByState": {"succeeded": 1}, "pendingApprovals": 0, "reconciliationQueue": 0, "denialsLast24h": 0, "draftCatalogEntries": 0, "onlineRuntimes": 1, "policyVersion": "builtin-1", "objectStore": "fs", "outbox": [{"sink": "nats", "pending": 0, "failed": 0, "dead": 0, "published": 10, "oldestPendingAgeSeconds": 0}]});
        let app = Router::new()
            .route("/readyz", get(|| async { Json(json!({"database": true, "objectStore": true, "domainId": "development"})) }))
            .route("/metrics", get(|| async { "somework_tasks_queued 0\nsomework_jetstream_consumer_lag{consumer=\"inbox_agent~2fmanager\",stream=\"SOMEWORK_INBOX\"} 2\nsomework_api_requests_total{route=\"x\",status=\"200\"} 5\n" }))
            .route("/v1/admin/overview", get(move || { let body = overview.clone(); async move { Json(body) } }))
            .route("/v1/runtimes", get(move || { let body = runtimes.clone(); async move { Json(body) } }))
            .route("/v1/catalog/entries", get(move || { let body = catalog.clone(); async move { Json(body) } }))
            .route("/v1/admin/events", get(move || { let body = events.clone(); async move { Json(body) } }))
            .route("/v1/admin/audit", get(move || { let body = audit.clone(); async move { Json(body) } }))
            .route("/v1/admin/audit/verify", get(|| async { Json(json!({"intact": true, "firstBrokenSeq": null})) }))
            .layer(middleware::from_fn(guard));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{address}"), authenticated)
    }

    fn key_file() -> Vec<u8> {
        br#"{"kind":"agent","id":"agent/fleet-reader","domainId":"development","privateKey":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8","publicKey":"unused"}"#.to_vec()
    }

    #[tokio::test]
    async fn a_poll_against_a_domain_full_of_content_yields_only_metadata() {
        let (base, authenticated) = fake_domain().await;
        let mut collector = Collector::new(base, String::new(), &key_file(), true).unwrap();
        let sample = collector.sample().await;
        assert_eq!(sample.error, None, "{:?}", sample.error);
        assert!(sample.observed_at.is_some());
        assert_eq!(sample.work.recent.len(), 1);
        assert_eq!(sample.work.recent[0].requester.as_deref(), Some("agent/pi-requester"));
        assert_eq!(sample.work.recent[0].assignee.as_deref(), Some("agent/pi-agent"));
        assert_eq!(sample.work.recent[0].duration_seconds, Some(80.0));
        assert_eq!(sample.domain.audit.intact, Some(true));
        assert_eq!(sample.domain.ready, Some(true));
        assert_eq!(sample.agents.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["agent/pi-agent", "agent/manager"]);
        assert_eq!(sample.agents[0].liveness.label(), "alive");
        assert_eq!(sample.agents[1].inbox_lag, Some(2));
        assert!(authenticated.load(std::sync::atomic::Ordering::SeqCst) >= 6, "the authenticated routes were called with an assertion");
        let output = serde_json::to_string(&sample).unwrap();
        for forbidden in ["PRIVATE", "SECRET"] {
            assert!(!output.contains(forbidden), "leaked {forbidden}: {output}");
        }
        // a second poll continues from the cursors: nothing is applied twice
        let again = collector.sample().await;
        assert_eq!(again.work.throughput.iter().map(|b| b.submitted).sum::<u64>(), 1);
        assert_eq!(again.work.lease_expiries_24h, sample.work.lease_expiries_24h);
    }

    #[tokio::test]
    async fn an_unreachable_domain_is_reported_not_invented() {
        let mut collector = Collector::new("http://127.0.0.1:9".into(), String::new(), &key_file(), true).unwrap();
        let sample = collector.sample().await;
        assert_eq!(sample.observed_at, None);
        assert!(sample.error.as_deref().is_some_and(|e| e.contains("unreachable")));
        assert_eq!(sample.domain.queue_depth, None);
    }

    #[test]
    fn plain_http_needs_the_explicit_preview_switch() {
        assert!(Collector::new("http://x".into(), "not a certificate".into(), &key_file(), false).is_err());
        assert!(Collector::new("https://x".into(), "not a certificate".into(), &key_file(), false).is_err(), "a CA file without a certificate is a startup error");
    }

    #[test]
    fn a_replayed_audit_row_is_counted_once() {
        let mut book = TaskBook::default();
        let row = audit("task.lease_expired", "task_x", "service:somework", 60, json!({"outcome": "requeued"}));
        let mut row = row;
        row["seq"] = json!(7);
        book.apply_audit(&row);
        book.apply_audit(&row);
        assert_eq!(book.work(NOW).lease_expiries_24h, 1);
    }

    #[test]
    fn identifiers_reject_free_text() {
        assert_eq!(identifier(Some(&json!("code.agent@1"))), Some("code.agent@1".into()));
        for bad in ["has space", "semi;colon", "<script>", "", &"x".repeat(97)] {
            assert_eq!(identifier(Some(&Value::String(bad.into()))), None, "{bad}");
        }
    }
}
