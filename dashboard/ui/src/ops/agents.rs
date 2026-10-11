//! The Agents section: every agent with its health and whether its saved setup is in effect.

use crate::{
    Route,
    components::Status,
    format::{ago, plural},
    live::Live,
    ops::{
        agent_page::AgentTab,
        state::{SetupState, classify, delivery_problem, limits_note, revision_pair},
    },
    shell::Gate,
    widgets::{StateBadge, Waiting, use_api},
};
use dioxus::prelude::*;
use fleet_shared::operations::{OpsAgent, OpsAgentList};

/// Agents that need someone first: rejected or unreachable setups, then pending ones, then the rest by name.
pub fn ordered(agents: &[OpsAgent]) -> Vec<OpsAgent> {
    let rank = |agent: &OpsAgent| match classify(agent) {
        SetupState::Rejected(_) => 0,
        SetupState::Unreachable => 1,
        SetupState::Pending => 2,
        SetupState::NotReported => 3,
        SetupState::Applied => 4,
        SetupState::Default => 5,
    };
    let mut list = agents.to_vec();
    list.sort_by(|a, b| rank(a).cmp(&rank(b)).then_with(|| a.id.cmp(&b.id)));
    list
}

#[component]
pub fn Agents() -> Element {
    rsx! { Gate { admin: false, AgentList {} } }
}

#[component]
fn AgentList() -> Element {
    let list = use_api::<OpsAgentList>("/agents".into(), Some(15_000));
    let live = use_context::<Live>();
    let now = *live.now.read();
    let Some(data) = list.get() else {
        return rsx! { h1 { class: "page-title", "Agents" }, Waiting { what: "the agents", failure: list.failed() } };
    };
    let agents = ordered(&data.agents);
    let total = data.agents.len();
    let needing = data.agents.iter().filter(|agent| classify(agent).needs_attention()).count();
    let pending = data.agents.iter().filter(|agent| classify(agent) == SetupState::Pending).count();
    let limits = data.limits_revision;
    let failure = list.failed();
    let attention = format!("{} attention", plural(needing, "needs", "need"));
    rsx! {
        h1 { class: "page-title", "Agents" }
        if let Some(failure) = failure { crate::widgets::ErrorNotice { failure } }
        if !data.sending_configured { div { class: "notice", role: "status", "This server cannot send setup documents (no operations key or domain address): saved revisions are stored but not delivered." } }
        div { class: "summary three", "aria-label": "Agents summary",
            div { span { class: "metric-label", "AGENTS" }, strong { "{total}" }, small { "{attention}" } }
            div { span { class: "metric-label", "SETUP PENDING" }, strong { class: if pending > 0 { "attention" } else { "" }, "{pending}" }, small { "saved, not applied yet" } }
            div { span { class: "metric-label", "FLEET LIMITS" }, strong { if limits == 0 { "—" } else { "r{limits}" } }, small { if limits == 0 { "none saved: agents use their environment values" } else { "latest revision" } } }
        }
        div { class: "machine-table agents-table", table {
            caption { "Agents known to Operations · a saved setup reaches an agent from its next model run" }
            thead { tr { th { "Agent" }, th { "Role" }, th { "Health" }, th { "Setup" }, th { "Revisions" }, th { "Limits" } } }
            tbody {
                if agents.is_empty() { tr { td { colspan: "6", class: "empty", "No agents are known yet. Add them to agents-health.json." } } }
                for agent in agents { AgentRow { key: "{agent.id}", agent, limits, now } }
            }
        } }
    }
}

#[component]
fn AgentRow(agent: OpsAgent, limits: u64, now: i64) -> Element {
    let state = classify(&agent);
    let role = agent.role.clone().unwrap_or_else(|| "—".into());
    let health = agent.liveness.label().to_string();
    let seen = ago(agent.checked_at.as_deref(), now);
    let pair = revision_pair(&agent);
    let sending = delivery_problem(&agent.override_delivery);
    let limit_text = limits_note(&agent, limits).unwrap_or_else(|| "—".into());
    let reason = match &state {
        SetupState::Rejected(reason) => Some(format!("rejected: {reason}")),
        _ => None,
    };
    rsx! {
        tr {
            td { "data-label": "Agent", Link { class: "machine-name agent-link-name", to: Route::AgentPage { slug: agent.slug.clone(), tab: AgentTab::Overview }, "{agent.id}" } }
            td { "data-label": "Role", "{role}" }
            td { "data-label": "Health", div { Status { value: health }, if !agent.reachable { small { "profile unreachable" } } else { small { "profile read {seen}" } } } }
            td { "data-label": "Setup", div { StateBadge { state: state.clone() }, if let Some(reason) = reason { small { class: "wrap reason", "{reason}" } }, if let Some(text) = sending { small { class: "wrap reason", "{text}" } } } }
            td { "data-label": "Revisions", span { class: "numeric", "{pair}" } }
            td { "data-label": "Limits", small { class: "plain-small", "{limit_text}" } }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fleet_shared::operations::RejectedSetup;

    fn agent(id: &str, saved: u64, applied: Option<u64>, reachable: bool) -> OpsAgent {
        OpsAgent { id: id.into(), slug: id.trim_start_matches("agent/").into(), reachable, reports_setup: true, saved_revision: saved, applied_revision: applied, ..Default::default() }
    }

    #[test]
    fn agents_that_need_someone_come_first() {
        let mut rejected = agent("agent/z-rejected", 2, Some(1), true);
        rejected.rejected = Some(RejectedSetup { kind: "override".into(), revision: 2, reason: "no".into(), at: None });
        let list = [agent("agent/a-default", 0, None, true), agent("agent/b-applied", 1, Some(1), true), agent("agent/c-pending", 2, Some(1), true), agent("agent/d-gone", 2, Some(1), false), rejected];
        let ids: Vec<String> = ordered(&list).into_iter().map(|agent| agent.id).collect();
        assert_eq!(ids, ["agent/z-rejected", "agent/d-gone", "agent/c-pending", "agent/b-applied", "agent/a-default"]);
    }
}
