use crate::format::{ago, bytes, duration, number, text};
use dioxus::prelude::*;
use fleet_shared::{Agent, Machine, Sample, Storage};

#[component]
pub fn Status(value: String) -> Element {
    let online = matches!(value.as_str(), "running" | "online" | "working" | "idle" | "alive" | "ready" | "intact" | "succeeded" | "active");
    rsx! { span { class: "status {value}", span { class: if online { "dot" } else { "dot pending" } }, "{value}" } }
}

#[component]
fn Meter(value: Option<f64>) -> Element {
    let value = value.unwrap_or(0.0).clamp(0.0, 100.0);
    let count = (value / 5.0).round() as usize;
    rsx! { div { class: if value > 80.0 { "meter warn" } else { "meter" }, role: "meter", "aria-label": "Usage", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "{value:.0}", for i in 0..20 { i { class: if i < count { "on" } else { "" } } } } }
}

#[component]
pub fn AgentCard(agent: Agent, now: i64) -> Element {
    let state = agent.heartbeat.state.label();
    let model = text(&agent.heartbeat.model);
    let thinking = text(&agent.heartbeat.thinking);
    let observed = ago(Some(&agent.heartbeat.observed_at), now);
    let last_activity = ago(agent.heartbeat.last_activity_at.as_deref(), now);
    let link = agent
        .heartbeat
        .session_id
        .as_ref()
        .map(|id| {
            format!(
                "/d/agent-cluster-pi?var-session={}",
                urlencoding::encode(id)
            )
        })
        .unwrap_or_else(|| "/d/agent-cluster-pi".into());
    let messages = agent
        .heartbeat
        .messages
        .map(|count| count.to_string())
        .unwrap_or_else(|| "—".into());
    let tokens = agent
        .heartbeat
        .tokens
        .map(|count| count.to_string())
        .unwrap_or_else(|| "—".into());
    rsx! {
        article { class: "agent-card",
            div { class: "agent-main",
                div { class: "agent-icon", "aria-hidden": "true", "π" }
                div { h3 { "Pi ", span { class: "description", "/ {agent.heartbeat.id}" } }, p { class: "description", "{agent.host} · VM {agent.vm_id}" }, Status { value: state.to_string() }, p { class: "heartbeat", "Heartbeat {observed}", if agent.stale { " · state is not current" } }, a { class: "agent-link", href: link, "View conversation ↗" } }
            }
            div { class: "agent-specs",
                div { span { class: "metric-label", "MODEL / THINKING" }, b { "{model} / {thinking}" } }
                div { span { class: "metric-label", "WORKSPACE / CHANNEL" }, b { "{agent.workspace} · Telegram" } }
                div { span { class: "metric-label", "BROWSER" }, b { "{agent.browser}" } }
            }
            div { class: "agent-specs",
                div { class: "split", div { span { class: "metric-label", "CONTAINER CPU" }, b { "{number(agent.heartbeat.cpu_percent, 1)}%" } }, div { span { class: "metric-label", "MEMORY" }, b { "{bytes(agent.heartbeat.memory_bytes)} / {bytes(agent.heartbeat.memory_limit)}" } } }
                div { span { class: "metric-label", "SESSION ACTIVITY" }, b { "{messages} messages · {tokens} tokens" } }
                div { span { class: "metric-label", "LAST ACTIVITY" }, b { "{last_activity}" } }
            }
        }
    }
}

#[component]
fn Spark(history: Vec<Sample>) -> Element {
    let values: Vec<_> = history
        .iter()
        .filter_map(|sample| sample.cpu_percent)
        .collect();
    if values.len() < 2 {
        return rsx! { small { "Collecting history" } };
    }
    let max = values.iter().copied().fold(5.0_f64, f64::max);
    let points = values
        .iter()
        .enumerate()
        .map(|(i, value)| {
            format!(
                "{:.1},{:.1}",
                i as f64 / (values.len() - 1) as f64 * 82.0,
                24.0 - value / max * 22.0
            )
        })
        .collect::<Vec<_>>()
        .join(" ");
    rsx! { svg { class: "spark", view_box: "0 0 82 25", role: "img", "aria-label": "CPU usage over the last hour", line { x1: "0", y1: "24", x2: "82", y2: "24" }, polyline { points } } }
}

#[component]
fn MachineRow(machine: Machine) -> Element {
    rsx! {
        tr {
            td { div { class: "machine-name", span { class: "vm-id", "{machine.vm_id.unwrap_or(0)}" }, "{machine.name}" }, small { "{machine.role} · {machine.cores.unwrap_or(0)} vCPU" } }
            td { Status { value: machine.status } }
            td { div { class: "cpu-cell", span { class: "numeric", "{number(machine.cpu_percent, 1)}%" }, Spark { history: machine.history } } }
            td { span { class: "numeric", "{bytes(machine.memory_bytes)}", small { "/ {bytes(machine.memory_limit)} · {number(machine.memory_percent, 0)}%" } }, Meter { value: machine.memory_percent } }
            td { class: "numeric", "{bytes(machine.network_in)}/s", small { "↗ {bytes(machine.network_out)}/s" } }
            td { class: "numeric", "{bytes(machine.disk_provisioned)}", small { "{duration(machine.uptime_seconds)} up" } }
        }
    }
}

#[component]
pub fn MachineTable(machines: Vec<Machine>) -> Element {
    let mut search = use_signal(String::new);
    let query = search.read().trim().to_lowercase();
    let machines: Vec<_> = machines
        .into_iter()
        .filter(|machine| {
            machine.kind == "qemu"
                && format!(
                    "{} {} {}",
                    machine.vm_id.unwrap_or(0),
                    machine.name,
                    machine.role
                )
                .to_lowercase()
                .contains(&query)
        })
        .collect();
    rsx! {
        section { id: "machines", class: "section",
            div { class: "section-heading", h2 { span { "03 /" }, "Machines" }, label { class: "search", span { "⌕" }, input { r#type: "search", value: "{search}", placeholder: "Find a machine…", "aria-label": "Find a machine", oninput: move |event| search.set(event.value()) } } }
            div { class: "machine-table", table {
                caption { "Virtual machines · CPU and RAM sampled by Proxmox; primary disk shows provisioned capacity" }
                thead { tr { th { "Machine / role" }, th { "State" }, th { "CPU / last hour" }, th { "Memory" }, th { "Network ↙ / ↗" }, th { "Disk / uptime" } } }
                tbody {
                    if machines.is_empty() { tr { td { colspan: "6", class: "empty", if query.is_empty() { "No hypervisor samples available yet." } else { "No machines match your search." } } } }
                    for machine in machines { MachineRow { key: "{machine.id}", machine } }
                }
            } }
            p { class: "footnote", "VM memory is measured by the hypervisor and may include guest cache. Primary disk capacity is provisioned space, not filesystem usage. Charts: Proxmox’s last-hour samples." }
        }
    }
}

#[component]
pub fn Platform(machines: Vec<Machine>, storage: Vec<Storage>) -> Element {
    let host = machines.into_iter().find(|machine| machine.kind == "node");
    rsx! {
        section { id: "platform", class: "section",
            div { class: "section-heading", h2 { span { "04 /" }, "Platform" }, span { class: "section-note", "THE FOUNDATION" } }
            div { class: "platform-grid",
                div { class: "platform-card",
                    if let Some(host) = host {
                        h3 { "{host.name}" }
                        div { class: "platform-row", span { "Proxmox VE" }, Status { value: host.status } }
                        div { class: "platform-row", span { "CPU · {host.cores.unwrap_or(0)} threads" }, b { "{number(host.cpu_percent, 1)}%" } }
                        Meter { value: host.cpu_percent }
                        div { class: "platform-row", span { "RAM including cache" }, b { "{bytes(host.memory_bytes)}" } }
                        div { class: "platform-row", small { "of {bytes(host.memory_limit)} physical" }, small { "{duration(host.uptime_seconds)} uptime" } }
                    } else { h3 { "Hypervisor" }, p { "Waiting for a sample." } }
                }
                div { class: "platform-card", h3 { "Storage pools" },
                    for pool in storage {
                        StoragePool { key: "{pool.name}", pool }
                    }
                }
                div { class: "platform-card links", span { class: "metric-label", "GO DEEPER" }, a { href: "/d/agent-cluster-pi", "Pi conversations", span { "↗" } }, a { href: "/d/agent-cluster-logs", "Cluster logs", span { "↗" } }, p { "Detailed, redacted conversations and searchable logs stay in Grafana." } }
            }
        }
    }
}

#[component]
fn StoragePool(pool: Storage) -> Element {
    let percent = pool
        .used
        .zip(pool.total)
        .filter(|(_, total)| *total > 0.0)
        .map(|(used, total)| used / total * 100.0);
    rsx! { div { class: "platform-row", span { "{pool.name}" }, b { "{number(percent, 0)}%" } }, Meter { value: percent }, div { class: "platform-row", small { "{bytes(pool.used)} used" }, small { "{bytes(pool.total)} total" } } }
}
