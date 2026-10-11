use crate::{
    components::Status,
    format::{age, ago, count},
};
use dioxus::prelude::*;
use fleet_shared::somework::{
    AgentEvents, AgentSetup, ConsumerLag, DomainHealth, EventAlert, Events, Firing, HourBucket, HubView, LiveJob, Liveness, RepositoryAccess, RuleView, SomeWork, SwAgent,
    Work,
};

pub fn dash(value: Option<String>) -> String {
    value.filter(|text| !text.is_empty()).unwrap_or_else(|| "—".into())
}

#[component]
pub fn SomeWorkSection(data: Option<SomeWork>, failed: bool, now: i64) -> Element {
    let Some(data) = data else {
        let waiting = if failed { "The SomeWork view could not be loaded." } else { "Waiting for the first SomeWork sample…" };
        return rsx! { section { id: "somework", class: "section", div { class: "section-heading", h2 { span { "01 /" }, "SomeWork" } }, p { class: "empty", "{waiting}" } } };
    };
    let providers = data.agents.iter().filter(|agent| agent.role == "provider").count();
    let alive = data.agents.iter().filter(|agent| agent.role == "provider" && agent.liveness_at(now).healthy()).count();
    let providers_text = if providers == 0 { "—".to_string() } else { format!("{alive} / {providers}") };
    let running = data.work.active.iter().filter(|job| job.state == "running").count();
    let waiting = data.work.active.iter().filter(|job| job.state == "waiting").count();
    let active = running + waiting;
    let failures = data.work.failed_24h;
    let completed = data.work.completed_24h;
    let audit = match data.domain.audit.intact {
        Some(true) => "intact",
        Some(false) => "BROKEN",
        None => "unknown",
    };
    let audit_class = if data.domain.audit.intact == Some(false) { "attention" } else { "" };
    let audit_checked = ago(data.domain.audit.checked_at.as_deref(), now);
    let waiting_class = if waiting > 0 { "attention" } else { "" };
    let failure_class = if failures > 0 { "attention" } else { "" };
    let cancelled = data.work.cancelled_24h;
    let sampled = ago(data.observed_at.as_deref(), now);
    let notice = if failed { Some("Dashboard connection lost. SomeWork values are not current; retrying automatically.".to_string()) } else { data.error.clone() };
    rsx! {
        section { id: "somework", class: "section",
            div { class: "section-heading", h2 { span { "01 /" }, "SomeWork" }, span { class: "section-note", "AGENT COLLABORATION · METADATA ONLY · SAMPLE {sampled}" } }
            if let Some(notice) = notice { div { class: "notice", role: "status", "{notice}" } }
            div { class: "summary six", "aria-label": "SomeWork summary",
                div { span { class: "metric-label", "PROVIDERS ALIVE" }, strong { "{providers_text}" }, small { "Heartbeat within 90 s" } }
                div { span { class: "metric-label", "ACTIVE JOBS" }, strong { "{active}" }, small { "{running} running · {waiting} waiting" } }
                div { span { class: "metric-label", "WAITING FOR A RESOURCE" }, strong { class: "{waiting_class}", "{waiting}" }, small { "One at a time: the next starts when it is free" } }
                div { span { class: "metric-label", "FAILED, 24 H" }, strong { class: "{failure_class}", "{failures}" }, small { "{cancelled} cancelled" } }
                div { span { class: "metric-label", "COMPLETED, 24 H" }, strong { "{completed}" }, small { "From the job events of the agents" } }
                div { span { class: "metric-label", "AUDIT CHAIN" }, strong { class: "{audit_class}", "{audit}" }, small { "Checked {audit_checked}" } }
            }
            SwAgents { agents: data.agents.clone(), now }
            WorkPanel { work: data.work.clone(), now }
            DomainPanel { domain: data.domain.clone(), consumers: data.consumers.clone() }
            EventsPanel { events: data.events.clone(), now }
        }
    }
}

#[component]
fn SwAgents(agents: Vec<SwAgent>, now: i64) -> Element {
    rsx! {
        h3 { class: "sub", "Agents" }
        div { class: "machine-table", table {
            caption { "Principals with a card or that have contacted the domain · liveness comes from runtime heartbeats" }
            thead { tr { th { "Agent" }, th { "State" }, th { "Capabilities" }, th { "Runtimes" }, th { "Jobs / inbox lag" } } }
            tbody {
                if agents.is_empty() { tr { td { colspan: "5", class: "empty", "No agents known to the domain yet." } } }
                for agent in agents { SwAgentRow { key: "{agent.id}", agent, now } }
            }
        } }
    }
}

#[component]
pub fn SwAgentRow(agent: SwAgent, now: i64) -> Element {
    let provider = agent.role == "provider";
    let liveness = agent.liveness_at(now);
    let state = if provider { liveness.label().to_string() } else { "requester".to_string() };
    let show_seen = provider && liveness != Liveness::Unknown;
    let seen = ago(agent.last_seen_at.as_deref(), now);
    let sub = match agent.display_name.clone().filter(|name| !name.is_empty()) {
        Some(name) => format!("{name} · {}", agent.role),
        None => agent.role.clone(),
    };
    let runtimes = if provider { format!("{} active / {}", agent.active_runtimes, agent.total_runtimes) } else { "—".to_string() };
    let sdk = agent.sdk.clone().unwrap_or_default();
    let jobs = format!("{} running · {} waiting", agent.running_jobs, agent.waiting_jobs);
    let blocked = agent.blocked_on.join(" · ");
    let queue = [agent.availability.clone(), Some(format!("inbox {}", count(agent.inbox_lag)))].into_iter().flatten().collect::<Vec<_>>().join(" · ");
    let capabilities: Vec<(String, String)> = agent
        .capabilities
        .iter()
        .map(|capability| (format!("{}@{}", capability.id, capability.version), capability.side_effects.clone().unwrap_or_default()))
        .collect();
    rsx! {
        tr {
            td { div { class: "machine-name", "{agent.id}" }, small { "{sub}" } }
            td { Status { value: state }, if show_seen { small { "seen {seen}" } } }
            td { div { class: "chips",
                if capabilities.is_empty() { small { "—" } }
                for (label, effects) in capabilities { span { key: "{label}", class: "chip {effects}", title: "side effects: {effects}", "{label}" } }
            } }
            td { span { class: "numeric", "{runtimes}" }, small { "{sdk}" } }
            td { span { class: "numeric", "{jobs}" }, if !blocked.is_empty() { small { "waiting for {blocked}" } }, small { "{queue}" } }
        }
    }
}

#[component]
fn WorkPanel(work: Work, now: i64) -> Element {
    let running = work.active.iter().filter(|job| job.state == "running").count() as u64;
    let waiting: Vec<LiveJob> = work.active.iter().filter(|job| job.state == "waiting").cloned().collect();
    let counts = [("running", running), ("waiting", waiting.len() as u64), ("completed", work.completed_24h), ("failed", work.failed_24h), ("cancelled", work.cancelled_24h)];
    let max = counts.iter().map(|(_, n)| *n).max().unwrap_or(1).max(1) as f64;
    let rows: Vec<(String, u64, String)> = counts.into_iter().map(|(name, n)| (name.to_string(), n, format!("w{}", (n as f64 / max * 20.0).round() as u32))).collect();
    let since = ago(work.history_from.as_deref(), now);
    rsx! {
        h3 { class: "sub", "Jobs" }
        div { class: "work-grid",
            div { class: "platform-card",
                h4 { "Jobs", small { "now and the last 24 hours" } }
                for (name, n, width) in rows {
                    div { key: "{name}", class: "bar-row", span { class: "bar-name", "{name}" }, div { class: "bar", i { class: "fill {name} {width}" } }, b { "{n}" } }
                }
                p { "Running and waiting now; finished jobs counted over the last 24 hours." }
            }
            div { class: "platform-card",
                h4 { "Throughput", small { "last 24 hours" } }
                Throughput { buckets: work.throughput.clone() }
                p { "Hourly buckets from the agents' job events (the domain's event log reaches back {since}). Outlined: started · green: completed · orange: failed." }
            }
            div { class: "platform-card",
                h4 { "Waiting for a resource" }
                if waiting.is_empty() { p { class: "good", "No job is waiting." } }
                for job in waiting { WaitingRow { key: "w{job.id}", job, now } }
            }
        }
        div { class: "machine-table", table {
            caption { "Active jobs · what the agents say about their own jobs, no job input" }
            thead { tr { th { "Job" }, th { "Agent" }, th { "Requested by" }, th { "State" }, th { "For" } } }
            tbody {
                if work.active.is_empty() { tr { td { colspan: "5", class: "empty", "No job is running or waiting." } } }
                for job in work.active { ActiveRow { key: "{job.id}", job, now } }
            }
        } }
        div { class: "machine-table", table {
            caption { "Recently finished jobs · newest first" }
            thead { tr { th { "Job" }, th { "Agent" }, th { "Result" }, th { "Took" }, th { "Finished" } } }
            tbody {
                if work.finished.is_empty() { tr { td { colspan: "5", class: "empty", "No job has finished since the event log began." } } }
                for job in work.finished { FinishedRow { key: "{job.id}", job, now } }
            }
        } }
    }
}

#[component]
pub fn WaitingRow(job: LiveJob, now: i64) -> Element {
    let detail = format!("{} · {} · waiting {}", job.agent, dash(job.waiting_for.clone()), ago(job.since.as_deref(), now));
    rsx! { div { class: "attention-row", Status { value: "waiting".to_string() }, span { "{job.label}" }, small { "{detail}" } } }
}

#[component]
pub fn ActiveRow(job: LiveJob, now: i64) -> Element {
    let capability = dash(job.capability.clone());
    let requested = dash(job.requested_by.clone());
    let waiting_for = job.waiting_for.clone().unwrap_or_default();
    let since = ago(job.since.as_deref(), now);
    rsx! {
        tr {
            td { div { class: "machine-name", "{job.label}" }, small { "{job.id} · {capability}" } }
            td { "{job.agent}" }
            td { "{requested}" }
            td { Status { value: job.state.clone() }, if !waiting_for.is_empty() { small { "{waiting_for}" } } }
            td { span { class: "numeric", "{since}" } }
        }
    }
}

#[component]
pub fn FinishedRow(job: LiveJob, now: i64) -> Element {
    let result = job.result.clone().unwrap_or_else(|| "completed".into());
    let summary = job.summary.clone().unwrap_or_default();
    let took = job.seconds.map(|seconds| age(Some(seconds))).unwrap_or_else(|| "—".into());
    let finished = ago(job.finished_at.as_deref(), now);
    rsx! {
        tr {
            td { div { class: "machine-name", "{job.label}" }, small { "{job.id} · {dash(job.capability.clone())}" } }
            td { "{job.agent}" }
            td { Status { value: result }, if !summary.is_empty() { small { class: "wrap", "{summary}" } } }
            td { span { class: "numeric", "{took}" } }
            td { span { class: "numeric", "{finished}" } }
        }
    }
}

#[component]
pub fn Throughput(buckets: Vec<HourBucket>) -> Element {
    let max = buckets.iter().map(|b| b.started.max(b.completed + b.failed)).max().unwrap_or(0).max(1) as f64;
    let view_box = "0 0 432 96".to_string();
    // x, started height, completed height, failed height
    let bars: Vec<(f64, f64, f64, f64)> = buckets
        .iter()
        .enumerate()
        .map(|(i, b)| (i as f64 * 18.0 + 2.0, b.started as f64 / max * 80.0, b.completed as f64 / max * 80.0, b.failed as f64 / max * 80.0))
        .collect();
    rsx! {
        svg { class: "throughput", view_box: "{view_box}", role: "img", "aria-label": "Jobs started and finished per hour, last 24 hours",
            line { x1: "0", y1: "88", x2: "432", y2: "88" }
            for (i, (x, started, ok, bad)) in bars.into_iter().enumerate() {
                g { key: "{i}",
                    rect { class: "submitted", x: "{x}", y: "{88.0 - started}", width: "14", height: "{started}" }
                    rect { class: "ok", x: "{x + 3.0}", y: "{88.0 - ok}", width: "8", height: "{ok}" }
                    rect { class: "bad", x: "{x + 3.0}", y: "{88.0 - ok - bad}", width: "8", height: "{bad}" }
                }
            }
        }
    }
}

#[component]
fn DomainPanel(domain: DomainHealth, consumers: Vec<ConsumerLag>) -> Element {
    let ready = match domain.ready {
        Some(true) => "ready",
        Some(false) => "not ready",
        None => "unknown",
    };
    let audit = match domain.audit.intact {
        Some(true) => "intact",
        Some(false) => "broken",
        None => "unknown",
    };
    let domain_id = domain.domain_id.clone().unwrap_or_else(|| "unknown".into());
    let policy = dash(domain.policy_version.clone());
    let certificates: Vec<(String, String, bool)> = domain
        .certificates
        .iter()
        .map(|c| (c.name.clone(), c.days_left.map(|days| format!("{days} days left")).unwrap_or_else(|| "—".into()), c.days_left.is_some_and(|days| days < 30)))
        .collect();
    let outbox: Vec<(String, String, String)> = domain
        .outbox
        .iter()
        .map(|s| (format!("Outbox → {}", s.sink), format!("{} pending · {} failed · {} dead", s.pending, s.failed, s.dead), format!("{} published · oldest pending {} s", s.published, s.oldest_pending_age_seconds)))
        .collect();
    let requests = count(domain.requests_total);
    let errors = format!("{} / {}", count(domain.requests_server_errors), count(domain.requests_denied));
    let policy_counts = format!("{} / {}", count(domain.policy_allow_total), count(domain.policy_deny_total));
    let restarts = count(domain.runtime_restarts_total);
    let redeliveries = count(domain.jetstream_redeliveries_total);
    let uploads = format!("{} bytes", count(domain.artifact_upload_bytes));
    let denials = count(domain.denials_24h);
    let drafts = count(domain.draft_catalog_entries);
    let online = count(domain.online_runtimes);
    let lags: Vec<(String, String, u64, bool)> =
        consumers.iter().map(|lag| (lag.principal.clone().unwrap_or_else(|| lag.consumer.clone()), lag.kind.clone(), lag.lag, lag.lag > 50)).collect();
    let missing = domain.not_exposed.join(" · ");
    let version = match (domain.version.clone(), domain.uptime_seconds) {
        (Some(version), Some(uptime)) => format!("{version} · up {}", uptime_text(uptime)),
        (Some(version), None) => version,
        _ => "—".to_string(),
    };
    let database = match domain.database_bytes {
        Some(bytes) => format!("{}{}", bytes_text(bytes), domain.wal_bytes.filter(|wal| *wal > 0).map(|wal| format!(" + {} log", bytes_text(wal))).unwrap_or_default()),
        None => "—".to_string(),
    };
    let disabled_principals = domain.principals.iter().filter(|principal| principal.status == "disabled").count();
    let principal_summary = if domain.principals.is_empty() {
        "—".to_string()
    } else {
        let disabled_names: Vec<&str> = domain.principals.iter().filter(|principal| principal.status == "disabled").map(|principal| principal.id.as_str()).collect();
        format!("{} active · {} disabled{}", domain.principals.len() - disabled_principals, disabled_principals, if disabled_names.is_empty() { String::new() } else { format!(" ({})", disabled_names.join(", ")) })
    };
    rsx! {
        h3 { class: "sub", "Domain and message bus" }
        div { class: "domain-grid",
            div { class: "platform-card",
                h4 { "Domain", small { "{domain_id}" } }
                div { class: "platform-row", span { "Database and object store" }, Status { value: ready.to_string() } }
                div { class: "platform-row", span { "Audit hash chain" }, Status { value: audit.to_string() } }
                div { class: "platform-row", span { "Policy version" }, b { "{policy}" } }
                div { class: "platform-row", span { "Policy denials, 24 h" }, b { "{denials}" } }
                div { class: "platform-row", span { "Draft catalog entries" }, b { "{drafts}" } }
                div { class: "platform-row", span { "Online runtimes" }, b { "{online}" } }
                div { class: "platform-row", span { "Version · uptime" }, b { "{version}" } }
                div { class: "platform-row", span { "Database" }, b { "{database}" } }
                div { class: "platform-row", span { "Principals" }, b { class: if disabled_principals > 0 { "attention" } else { "" }, "{principal_summary}" } }
                for (name, text, soon) in certificates {
                    div { key: "{name}", class: "platform-row", span { "{name}" }, b { class: if soon { "attention" } else { "" }, "{text}" } }
                }
            }
            div { class: "platform-card",
                h4 { "Outbox and counters" }
                for (name, text, detail) in outbox {
                    div { key: "{name}", class: "platform-row", span { "{name}" }, b { "{text}" } }
                    div { class: "platform-row", small { "{detail}" } }
                }
                div { class: "platform-row", span { "API requests" }, b { "{requests}" } }
                div { class: "platform-row", span { "Server errors / denied" }, b { "{errors}" } }
                div { class: "platform-row", span { "Policy allow / deny" }, b { "{policy_counts}" } }
                div { class: "platform-row", span { "Runtime restarts" }, b { "{restarts}" } }
                div { class: "platform-row", span { "JetStream redeliveries" }, b { "{redeliveries}" } }
                div { class: "platform-row", span { "Artifact uploads" }, b { "{uploads}" } }
            }
            div { class: "platform-card",
                h4 { "JetStream consumers", small { "pending messages" } }
                if lags.is_empty() { p { "No consumer figures in the last sample." } }
                for (name, kind, lag, high) in lags {
                    div { key: "{name}{kind}", class: "platform-row", span { "{name}" }, small { "{kind}" }, b { class: if high { "attention" } else { "" }, "{lag}" } }
                }
            }
        }
        p { class: "footnote", "Not shown because the domain does not expose it to a read-only identity: {missing}" }
    }
}

fn reasons(map: &std::collections::BTreeMap<String, u64>) -> String {
    if map.is_empty() {
        return "—".into();
    }
    map.iter().map(|(reason, n)| format!("{reason} {n}")).collect::<Vec<_>>().join(" · ")
}

/// Width class in 5 % steps: the page's content policy forbids inline styles.
fn width_class(used: u64, limit: u64) -> String {
    let share = if limit == 0 { 0.0 } else { (used as f64 / limit as f64).clamp(0.0, 1.0) };
    format!("w{}", (share * 20.0).round() as u32)
}

#[component]
fn EventsPanel(events: Events, now: i64) -> Element {
    let critical = events.alerts.iter().filter(|alert| alert.severity == "critical").count();
    let warnings = events.alerts.len() - critical;
    let rules_total = events.rules.len();
    let active = events.rules.iter().filter(|rule| rule.status == "active").count();
    let paused = rules_total - active;
    let published = count(events.pipeline.events_published);
    let duplicates = count(events.pipeline.events_duplicate);
    let skipped_by_reason = events.rules.iter().fold(std::collections::BTreeMap::new(), |mut all, rule| {
        for (reason, n) in &rule.skipped {
            *all.entry(reason.clone()).or_insert(0) += n;
        }
        all
    });
    let skipped_total: u64 = skipped_by_reason.values().sum();
    let fired_total: u64 = events.rules.iter().map(|rule| rule.fired).sum();
    let skipped_detail = reasons(&skipped_by_reason);
    let alerts_class = if critical > 0 { "attention" } else { "" };
    let reached = events.agents.iter().filter(|agent| agent.reachable).count();
    let dead = events.hub.dead_letters;
    let dead_class = if dead > 0 { "attention" } else { "" };
    let rules_note = if events.rules_known { String::new() } else { "The domain did not return rules (an older domain, or the dashboard identity may not read them).".to_string() };
    rsx! {
        h3 { class: "sub", "Events and subscriptions" }
        if !rules_note.is_empty() { div { class: "notice", role: "status", "{rules_note}" } }
        div { class: "summary six", "aria-label": "Events summary",
            div { span { class: "metric-label", "ALERTS" }, strong { class: "{alerts_class}", "{events.alerts.len()}" }, small { "{critical} critical · {warnings} warnings" } }
            div { span { class: "metric-label", "RULES" }, strong { "{rules_total}" }, small { "{active} active · {paused} paused" } }
            div { span { class: "metric-label", "EVENTS PUBLISHED" }, strong { "{published}" }, small { "{duplicates} duplicates ignored" } }
            div { span { class: "metric-label", "WAKES SENT" }, strong { "{fired_total}" }, small { "{skipped_total} skipped" } }
            div { span { class: "metric-label", "AGENTS REACHED" }, strong { "{reached}" }, small { "of {events.agents_configured} configured" } }
            div { span { class: "metric-label", "DEAD LETTERS" }, strong { class: "{dead_class}", "{dead}" }, small { "Webhooks the hub gave up on" } }
        }
        EventAlerts { alerts: events.alerts.clone() }
        RulesTable { rules: events.rules.clone(), skipped_detail, now }
        HubPanel { hub: events.hub.clone() }
        p { class: "footnote", "Handlers, event token pools and the setup of each agent are on the agent's own page under Agents." }
    }
}

#[component]
fn EventAlerts(alerts: Vec<EventAlert>) -> Element {
    rsx! {
        div { class: "platform-card alerts",
            h4 { "Needs attention", small { "stopped pools · disabled handlers · dead letters · backlog" } }
            if alerts.is_empty() { p { class: "good", "Nothing in the event pipeline needs attention." } }
            for alert in alerts { AlertRow { key: "{alert.kind}{alert.subject}", alert } }
        }
    }
}

#[component]
pub fn AlertRow(alert: EventAlert) -> Element {
    let detail = format!("{} · {}", alert.subject, alert.text);
    rsx! { div { class: "attention-row", Status { value: alert.severity.clone() }, span { "{alert.kind}" }, small { "{detail}" } } }
}

#[component]
fn RulesTable(rules: Vec<RuleView>, skipped_detail: String, now: i64) -> Element {
    let note = format!("Subscriptions: which events wake which agent · skipped by reason, all rules: {skipped_detail}");
    rsx! {
        div { class: "machine-table", table {
            caption { "{note}" }
            thead { tr { th { "Rule" }, th { "Owner" }, th { "Selector" }, th { "State" }, th { "Woken / skipped" }, th { "Recent firings" } } }
            tbody {
                if rules.is_empty() { tr { td { colspan: "6", class: "empty", "No rules are applied to the domain." } } }
                for rule in rules { RuleRow { key: "{rule.name}", rule, now } }
            }
        } }
    }
}

#[component]
fn RuleRow(rule: RuleView, now: i64) -> Element {
    let target = rule.selector.clone();
    let owner = rule.owner.clone();
    let last = ago(rule.last_fired_at.as_deref(), now);
    let skipped = reasons(&rule.skipped);
    let counts = format!("{} woken / {} skipped", rule.fired, rule.skipped_total());
    let firings: Vec<(String, String)> = rule.firings.iter().map(firing_chip).collect();
    rsx! {
        tr {
            td { div { class: "machine-name", "{rule.name}" }, small { if rule.last_fired_at.is_some() { "last fired {last}" } else { "never fired" } } }
            td { small { "{owner}" } }
            td { span { class: "numeric target", "{target}" } }
            td { Status { value: rule.status.clone() } }
            td { span { class: "numeric", "{counts}" }, small { "{skipped}" } }
            td { div { class: "chips",
                if firings.is_empty() { small { "—" } }
                for (index, (label, class)) in firings.into_iter().enumerate() { span { key: "{index}", class: "chip {class}", "{label}" } }
            } }
        }
    }
}

fn firing_chip(firing: &Firing) -> (String, String) {
    let label = match &firing.reason {
        Some(reason) => format!("{} · {reason}", firing.status),
        None => firing.status.clone(),
    };
    let class = match firing.status.as_str() {
        "fired" => "read",
        "skipped" => "write",
        _ => "",
    };
    (label, class.into())
}

#[component]
fn HubPanel(hub: HubView) -> Element {
    let state = hub.state.clone();
    if hub.state != "ok" {
        let text = if hub.state == "not configured" { "The hub is not configured on this dashboard (HUB_URL)." } else { "The hub did not answer the last read." };
        return rsx! {
            div { class: "platform-card", h4 { "Hub and receiver", small { "{state}" } }, p { "{text}" } }
        };
    }
    let receiver = match hub.receiver_up {
        Some(true) => "reachable",
        Some(false) => "unreachable",
        None => "unknown",
    };
    let queued = count(hub.receiver_queued);
    let oldest = age(hub.receiver_oldest_age_seconds);
    let oldest_class = if hub.receiver_oldest_age_seconds.is_some_and(|seconds| seconds > 300.0) { "attention" } else { "" };
    let inbox = count(hub.inbox_size);
    let schedules: Vec<(String, String, String)> = hub
        .schedules
        .iter()
        .map(|schedule| {
            let next = schedule.next_run_at.clone().map(|at| at.chars().take(16).collect::<String>().replace('T', " ")).unwrap_or_else(|| "—".into());
            (schedule.name.clone(), format!("{} ticks · {} missed", schedule.ticks, schedule.missed), format!("next {next} UTC"))
        })
        .collect();
    rsx! {
        div { class: "domain-grid",
            div { class: "platform-card",
                h4 { "Receiver", small { "public edge, pulled by the hub" } }
                div { class: "platform-row", span { "Hub to receiver" }, Status { value: if receiver == "reachable" { "ready".to_string() } else { receiver.to_string() } } }
                div { class: "platform-row", span { "Webhooks queued" }, b { "{queued}" } }
                div { class: "platform-row", span { "Oldest queued" }, b { class: "{oldest_class}", "{oldest}" } }
                div { class: "platform-row", span { "Internal listener backlog" }, b { "{inbox}" } }
            }
            div { class: "platform-card",
                h4 { "Clock", small { "schedules in the hub" } }
                if schedules.is_empty() { p { "No schedules known." } }
                for (name, ticks, next) in schedules {
                    div { key: "{name}", class: "platform-row", span { "{name}" }, small { "{ticks}" }, b { "{next}" } }
                }
            }
        }
        div { class: "machine-table", table {
            caption { "Webhook sources · counters since the hub started" }
            thead { tr { th { "Source" }, th { "State" }, th { "Received" }, th { "Published" }, th { "Duplicate" }, th { "Dropped" }, th { "Dead letters" }, th { "Failures" } } }
            tbody {
                if hub.sources.is_empty() { tr { td { colspan: "8", class: "empty", "No webhook has reached the hub yet." } } }
                for source in hub.sources.iter() { SourceRow { key: "{source.name}", source: source.clone() } }
            }
        } }
    }
}

#[component]
fn SourceRow(source: fleet_shared::somework::HubSource) -> Element {
    let state = match source.paused {
        Some(true) => "paused",
        Some(false) => "active",
        None => "unknown",
    };
    let dead_class = if source.dead_letters > 0 { "attention" } else { "" };
    rsx! {
        tr {
            td { div { class: "machine-name", "{source.name}" }, if source.forwarded > 0 { small { "{source.forwarded} forwarded" } } }
            td { Status { value: state.to_string() } }
            td { class: "numeric", "{source.received}" }
            td { class: "numeric", "{source.published}" }
            td { class: "numeric", "{source.duplicate}" }
            td { class: "numeric", "{source.dropped}" }
            td { class: "numeric {dead_class}", "{source.dead_letters}" }
            td { class: "numeric", "{source.failures}" }
        }
    }
}

fn changed_recently(setup: &AgentSetup, now: i64) -> bool {
    setup.changed_at.as_deref().and_then(fleet_shared::timestamp_ms).is_some_and(|at| now >= at && now - at < 24 * 3_600_000)
}

/// A Grafana Explore link on the Loki datasource for one stream selector, for the last hour. Both inputs were checked by the server.
fn logs_link(base: &str, selector: &str) -> String {
    let panes = format!(r#"{{"a":{{"datasource":"cluster-loki","queries":[{{"refId":"A","expr":{},"queryType":"range"}}],"range":{{"from":"now-1h","to":"now"}}}}}}"#, js_string(selector));
    format!("{}/explore?schemaVersion=1&orgId=1&panes={}", base.trim_end_matches('/'), urlencoding::encode(&panes))
}

/// A JSON string literal: the selector alphabet has quotes in it, nothing else that needs escaping.
fn js_string(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

fn bytes_text(bytes: u64) -> String {
    match bytes {
        0..=1023 => format!("{bytes} B"),
        1024..=1_048_575 => format!("{:.1} KiB", bytes as f64 / 1024.0),
        1_048_576..=1_073_741_823 => format!("{:.1} MiB", bytes as f64 / 1_048_576.0),
        _ => format!("{:.2} GiB", bytes as f64 / 1_073_741_824.0),
    }
}

fn uptime_text(seconds: u64) -> String {
    match seconds {
        0..=59 => format!("{seconds} s"),
        60..=3599 => format!("{} min", seconds / 60),
        3600..=86_399 => format!("{} h {} min", seconds / 3600, seconds % 3600 / 60),
        _ => format!("{} d {} h", seconds / 86_400, seconds % 86_400 / 3600),
    }
}

fn credential_text(repository: &RepositoryAccess) -> String {
    match repository.credential.as_str() {
        "github-app" => format!("GitHub App{}", repository.github_identity.as_deref().map(|login| format!(" · acts as {login}")).unwrap_or_default()),
        "token" => format!("personal token{}", repository.token_expires.as_deref().map(|date| format!(" · expires {date}")).unwrap_or_default()),
        _ => "no repository credential".to_string(),
    }
}

fn budget_text(setup: &AgentSetup) -> String {
    format!(
        "default {} tokens / {} min per job · caps {} tokens / {} min · {} tokens per day · {} at a time{}",
        setup.default_tokens,
        setup.default_minutes,
        setup.max_tokens_cap,
        setup.max_minutes_cap,
        setup.daily_token_limit,
        setup.concurrency,
        if setup.budget_required { " · a job must bring a budget" } else { "" }
    )
}

/// How one agent is set up, from its own `/profile`: prompt, tools, budgets, repository access, chat and events. Read-only.
#[component]
pub fn AgentSetupCard(agent: AgentEvents, now: i64, grafana: Option<String>, open: bool) -> Element {
    let Some(setup) = agent.setup.clone() else { return rsx! {} };
    let logs = grafana.as_deref().zip(agent.logs.as_deref()).map(|(base, selector)| logs_link(base, selector));
    let changed = changed_recently(&setup, now);
    let tools = if setup.all_tools { "all coding tools".to_string() } else { setup.tools.join(", ") };
    let repository = &setup.repository;
    let access = if repository.no_repository {
        "works on no repository".to_string()
    } else {
        format!("{}{}{}", if repository.push { "pushes to " } else { "read only; " }, if repository.push { format!("{}/ branches", repository.branch_prefix) } else { "no branches".to_string() }, if repository.pull_request { if repository.draft_pull_requests { " · draft pull requests" } else { " · pull requests" } } else { "" })
    };
    let credential = credential_text(repository);
    let budgets = budget_text(&setup);
    let hosts = repository.token_hosts.join(", ");
    let mirror = repository.mirror_repositories.join(", ");
    let capabilities = setup.capabilities.join(", ");
    let models = setup.allowed_models.join(", ");
    let skills = setup.skills.join(", ");
    let approvers = setup.chat_approvers.join(", ");
    let tool_approvals = setup.tool_approvals.join(", ");
    let events = if setup.events_enabled { format!("on · results to {}", setup.events_notify_to.clone().unwrap_or_else(|| "—".into())) } else { "off".to_string() };
    let observe = if setup.observe_enabled { format!("on · {} scope", setup.observe_scope.clone().unwrap_or_else(|| "own".into())) } else { "off".to_string() };
    let prompt_note = format!("{} characters · sha256 {}", setup.prompt_characters, setup.prompt_sha256);
    rsx! {
        details { class: "platform-card setup", open,
            summary {
                span { class: "machine-name", "{agent.id}" }
                span { class: "chip read", "{setup.role}" }
                span { class: "chip", "{setup.version}" }
                small { "setup {setup.hash}" }
                if changed { span { class: "chip write", "changed in the last day" } }
                if let Some(url) = logs { a { class: "logs-link", href: "{url}", target: "_blank", rel: "noopener noreferrer", onclick: |event| event.stop_propagation(), "logs" } }
            }
            dl {
                dt { "Capabilities" } dd { "{capabilities}" }
                dt { "Model" } dd { "{setup.model}", if !models.is_empty() { small { " · allowed: {models}" } } }
                dt { "Budgets" } dd { "{budgets}" }
                dt { "Tools" } dd { "{tools}", if !tool_approvals.is_empty() { small { " · approval for: {tool_approvals}" } } }
                dt { "Repository" } dd { "{access}", small { " · {credential}" }, if !hosts.is_empty() { small { " · credential only sent to {hosts}" } } }
                if !mirror.is_empty() { dt { "Mirror" } dd { "{mirror}" } }
                if !skills.is_empty() { dt { "Skills" } dd { "{skills}" } }
                dt { "Conversations" } dd { "{setup.chat_mode}", if !approvers.is_empty() { small { " · approvals decided by: {approvers}" } } }
                dt { "Events" } dd { "{events}" }
                dt { "Observe tools" } dd { "{observe}" }
                if let Some(changed_at) = setup.changed_at.clone() { dt { "Setup changed" } dd { "{changed_at}" } }
            }
            if !setup.command_approvals.is_empty() || setup.extra_approval_patterns > 0 {
                table { class: "approval-patterns",
                    caption { "Commands that wait for a person" }
                    tbody {
                        for item in setup.command_approvals.clone() { tr { key: "{item.pattern}", td { code { "{item.pattern}" } }, td { "{item.reason}" } } }
                        if setup.extra_approval_patterns > 0 { tr { td { colspan: "2", small { "{setup.extra_approval_patterns} more patterns from the deployment's settings" } } } }
                    }
                }
            }
            h5 { "System prompt", small { " · {prompt_note}" } }
            if let Some(prompt) = setup.prompt.clone() { pre { class: "prompt", "{prompt}" } } else { p { small { "The agent does not show its prompt text (the hash identifies it)." } } }
        }
    }
}

#[component]
pub fn AgentEventsRow(agent: AgentEvents, grafana: Option<String>) -> Element {
    let logs = grafana.as_deref().zip(agent.logs.as_deref()).map(|(base, selector)| logs_link(base, selector));
    let pool = agent.pools.clone();
    let handlers: Vec<(String, String, String)> = agent
        .handlers
        .iter()
        .map(|handler| {
            let label = format!("{} v{}", handler.name, handler.version);
            let class = if handler.enabled { "read" } else { "write" };
            let detail = if handler.enabled {
                format!("{} runs · {} errors · {} drops · {} wakes", handler.runs, handler.errors, handler.drops, handler.wakes)
            } else {
                format!("disabled ({}) · {} runs · {} errors", handler.disabled_reason.clone().unwrap_or_else(|| "other".into()), handler.runs, handler.errors)
            };
            (label, class.to_string(), detail)
        })
        .collect();
    let state = if !agent.reachable { "offline" } else { "ready" };
    rsx! {
        tr {
            td { div { class: "machine-name", "{agent.id}" }, Status { value: state.to_string() }, if let Some(url) = logs.clone() { a { class: "logs-link", href: "{url}", target: "_blank", rel: "noopener noreferrer", "logs" } } }
            td {
                if let Some(pool) = pool {
                    {
                        let width = width_class(pool.events_used, pool.events_limit);
                        let flag = if pool.stopped { "stopped" } else if pool.throttled { "throttled" } else { "" };
                        let text = format!("{} / {} tokens", pool.events_used, pool.events_limit);
                        let jobs = format!("jobs {} / {}", pool.jobs_used, pool.jobs_limit);
                        rsx! {
                            span { class: "numeric", "{text}" }
                            div { class: "bar", i { class: "fill pool {flag} {width}" } }
                            small { "{jobs}", if !flag.is_empty() { " · {flag}" } }
                        }
                    }
                } else { small { "—" } }
            }
            td { div { class: "handler-list",
                if handlers.is_empty() { small { "no handlers" } }
                for (label, class, detail) in handlers { div { key: "{label}", class: "handler", span { class: "chip {class}", "{label}" }, small { "{detail}" } } }
            } }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_bars_use_five_percent_steps_and_never_exceed_the_scale() {
        assert_eq!(width_class(0, 100), "w0");
        assert_eq!(width_class(50, 100), "w10");
        assert_eq!(width_class(1000, 100), "w20");
        assert_eq!(width_class(5, 0), "w0", "a missing limit must not divide by zero");
    }

    #[test]
    fn skipped_reasons_list_each_reason_once() {
        let mut map = std::collections::BTreeMap::new();
        assert_eq!(reasons(&map), "—");
        map.insert("rate".to_string(), 2);
        map.insert("duplicate".to_string(), 1);
        assert_eq!(reasons(&map), "duplicate 1 · rate 2");
    }

    #[test]
    fn firing_chips_prefer_the_reason_and_colour_by_outcome() {
        let skipped = Firing { status: "skipped".into(), reason: Some("depth".into()), at: None };
        assert_eq!(firing_chip(&skipped), ("skipped · depth".to_string(), "write".to_string()));
        let fired = Firing { status: "fired".into(), reason: None, at: None };
        assert_eq!(firing_chip(&fired), ("fired".to_string(), "read".to_string()));
    }

    fn setup() -> AgentSetup {
        AgentSetup { default_tokens: 100, default_minutes: 5, max_tokens_cap: 500, max_minutes_cap: 60, daily_token_limit: 1000, concurrency: 2, budget_required: true, changed_at: Some("2026-10-06T10:00:00.000Z".into()), ..Default::default() }
    }

    #[test]
    fn a_setup_counts_as_changed_for_a_day_and_not_before_it_happened() {
        let at = fleet_shared::timestamp_ms("2026-10-06T10:00:00.000Z").unwrap();
        assert!(changed_recently(&setup(), at + 3_600_000));
        assert!(!changed_recently(&setup(), at + 25 * 3_600_000));
        assert!(!changed_recently(&setup(), at - 1), "a time in the future is not a change we have seen");
        assert!(!changed_recently(&AgentSetup::default(), at));
    }

    #[test]
    fn the_credential_is_named_without_the_credential() {
        let app = RepositoryAccess { credential: "github-app".into(), github_identity: Some("somework-developer[bot]".into()), ..Default::default() };
        assert_eq!(credential_text(&app), "GitHub App · acts as somework-developer[bot]");
        let token = RepositoryAccess { credential: "token".into(), token_expires: Some("2026-11-05".into()), ..Default::default() };
        assert_eq!(credential_text(&token), "personal token · expires 2026-11-05");
        assert_eq!(credential_text(&RepositoryAccess::default()), "no repository credential");
    }

    #[test]
    fn budgets_read_as_one_line() {
        assert_eq!(budget_text(&setup()), "default 100 tokens / 5 min per job · caps 500 tokens / 60 min · 1000 tokens per day · 2 at a time · a job must bring a budget");
    }

    #[test]
    fn sizes_and_uptimes_read_naturally() {
        assert_eq!((bytes_text(512), bytes_text(2048), bytes_text(8_388_608), bytes_text(3 * 1_073_741_824)), ("512 B".to_string(), "2.0 KiB".to_string(), "8.0 MiB".to_string(), "3.00 GiB".to_string()));
        assert_eq!((uptime_text(30), uptime_text(600), uptime_text(3700), uptime_text(200_000)), ("30 s".to_string(), "10 min".to_string(), "1 h 1 min".to_string(), "2 d 7 h".to_string()));
    }

    #[test]
    fn the_log_link_opens_the_selector_on_the_loki_datasource() {
        let link = logs_link("https://grafana.example/", r#"{container="somework-pi-agent-1"}"#);
        assert!(link.starts_with("https://grafana.example/explore?schemaVersion=1&orgId=1&panes="));
        let panes = urlencoding::decode(link.split("panes=").nth(1).unwrap()).unwrap().to_string();
        assert!(panes.contains(r#""datasource":"cluster-loki""#));
        assert!(panes.contains(r#""expr":"{container=\"somework-pi-agent-1\"}""#), "{panes}");
        assert!(!link.contains('"') && !link.contains('{') && !link.contains(' '), "everything that is not URL-safe is encoded");
    }
}
