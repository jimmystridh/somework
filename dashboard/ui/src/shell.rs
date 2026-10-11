//! The frame of every page (rail, header, sign-in state) and the older fleet sections, which keep their content and get a page each.

use crate::{
    Route,
    api,
    components::{MachineTable, Platform},
    format,
    history::{UsagePanel, WorkHistory},
    live::Live,
    session::{Access, Session, use_session},
    somework::SomeWorkSection,
};
use dioxus::prelude::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Section {
    Agents,
    Catalog,
    Library,
    Limits,
    Users,
    Audit,
    SomeWork,
    History,
    Usage,
    Machines,
    Other,
}

impl Section {
    pub fn title(self) -> &'static str {
        match self {
            Self::Agents => "AGENTS",
            Self::Catalog => "MCP CATALOG",
            Self::Library => "SKILL LIBRARY",
            Self::Limits => "FLEET LIMITS",
            Self::Users => "USERS",
            Self::Audit => "AUDIT",
            Self::SomeWork => "SOMEWORK OVERVIEW",
            Self::History => "WORK HISTORY",
            Self::Usage => "MODEL USAGE",
            Self::Machines => "MACHINES AND PLATFORM",
            Self::Other => "NOT FOUND",
        }
    }
}

pub fn section_of(route: &Route) -> Section {
    match route {
        Route::Agents {} | Route::AgentPage { .. } => Section::Agents,
        Route::Catalog {} => Section::Catalog,
        Route::Library {} => Section::Library,
        Route::Limits {} => Section::Limits,
        Route::Users {} => Section::Users,
        Route::Audit {} => Section::Audit,
        Route::SomeWorkPage {} => Section::SomeWork,
        Route::HistoryPage {} => Section::History,
        Route::UsagePage {} => Section::Usage,
        Route::MachinesPage {} => Section::Machines,
        Route::NotFound { .. } => Section::Other,
    }
}

fn selected(current: Section, link: Section) -> &'static str {
    if current == link { "selected" } else { "" }
}

#[component]
pub fn Shell() -> Element {
    let live = use_context::<Live>();
    let session = use_session();
    let route = use_route::<Route>();
    let section = section_of(&route);
    let here = format!("/fleet{route}");
    use_future(move || {
        let here = here.clone();
        async move {
            if let Some(failure) = crate::session::load(session.0).await {
                debug_assert!(failure.not_signed_in());
                navigator().push(NavigationTarget::<String>::External(api::sign_in_url(&here)));
            }
        }
    });
    let connected = live.connected();
    let loading = *live.loading.read();
    let me = session.me();
    let admin = session.is_admin();
    let stub = me.as_ref().filter(|me| me.auth == "stub").map(|me| me.email.clone());
    let sampled = format::ago(live.fleet.read().as_ref().and_then(|data| data.observed_at.clone()).as_deref(), *live.now.read());
    rsx! {
        a { class: "skip", href: "#content", "Skip to content" }
        aside { class: "rail",
            Link { class: "brand", to: Route::Agents {}, "aria-label": "Operations home", "O", span { "／" } }
            div { class: "rail-caption", "OPERATIONS" }
            nav { "aria-label": "Operations",
                Link { class: selected(section, Section::Agents), to: Route::Agents {}, span { "01" }, "Agents" }
                Link { class: selected(section, Section::Catalog), to: Route::Catalog {}, span { "02" }, "MCP catalog" }
                Link { class: selected(section, Section::Library), to: Route::Library {}, span { "03" }, "Skill library" }
                if admin { Link { class: selected(section, Section::Limits), to: Route::Limits {}, span { "04" }, "Fleet limits" } }
                if admin { Link { class: selected(section, Section::Users), to: Route::Users {}, span { "05" }, "Users" } }
                Link { class: selected(section, Section::Audit), to: Route::Audit {}, span { "06" }, "Audit" }
            }
            div { class: "rail-caption second", "FLEET" }
            nav { "aria-label": "Fleet sections",
                Link { class: selected(section, Section::SomeWork), to: Route::SomeWorkPage {}, span { "·" }, "SomeWork" }
                Link { class: selected(section, Section::History), to: Route::HistoryPage {}, span { "·" }, "Work history" }
                Link { class: selected(section, Section::Usage), to: Route::UsagePage {}, span { "·" }, "Model usage" }
                Link { class: selected(section, Section::Machines), to: Route::MachinesPage {}, span { "·" }, "Machines" }
                a { href: "/d/agent-cluster-logs", span { "↗" }, "Grafana logs" }
            }
            div { class: "rail-bottom", UserBox { session } }
        }
        main { id: "content",
            header {
                div { class: "eyebrow", "OPERATIONS / {section.title()}" }
                div { class: "sync", span { class: if connected { "dot" } else { "dot pending" } }, span { if connected { "Live" } else { "Sample delayed" } },
                    button { id: "refresh", "aria-label": "Refresh the fleet samples", disabled: loading, onclick: move |_| { spawn(live.refresh()); }, "↻" }
                }
            }
            if let Some(email) = stub { div { class: "notice", role: "status", "Development sign-in: every request is signed in as {email}. This must never run on a deployment." } }
            Outlet::<Route> {}
            footer { span { "OPERATIONS / AGENT CLUSTER" }, span { "Rust + Dioxus · Setup changes are saved as revisions and sent to the agents; no conversation content." }, span { "Hypervisor sample {sampled}" } }
        }
    }
}

#[component]
fn UserBox(session: Session) -> Element {
    let mut leaving = use_signal(|| false);
    let Some(me) = session.me() else {
        return rsx! { span { class: "lock", "◆" }, "PRIVATE NETWORK", br {}, small { "Rust + Dioxus" } };
    };
    let role = me.role.label();
    let can_leave = me.auth != "stub";
    rsx! {
        span { class: "lock", "◆" }, "{me.email}", br {}
        small { "{role}" }
        if can_leave {
            button { class: "rail-button", disabled: leaving(), onclick: move |_| {
                leaving.set(true);
                spawn(async move {
                    api::sign_out().await;
                    navigator().push(NavigationTarget::<String>::External(api::SIGN_IN.to_string()));
                });
            }, "Sign out" }
        }
    }
}

/// Wraps a page that needs Operations: waits for the sign-in check, and explains when Operations is not available or the role is too low.
#[component]
pub fn Gate(admin: bool, children: Element) -> Element {
    let session = use_session();
    let access = session.0.read().clone();
    match access {
        Access::Loading => rsx! { p { class: "empty", role: "status", "Checking your sign-in…" } },
        Access::Unavailable(text) => rsx! { div { class: "notice", role: "status", "{text}. The fleet sections of the rail still work." } },
        Access::Failed(text) => rsx! { div { class: "notice error", role: "alert", "{text}" } },
        Access::Ready(me) if admin && !crate::session::is_admin(me.role) => rsx! { div { class: "notice", role: "status", "This page is for administrators. You are signed in as {me.email} ({me.role.label()})." } },
        Access::Ready(_) => rsx! { {children} },
    }
}

#[component]
fn FleetSummary() -> Element {
    let live = use_context::<Live>();
    let sw = live.somework.read().clone();
    let data = live.fleet.read().clone();
    let listed = sw.as_ref().map(|work| work.events.agents.len());
    let answering = sw.as_ref().map(|work| work.events.agents.iter().filter(|agent| agent.reachable).count());
    let agents_text = match (answering, listed) {
        (Some(answering), Some(listed)) if listed > 0 => format!("{answering} / {listed}"),
        _ => "—".to_string(),
    };
    let handlers_on: usize = sw.as_ref().map(|work| work.events.agents.iter().map(|agent| agent.handlers.iter().filter(|handler| handler.enabled).count()).sum()).unwrap_or(0);
    let jobs_listed: usize = sw.as_ref().map(|work| work.events.agents.iter().map(|agent| agent.jobs.len()).sum()).unwrap_or(0);
    let vms: Vec<_> = data.as_ref().map(|data| data.machines.iter().filter(|machine| machine.kind == "qemu").collect()).unwrap_or_default();
    let running = vms.iter().filter(|machine| machine.status == "running").count();
    let cores: u64 = vms.iter().filter_map(|machine| machine.cores).sum();
    let cpu = if cores > 0 { Some(vms.iter().map(|machine| machine.cpu_percent.unwrap_or(0.0) * machine.cores.unwrap_or(0) as f64).sum::<f64>() / cores as f64) } else { None };
    let memory = if vms.is_empty() { None } else { Some(vms.iter().filter_map(|machine| machine.memory_bytes).sum()) };
    let notice = if *live.fleet_failed.read() { Some("Dashboard connection lost. Previous values are not current; retrying automatically.".to_string()) } else { data.as_ref().and_then(|data| data.error.clone()) };
    rsx! {
        if let Some(notice) = notice { div { class: "notice", role: "status", "{notice}" } }
        section { class: "summary", "aria-label": "Fleet summary",
            div { span { class: "metric-label", "AGENTS ANSWERING" }, strong { "{agents_text}" }, small { "{handlers_on} event handlers on · {jobs_listed} jobs recorded" } }
            div { span { class: "metric-label", "MACHINES RUNNING" }, strong { "{running} / {vms.len()}" }, small { "Virtual machines on Proxmox" } }
            div { span { class: "metric-label", "VM CPU LOAD" }, strong { "{format::number(cpu, 1)}%" }, small { "Weighted by assigned vCPUs" } }
            div { span { class: "metric-label", "VM MEMORY" }, strong { "{format::bytes(memory)}" }, small { "Hypervisor-reported usage" } }
        }
    }
}

#[component]
pub fn SomeWorkPage() -> Element {
    let live = use_context::<Live>();
    let now = *live.now.read();
    rsx! {
        h1 { class: "page-title", "SomeWork" }
        FleetSummary {}
        SomeWorkSection { data: live.somework.read().clone(), failed: *live.somework_failed.read(), now }
    }
}

#[component]
pub fn HistoryPage() -> Element {
    let live = use_context::<Live>();
    let now = *live.now.read();
    rsx! {
        h1 { class: "page-title", "Work history" }
        WorkHistory { data: live.somework.read().clone(), now }
    }
}

#[component]
pub fn UsagePage() -> Element {
    let live = use_context::<Live>();
    let now = *live.now.read();
    rsx! {
        h1 { class: "page-title", "Model usage" }
        UsagePanel { usage: live.somework.read().clone().and_then(|work| work.usage), now }
    }
}

#[component]
pub fn MachinesPage() -> Element {
    let live = use_context::<Live>();
    let data = live.fleet.read().clone();
    rsx! {
        h1 { class: "page-title", "Machines" }
        FleetSummary {}
        if let Some(data) = data {
            MachineTable { machines: data.machines.clone() }
            Platform { machines: data.machines, storage: data.storage }
        } else { section { class: "section", h2 { "Machines" }, p { "Waiting for the first hypervisor sample…" } } }
    }
}

#[component]
pub fn NotFound(segments: Vec<String>) -> Element {
    let path = segments.join("/");
    rsx! {
        h1 { class: "page-title", "Not found" }
        p { class: "empty", "There is no page at /{path}. " Link { to: Route::Agents {}, "Back to Agents" } }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::agent_page::AgentTab;

    #[test]
    fn every_route_belongs_to_one_rail_entry() {
        assert_eq!(section_of(&Route::Agents {}), Section::Agents);
        assert_eq!(section_of(&Route::AgentPage { slug: "qa".into(), tab: AgentTab::Setup }), Section::Agents, "an agent's page keeps Agents selected");
        assert_eq!(section_of(&Route::Catalog {}), Section::Catalog);
        assert_eq!(section_of(&Route::MachinesPage {}), Section::Machines);
        assert_eq!(section_of(&Route::NotFound { segments: vec!["x".into()] }), Section::Other);
    }

    #[test]
    fn the_sign_in_remembers_the_deep_link() {
        let route = Route::AgentPage { slug: "pi-agent".into(), tab: AgentTab::Revisions };
        assert_eq!(format!("/fleet{route}"), "/fleet/agents/pi-agent/revisions");
        assert_eq!(format!("/fleet{}", Route::Agents {}), "/fleet/");
    }
}
