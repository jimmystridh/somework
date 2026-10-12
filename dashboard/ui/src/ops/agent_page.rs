//! One agent: overview and metrics, jobs, work history, the setup editor and its revisions, each a tab (a link, so a tab has an address).

use crate::{
    Route,
    api,
    format::{age, ago, plural, when_ago},
    history::{JobHistory, UsageDetail},
    live::Live,
    ops::{
        metrics::{self, JobCounts},
        revisions::Revisions,
        setup_editor::SetupEditor,
        state::{SetupState, classify, delivery_problem, limits_note, revision_pair},
    },
    shell::Gate,
    somework::{ActiveRow, AgentEventsRow, AgentSetupCard, AlertRow, FinishedRow, SwAgentRow, Throughput, WaitingRow},
    widgets::{StateBadge, Waiting, use_api},
};
use dioxus::prelude::*;
use fleet_shared::{
    operations::{DeliveryView, EffectiveSetup, OpsAgentDetail},
    somework::{AgentEvents, EventAlert, LiveJob, SwAgent},
};
use std::{fmt, str::FromStr};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentTab {
    Overview,
    Jobs,
    History,
    Setup,
    Revisions,
}

const TABS: [AgentTab; 5] = [AgentTab::Overview, AgentTab::Jobs, AgentTab::History, AgentTab::Setup, AgentTab::Revisions];

impl AgentTab {
    pub fn label(self) -> &'static str {
        match self {
            Self::Overview => "Overview",
            Self::Jobs => "Jobs",
            Self::History => "History",
            Self::Setup => "Setup",
            Self::Revisions => "Revisions",
        }
    }

    fn slug(self) -> &'static str {
        match self {
            Self::Overview => "overview",
            Self::Jobs => "jobs",
            Self::History => "history",
            Self::Setup => "setup",
            Self::Revisions => "revisions",
        }
    }
}

impl fmt::Display for AgentTab {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.slug())
    }
}

impl FromStr for AgentTab {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, String> {
        TABS.into_iter().find(|tab| tab.slug() == text).ok_or_else(|| format!("{text} is not a tab of an agent"))
    }
}

#[component]
pub fn AgentPage(slug: String, tab: AgentTab) -> Element {
    rsx! { Gate { admin: false, AgentLoaded { key: "{slug}", slug, tab } } }
}

/// The pipeline alerts about this agent: the domain names the agent in the subject, sometimes with a part after it (`agent/qa handler x`).
pub fn alerts_for(id: &str, alerts: &[EventAlert]) -> Vec<EventAlert> {
    alerts.iter().filter(|alert| alert.subject == id || alert.subject.strip_prefix(id).is_some_and(|rest| rest.starts_with(' ') || rest.starts_with(':') || rest.starts_with('/'))).cloned().collect()
}

/// The agent's `SomeWork` entry (handlers, token pools, log selector) when the fleet sample has it, else one built from the detail.
pub fn events_for(detail: &OpsAgentDetail, sample: Option<&fleet_shared::somework::SomeWork>) -> AgentEvents {
    let mut events = sample.and_then(|work| work.events.agents.iter().find(|agent| agent.id == detail.agent.id)).cloned().unwrap_or_else(|| AgentEvents {
        id: detail.agent.id.clone(),
        reachable: detail.agent.reachable,
        jobs: detail.history.clone(),
        ..Default::default()
    });
    if detail.setup_card.is_some() {
        events.setup = detail.setup_card.clone();
    }
    events
}

#[component]
fn AgentLoaded(slug: String, tab: AgentTab) -> Element {
    let detail = use_api::<OpsAgentDetail>(format!("/agents/{}", api::segment(&slug)), Some(15_000));
    let Some(data) = detail.get() else {
        return rsx! { Crumbs { slug }, Waiting { what: "the agent", failure: detail.failed() } };
    };
    let state = classify(&data.agent);
    let pair = revision_pair(&data.agent);
    let role = data.agent.role.clone().unwrap_or_else(|| "role unknown".into());
    let counts = metrics::job_counts(&data.live_jobs);
    let active = counts.running + counts.waiting;
    let revisions = data.agent.saved_revision;
    let failure = detail.failed();
    let id = data.agent.id.clone();
    rsx! {
        Crumbs { slug: slug.clone() }
        div { class: "agent-head",
            h1 { class: "page-title", "{id}" }
            div { class: "agent-state", span { class: "chip read", "{role}" }, StateBadge { state: state.clone() }, small { "{pair}" } }
        }
        if let SetupState::Rejected(reason) = &state { div { class: "notice error", role: "alert", "Revision {data.agent.saved_revision} was rejected by the agent and its previous setup stays: {reason}" } }
        if let Some(failure) = failure { crate::widgets::ErrorNotice { failure } }
        for note in data.notes.iter() { div { key: "{note}", class: "notice", role: "status", "{note}" } }
        nav { class: "tabs", "aria-label": "Sections of {id}",
            for item in TABS {
                Link {
                    key: "{item}",
                    class: if item == tab { "tab selected" } else { "tab" },
                    to: Route::AgentPage { slug: slug.clone(), tab: item },
                    "aria-current": if item == tab { "page" } else { "false" },
                    "{item.label()}"
                    match item {
                        AgentTab::Jobs => rsx! { small { "{active}" } },
                        AgentTab::History => rsx! { small { "{data.history.len()}" } },
                        AgentTab::Revisions => rsx! { small { "{revisions}" } },
                        _ => rsx! {},
                    }
                }
            }
        }
        match tab {
            AgentTab::Overview => rsx! { Overview { detail: data.clone() } },
            AgentTab::Jobs => rsx! { Jobs { detail: data.clone() } },
            AgentTab::History => rsx! { History { detail: data.clone() } },
            AgentTab::Revisions => rsx! { Revisions { slug: slug.clone(), detail: data.clone(), on_changed: move |_| detail.restart() } },
            AgentTab::Setup => rsx! {},
        }
        div { hidden: tab != AgentTab::Setup,
            SetupEditor { detail: data.clone(), on_saved: move |_| detail.restart() }
        }
    }
}

#[component]
fn Crumbs(slug: String) -> Element {
    rsx! { nav { class: "crumbs", "aria-label": "Breadcrumb", Link { to: Route::Agents {}, "Agents" }, span { "/" }, span { "{slug}" } } }
}

fn delivery_line(label: &str, delivery: &DeliveryView, now: i64) -> String {
    match (delivery.sent_revision, delivery.sent_at.as_deref()) {
        (Some(revision), Some(at)) => format!("{label}: revision {revision} sent {}", ago(Some(at), now)),
        (Some(revision), None) => format!("{label}: revision {revision} sent"),
        _ => format!("{label}: nothing sent yet"),
    }
}

#[component]
fn Overview(detail: OpsAgentDetail) -> Element {
    let live = use_context::<Live>();
    let now = *live.now.read();
    let sample = live.somework.read().clone();
    let events = events_for(&detail, sample.as_ref());
    let sw_agent: Option<SwAgent> = sample.as_ref().and_then(|work| work.agents.iter().find(|agent| agent.id == detail.agent.id)).cloned();
    let counts = metrics::job_counts(&detail.live_jobs);
    let buckets = metrics::hourly_buckets(now, &detail.live_jobs, &detail.history);
    let day = detail.usage.iter().map(|row| row.day.cost_usd).sum::<f64>();
    let grafana = sample.as_ref().and_then(|work| work.events.grafana_url.clone());
    let state = classify(&detail.agent);
    let delivery = delivery_line("Setup", &detail.agent.override_delivery, now);
    let limits_delivery = delivery_line("Limits", &detail.agent.limits_delivery, now);
    let sending_problem = delivery_problem(&detail.agent.override_delivery);
    let limits_problem = delivery_problem(&detail.agent.limits_delivery);
    let limit_state = limits_note(&detail.agent, detail.agent.applied_limits_revision.unwrap_or(0)).unwrap_or_else(|| "no limits reported".into());
    let checked = when_ago(detail.agent.checked_at.as_deref(), now);
    let effective = detail.reported.effective.clone();
    let has_pools = events.pools.is_some() || !events.handlers.is_empty();
    let alerts: Vec<EventAlert> = sample.as_ref().map(|work| alerts_for(&detail.agent.id, &work.events.alerts)).unwrap_or_default();
    rsx! {
        div { class: "summary six", "aria-label": "Agent summary",
            div { span { class: "metric-label", "SETUP" }, strong { class: if state.needs_attention() { "attention" } else { "" }, "{state.label()}" }, small { "{revision_pair(&detail.agent)}" } }
            div { span { class: "metric-label", "HEALTH" }, strong { "{detail.agent.liveness.label()}" }, small { if detail.agent.reachable { "profile read {ago(detail.agent.checked_at.as_deref(), now)}" } else { "profile unreachable" } } }
            div { span { class: "metric-label", "JOBS NOW" }, strong { "{counts.running + counts.waiting}" }, small { "{counts.running} running · {counts.waiting} waiting" } }
            div { span { class: "metric-label", "FAILED, RECENT" }, strong { class: if counts.failed > 0 { "attention" } else { "" }, "{counts.failed}" }, small { "{counts.completed} completed · {counts.cancelled} cancelled" } }
            div { span { class: "metric-label", "COST, 24 H" }, strong { "{crate::history::money(day)}" }, small { "from the usage counters" } }
            div { span { class: "metric-label", "FLEET LIMITS" }, strong { if let Some(revision) = detail.agent.applied_limits_revision { "r{revision}" } else { "—" } }, small { "{limit_state}" } }
        }
        if !alerts.is_empty() {
            div { class: "platform-card alerts",
                h4 { "Needs attention", small { "stopped pools · disabled handlers · dead letters · backlog" } }
                for alert in alerts { AlertRow { key: "{alert.kind}{alert.subject}", alert } }
            }
        }
        if let Some(agent) = sw_agent {
            div { class: "machine-table", table {
                caption { "The agent as the domain sees it · liveness comes from runtime heartbeats" }
                thead { tr { th { "Agent" }, th { "State" }, th { "Capabilities" }, th { "Runtimes" }, th { "Jobs / inbox lag" } } }
                tbody { SwAgentRow { agent, now } }
            } }
        }
        h3 { class: "sub", "Delivery" }
        div { class: "platform-card",
            div { class: "platform-row", span { "{delivery}" }, small { "profile read {checked}" } }
            div { class: "platform-row", span { "{limits_delivery}" } }
            if let Some(text) = sending_problem { p { class: "bad-text", role: "alert", "{text}" } }
            if let Some(text) = limits_problem { p { class: "bad-text", role: "alert", "{text}" } }
            if !detail.agent.reports_setup { p { "This agent's profile carries no setup report: Operations sends each revision once and cannot see whether it applied." } }
        }
        if let Some(effective) = effective { EffectiveCard { effective } }
        h3 { class: "sub", "Throughput and usage" }
        div { class: "work-grid two",
            div { class: "platform-card",
                h4 { "Throughput", small { "last 24 hours" } }
                Throughput { buckets }
                p { "Hourly buckets from this agent's job events and job record. Outlined: started · green: completed · orange: failed." }
            }
            div { class: "platform-card",
                h4 { "Jobs", small { "now and recent" } }
                JobBars { counts }
                p { "Running and waiting now; finished jobs from the recent job events of this agent." }
            }
        }
        UsageDetail { rows: detail.usage.clone() }
        h3 { class: "sub", "Setup" }
        div { class: "setup-list", AgentSetupCard { agent: events.clone(), now, grafana: grafana.clone(), open: true } }
        if events.setup.is_none() { p { class: "empty", "The agent's profile has no setup card: it did not answer or runs a kit too old to describe itself." } }
        if has_pools {
            div { class: "machine-table", table {
                caption { "Handlers and event token pool · from the agent's status endpoint · handler code and error text are never shown" }
                thead { tr { th { "Agent" }, th { "Events pool, today" }, th { "Handlers" } } }
                tbody { AgentEventsRow { agent: events, grafana } }
            } }
        }
    }
}

#[component]
fn JobBars(counts: JobCounts) -> Element {
    let rows = [("running", counts.running), ("waiting", counts.waiting), ("completed", counts.completed), ("failed", counts.failed), ("cancelled", counts.cancelled)];
    let max = rows.iter().map(|(_, n)| *n).max().unwrap_or(1).max(1) as f64;
    rsx! {
        for (name, n) in rows {
            div { key: "{name}", class: "bar-row", span { class: "bar-name", "{name}" }, div { class: "bar", i { class: "fill {name} w{(n as f64 / max * 20.0).round() as u32}" } }, b { "{n}" } }
        }
    }
}

#[component]
fn EffectiveCard(effective: EffectiveSetup) -> Element {
    let model = if effective.model.is_empty() { "—".to_string() } else { effective.model.clone() };
    let effort = effective.effort.clone().unwrap_or_else(|| "not set".to_string());
    let origin = model_origin(&effective);
    let library = if effective.library_skills.is_empty() { "none".to_string() } else { effective.library_skills.join(", ") };
    let repository = if effective.repository_skills.is_empty() { "none".to_string() } else { effective.repository_skills.join(", ") };
    let instructions = match effective.instructions_characters {
        0 => "none".to_string(),
        n => format!("{n} characters"),
    };
    rsx! {
        h3 { class: "sub", "In effect on the agent" }
        div { class: "platform-card effective",
            dl {
                dt { "Operator instructions" } dd { "{instructions}" }
                dt { "Model" } dd { "{model}", if !origin.is_empty() { small { class: "wrap", " · {origin}" } } }
                dt { "Reasoning effort" } dd { "{effort}" }
                dt { "Approval patterns" } dd { "{plural(effective.approval_patterns.len(), \"pattern\", \"patterns\")}" }
                dt { "Repository skills" } dd { "{repository}" }
                dt { "Library skills" } dd { "{library}" }
                dt { "MCP servers" }
                dd {
                    if effective.mcp.is_empty() { "none" }
                    for server in effective.mcp.iter() {
                        div { key: "{server.name}", class: "mcp-line",
                            b { "{server.name}" }, span { class: "chip", "{server.transport}" }, span { class: "chip {approval_class(&server.approval)}", "approval: {server.approval}" }
                            if let Some(error) = server.error.clone() { span { class: "bad-text", role: "alert", "not offered: {error}" } }
                        }
                    }
                }
            }
        }
    }
}

/// Where the agent says its provider, model and effort come from, in words (empty for an agent that does not say).
pub fn model_origin(effective: &EffectiveSetup) -> String {
    let layer = |name: &str| match name {
        "env" => "its environment",
        "fleet" => "the fleet",
        "override" => "its own setup",
        _ => "somewhere",
    };
    match &effective.model_sources {
        Some(sources) => {
            let mut parts = vec![format!("provider from {}", layer(&sources.provider)), format!("model from {}", layer(&sources.model_id))];
            if let Some(effort) = &sources.effort {
                parts.push(format!("effort from {}", layer(effort)));
            }
            parts.join(", ")
        }
        None => String::new(),
    }
}

/// The colour class of an MCP approval mode: `never` lets every call through, so it is the one to notice.
pub fn approval_class(mode: &str) -> &'static str {
    match mode {
        "never" => "write",
        "writes" => "neutral",
        _ => "read",
    }
}

#[component]
fn Jobs(detail: OpsAgentDetail) -> Element {
    let live = use_context::<Live>();
    let now = *live.now.read();
    let (active, finished): (Vec<LiveJob>, Vec<LiveJob>) = detail.live_jobs.iter().cloned().partition(metrics::is_active);
    let waiting: Vec<LiveJob> = active.iter().filter(|job| job.state == "waiting").cloned().collect();
    let counts = metrics::job_counts(&detail.live_jobs);
    let longest = active.iter().filter_map(|job| job.since.as_deref().and_then(fleet_shared::timestamp_ms)).min().map(|since| age(Some(((now - since).max(0) / 1000) as f64))).unwrap_or_else(|| "—".into());
    rsx! {
        div { class: "summary four", "aria-label": "Jobs of this agent",
            div { span { class: "metric-label", "RUNNING" }, strong { "{counts.running}" }, small { "longest for {longest}" } }
            div { span { class: "metric-label", "WAITING" }, strong { class: if counts.waiting > 0 { "attention" } else { "" }, "{counts.waiting}" }, small { "for a resource, one at a time" } }
            div { span { class: "metric-label", "COMPLETED, RECENT" }, strong { "{counts.completed}" }, small { "{counts.cancelled} cancelled" } }
            div { span { class: "metric-label", "FAILED, RECENT" }, strong { class: if counts.failed > 0 { "attention" } else { "" }, "{counts.failed}" }, small { "from the job events" } }
        }
        if !waiting.is_empty() {
            div { class: "platform-card alerts",
                h4 { "Waiting for a resource" }
                for job in waiting { WaitingRow { key: "w{job.id}", job, now } }
            }
        }
        div { class: "machine-table", table {
            caption { "Active jobs · what the agent says about its own jobs, no job input" }
            thead { tr { th { "Job" }, th { "Agent" }, th { "Requested by" }, th { "State" }, th { "For" } } }
            tbody {
                if active.is_empty() { tr { td { colspan: "5", class: "empty", "No job is running or waiting." } } }
                for job in active { ActiveRow { key: "{job.id}", job, now } }
            }
        } }
        div { class: "machine-table", table {
            caption { "Recently finished jobs · newest first" }
            thead { tr { th { "Job" }, th { "Agent" }, th { "Result" }, th { "Took" }, th { "Finished" } } }
            tbody {
                if finished.is_empty() { tr { td { colspan: "5", class: "empty", "No job of this agent has finished since the event log began." } } }
                for job in finished { FinishedRow { key: "{job.id}", job, now } }
            }
        } }
        p { class: "footnote", "Labels and summaries are the agent's own wording, shown as plain text; job input and results are never read." }
    }
}

#[component]
fn History(detail: OpsAgentDetail) -> Element {
    let live = use_context::<Live>();
    let now = *live.now.read();
    rsx! { JobHistory { id: detail.agent.id.clone(), reachable: detail.agent.reachable, jobs: detail.history.clone(), now } }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fleet_shared::somework::{Events, SomeWork};

    #[test]
    fn a_tab_is_its_address_and_nothing_else_parses() {
        for tab in TABS {
            assert_eq!(tab.to_string().parse::<AgentTab>(), Ok(tab));
        }
        assert!("settings".parse::<AgentTab>().is_err());
        assert_eq!(AgentTab::Revisions.to_string(), "revisions");
    }

    #[test]
    fn the_agents_card_comes_from_the_fleet_sample_with_the_detail_as_the_fallback() {
        let detail = OpsAgentDetail { agent: fleet_shared::operations::OpsAgent { id: "agent/qa".into(), reachable: true, ..Default::default() }, ..Default::default() };
        let alone = events_for(&detail, None);
        assert_eq!((alone.id.as_str(), alone.reachable, alone.handlers.len()), ("agent/qa", true, 0));
        let work = SomeWork { events: Events { agents: vec![AgentEvents { id: "agent/qa".into(), logs: Some("{container=\"qa\"}".into()), ..Default::default() }], ..Default::default() }, ..Default::default() };
        assert_eq!(events_for(&detail, Some(&work)).logs.as_deref(), Some("{container=\"qa\"}"));
    }

    #[test]
    fn only_alerts_about_this_agent_are_listed() {
        let alert = |subject: &str| EventAlert { severity: "warning".into(), kind: "agent_unreachable".into(), subject: subject.into(), text: "x".into() };
        let all = [alert("agent/qa"), alert("agent/qa handler triage"), alert("agent/qa2"), alert("agent/pi-agent"), alert("hub")];
        let subjects: Vec<String> = alerts_for("agent/qa", &all).into_iter().map(|alert| alert.subject).collect();
        assert_eq!(subjects, ["agent/qa", "agent/qa handler triage"], "agent/qa2 is another agent");
    }

    #[test]
    fn the_agent_says_where_each_part_of_its_model_comes_from() {
        let mut effective = EffectiveSetup::default();
        assert_eq!(model_origin(&effective), "", "an older agent does not say");
        effective.model_sources = Some(fleet_shared::operations::ModelSources { provider: "env".into(), model_id: "fleet".into(), effort: Some("override".into()) });
        assert_eq!(model_origin(&effective), "provider from its environment, model from the fleet, effort from its own setup");
        effective.model_sources = Some(fleet_shared::operations::ModelSources { provider: "env".into(), model_id: "env".into(), effort: None });
        assert_eq!(model_origin(&effective), "provider from its environment, model from its environment", "no effort is mentioned when none is set");
    }

    #[test]
    fn an_mcp_approval_that_lets_everything_through_is_the_one_marked() {
        assert_eq!((approval_class("never"), approval_class("ask"), approval_class("writes")), ("write", "read", "neutral"));
    }
}
