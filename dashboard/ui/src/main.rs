mod components;
mod format;
mod history;
mod somework;

use components::{MachineTable, Platform};
use history::{UsagePanel, WorkHistory};
use somework::SomeWorkSection;
use dioxus::prelude::*;
use fleet_shared::{Fleet, somework::SomeWork, timestamp_ms};
use gloo_timers::future::TimeoutFuture;

fn main() {
    dioxus::launch(App);
}

async fn fetch(
    mut latest: Signal<Option<Fleet>>,
    mut failed: Signal<bool>,
    mut loading: Signal<bool>,
) {
    loading.set(true);
    let result = async {
        let response = gloo_net::http::Request::get("/fleet/api/fleet")
            .send()
            .await
            .map_err(|_| ())?;
        if !response.ok() {
            return Err(());
        }
        response.json::<Fleet>().await.map_err(|_| ())
    }
    .await;
    match result {
        Ok(data) => {
            latest.set(Some(data));
            failed.set(false);
        }
        Err(()) => failed.set(true),
    }
    loading.set(false);
}

async fn fetch_somework(mut latest: Signal<Option<SomeWork>>, mut failed: Signal<bool>) {
    let result = async {
        let response = gloo_net::http::Request::get("/fleet/api/somework").send().await.map_err(|_| ())?;
        if !response.ok() {
            return Err(());
        }
        response.json::<SomeWork>().await.map_err(|_| ())
    }
    .await;
    match result {
        Ok(data) => {
            latest.set(Some(data));
            failed.set(false);
        }
        Err(()) => failed.set(true),
    }
}

async fn refresh(fleet: Signal<Option<Fleet>>, fleet_failed: Signal<bool>, loading: Signal<bool>, somework: Signal<Option<SomeWork>>, somework_failed: Signal<bool>) {
    fetch_somework(somework, somework_failed).await;
    fetch(fleet, fleet_failed, loading).await;
}

#[component]
fn App() -> Element {
    let latest = use_signal(|| None::<Fleet>);
    let failed = use_signal(|| false);
    let loading = use_signal(|| false);
    let somework = use_signal(|| None::<SomeWork>);
    let somework_failed = use_signal(|| false);
    let mut now = use_signal(|| js_sys::Date::now() as i64);
    use_future(move || async move {
        loop {
            refresh(latest, failed, loading, somework, somework_failed).await;
            TimeoutFuture::new(15000).await;
        }
    });
    use_future(move || async move {
        loop {
            TimeoutFuture::new(1000).await;
            now.set(js_sys::Date::now() as i64);
        }
    });
    let data = latest.read().clone();
    let time = *now.read();
    let connected = !failed()
        && data.as_ref().is_some_and(|data| {
            data.error.is_none()
                && data
                    .observed_at
                    .as_deref()
                    .and_then(timestamp_ms)
                    .is_some_and(|sample| time - sample <= 60_000)
        });
    let clock = js_sys::Date::new_0()
        .to_locale_time_string("en-GB")
        .as_string()
        .unwrap_or_default();
    let notice = if failed() {
        Some(
            "Dashboard connection lost. Previous values are not current; retrying automatically."
                .to_string(),
        )
    } else {
        data.as_ref().and_then(|data| data.error.clone())
    };
    let vms: Vec<_> = data
        .as_ref()
        .map(|data| {
            data.machines
                .iter()
                .filter(|machine| machine.kind == "qemu")
                .collect()
        })
        .unwrap_or_default();
    let sw = somework.read().clone();
    let listed = sw.as_ref().map(|work| work.events.agents.len());
    let answering = sw.as_ref().map(|work| work.events.agents.iter().filter(|agent| agent.reachable).count());
    let agents_text = match (answering, listed) {
        (Some(answering), Some(listed)) if listed > 0 => format!("{answering} / {listed}"),
        _ => "—".to_string(),
    };
    let handlers_on: usize = sw.as_ref().map(|work| work.events.agents.iter().map(|agent| agent.handlers.iter().filter(|handler| handler.enabled).count()).sum()).unwrap_or(0);
    let jobs_listed: usize = sw.as_ref().map(|work| work.events.agents.iter().map(|agent| agent.jobs.len()).sum()).unwrap_or(0);
    let running = vms
        .iter()
        .filter(|machine| machine.status == "running")
        .count();
    let cores: u64 = vms.iter().filter_map(|machine| machine.cores).sum();
    let cpu = if cores > 0 {
        Some(
            vms.iter()
                .map(|machine| {
                    machine.cpu_percent.unwrap_or(0.0) * machine.cores.unwrap_or(0) as f64
                })
                .sum::<f64>()
                / cores as f64,
        )
    } else {
        None
    };
    let memory = if vms.is_empty() {
        None
    } else {
        Some(vms.iter().filter_map(|machine| machine.memory_bytes).sum())
    };
    let sampled = format::ago(
        data.as_ref().and_then(|data| data.observed_at.as_deref()),
        time,
    );
    rsx! {
        a { class: "skip", href: "#content", "Skip to dashboard" }
        aside { class: "rail",
            a { class: "brand", href: "/fleet/", "aria-label": "Fleet home", "F", span { "／" } }
            div { class: "rail-caption", "AGENT CLUSTER" }
            nav { "aria-label": "Dashboard navigation",
                a { class: "selected", href: "#somework", span { "01" }, "SomeWork" }
                a { href: "#history", span { "02" }, "Work history" }
                a { href: "#usage", span { "03" }, "Model usage" }
                a { href: "#machines", span { "04" }, "Machines" }
                a { href: "#platform", span { "05" }, "Platform" }
                a { href: "/d/agent-cluster-logs", span { "↗" }, "Grafana logs" }
            }
            div { class: "rail-bottom", span { class: "lock", "◆" }, "PRIVATE NETWORK", br {}, small { "Read-only · Rust + Dioxus" } }
        }
        main { id: "content",
            header {
                div { class: "eyebrow", "OPERATIONS / LIVE OVERVIEW" }
                div { class: "sync", span { class: if connected { "dot" } else { "dot pending" } }, span { if connected { "Live" } else { "Sample delayed" } },
                    button { id: "refresh", "aria-label": "Refresh dashboard", disabled: loading(), onclick: move |_| { spawn(refresh(latest, failed, loading, somework, somework_failed)); }, "↻" }
                }
            }
            section { class: "intro", div { h1 { "Your fleet.", br {}, em { "In focus." } }, p { "Agents at work. Machines behind them.", br {}, "One place to keep a pulse on the cluster." } }, div { class: "intro-note", span { class: "coordinate", "59° N / OPERATIONS" }, span { "{clock}" }, span { class: "coordinate", "LIVE · 15 SECOND REFRESH" } } }
            if let Some(notice) = notice { div { class: "notice", role: "status", "{notice}" } }
            section { class: "summary", "aria-label": "Fleet summary",
                div { span { class: "metric-label", "AGENTS ANSWERING" }, strong { "{agents_text}" }, small { "{handlers_on} event handlers on · {jobs_listed} jobs recorded" } }
                div { span { class: "metric-label", "MACHINES RUNNING" }, strong { "{running} / {vms.len()}" }, small { "Virtual machines on Proxmox" } }
                div { span { class: "metric-label", "VM CPU LOAD" }, strong { "{format::number(cpu, 1)}%" }, small { "Weighted by assigned vCPUs" } }
                div { span { class: "metric-label", "VM MEMORY" }, strong { "{format::bytes(memory)}" }, small { "Hypervisor-reported usage" } }
            }
            SomeWorkSection { data: sw.clone(), failed: somework_failed(), now: time }
            WorkHistory { data: sw.clone(), now: time }
            UsagePanel { usage: sw.and_then(|work| work.usage), now: time }
            if let Some(data) = data {
                MachineTable { machines: data.machines.clone() }
                Platform { machines: data.machines, storage: data.storage }
            } else { section { class: "section", h2 { "Machines" }, p { "Waiting for the first hypervisor sample…" } } }
            footer { span { "FLEET / AGENT CLUSTER" }, span { "Rust + Dioxus · No control-plane actions or conversation content." }, span { "Hypervisor sample {sampled}" } }
        }
    }
}
