//! The work history of each agent (from its own job journal) and the model usage and cost (from the central Prometheus).

use crate::format::{age, ago};
use dioxus::prelude::*;
use fleet_shared::somework::{AgentEvents, JobView, SomeWork, UsageAmount, UsageRow, UsageView};

/// Agents whose history people look at first, in this order; the others follow alphabetically.
const FIRST: [&str; 2] = ["agent/aikido-fixer", "agent/qa"];

/// Jobs listed before "show more".
const PAGE: usize = 50;

pub fn short_agent(id: &str) -> &str {
    id.strip_prefix("agent/").unwrap_or(id)
}

/// `$1.23`, `$0.04`, `<$0.01` for a sliver, `$0` for nothing.
pub fn money(value: f64) -> String {
    if value <= 0.0 {
        "$0".into()
    } else if value < 0.01 {
        "<$0.01".into()
    } else if value < 100.0 {
        format!("${value:.2}")
    } else {
        format!("${value:.0}")
    }
}

/// `950`, `12.3k`, `4.56M`.
pub fn compact(value: u64) -> String {
    match value {
        0..=999 => value.to_string(),
        1_000..=99_999 => format!("{:.1}k", value as f64 / 1_000.0),
        100_000..=999_999 => format!("{}k", value / 1_000),
        _ => format!("{:.2}M", value as f64 / 1_000_000.0),
    }
}

/// The outcome the job ended with, or the failure state when it has none.
pub fn outcome_of(job: &JobView) -> String {
    job.outcome.clone().unwrap_or_else(|| job.state.clone()).replace('_', " ")
}

/// A colour class for an outcome: `good` for work that landed, `bad` for work that failed or was refused, `neutral` for the rest.
pub fn outcome_class(job: &JobView) -> &'static str {
    let outcome = job.outcome.as_deref().unwrap_or("");
    if job.state == "failed" || matches!(outcome, "not_fixed" | "blocked" | "no_fix") {
        "bad"
    } else if matches!(outcome, "verified" | "pr_opened" | "followup_pushed" | "completed" | "done") {
        "good"
    } else {
        "neutral"
    }
}

/// How many jobs ended each way, most frequent first.
pub fn outcome_counts(jobs: &[JobView]) -> Vec<(String, usize)> {
    let mut counts: Vec<(String, usize)> = Vec::new();
    for job in jobs {
        let outcome = outcome_of(job);
        match counts.iter_mut().find(|(name, _)| *name == outcome) {
            Some((_, n)) => *n += 1,
            None => counts.push((outcome, 1)),
        }
    }
    counts.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    counts
}

pub fn totals(jobs: &[JobView]) -> (u64, u64, f64) {
    let input = jobs.iter().filter_map(|job| job.input_tokens).sum();
    let output = jobs.iter().filter_map(|job| job.output_tokens).sum();
    let cost = jobs.iter().filter_map(|job| job.cost_usd).sum();
    (input, output, cost)
}

fn agents_in_order(agents: &[AgentEvents]) -> Vec<AgentEvents> {
    let mut list: Vec<AgentEvents> = agents.to_vec();
    list.sort_by_key(|agent| (FIRST.iter().position(|first| *first == agent.id).unwrap_or(FIRST.len()), agent.id.clone()));
    list
}

#[component]
fn AgentTab(id: String, jobs: usize, active: bool, pick: EventHandler<String>) -> Element {
    let label = short_agent(&id).to_string();
    let class = if active { "tab selected" } else { "tab" };
    rsx! { button { class: "{class}", onclick: move |_| pick.call(id.clone()), "{label}", small { "{jobs}" } } }
}

#[component]
fn OutcomeChip(name: String, n: usize, active: bool, pick: EventHandler<String>) -> Element {
    let class = if active { "chip pick on" } else { "chip pick" };
    let value = name.clone();
    rsx! { button { class: "{class}", onclick: move |_| pick.call(value.clone()), "{name} · {n}" } }
}

#[component]
pub fn WorkHistory(data: Option<SomeWork>, now: i64) -> Element {
    let mut selected = use_signal(String::new);
    let mut outcome = use_signal(String::new);
    let mut limit = use_signal(|| PAGE);
    let Some(data) = data else {
        return rsx! { section { id: "history", class: "section", div { class: "section-heading", h2 { span { "02 /" }, "Work history" } }, p { class: "empty", "Waiting for the first SomeWork sample…" } } };
    };
    let agents = agents_in_order(&data.events.agents);
    if agents.is_empty() {
        return rsx! { section { id: "history", class: "section", div { class: "section-heading", h2 { span { "02 /" }, "Work history" } }, p { class: "empty", "No agent status endpoints are configured on this dashboard (agents-health.json)." } } };
    }
    let wanted = selected.read().clone();
    let current = agents.iter().find(|agent| agent.id == wanted).or_else(|| agents.first()).cloned().expect("at least one agent");
    let filter = outcome.read().clone();
    let counts = outcome_counts(&current.jobs);
    let filter_active = counts.iter().any(|(name, _)| *name == filter);
    let matching: Vec<JobView> = current.jobs.iter().filter(|job| !filter_active || outcome_of(job) == filter).cloned().collect();
    let hidden = matching.len().saturating_sub(limit());
    let shown: Vec<JobView> = matching.iter().take(limit()).cloned().collect();
    let matching_count = matching.len();
    let (input, output, cost) = totals(&current.jobs);
    let durations: Vec<f64> = current.jobs.iter().filter_map(|job| job.seconds).collect();
    let average = if durations.is_empty() { None } else { Some(durations.iter().sum::<f64>() / durations.len() as f64) };
    let since = current.jobs.last().and_then(|job| job.ended_at.clone());
    let since_text = ago(since.as_deref(), now);
    let reachable = current.reachable;
    let id = current.id.clone();
    rsx! {
        section { id: "history", class: "section",
            div { class: "section-heading", h2 { span { "02 /" }, "Work history" }, span { class: "section-note", "FROM EACH AGENT'S OWN JOB RECORD · REDACTED SUMMARIES" } }
            div { class: "tabs", role: "tablist",
                for agent in agents.iter() {
                    AgentTab { key: "{agent.id}", id: agent.id.clone(), jobs: agent.jobs.len(), active: agent.id == id, pick: move |picked: String| { selected.set(picked); outcome.set(String::new()); limit.set(PAGE); } }
                }
            }
            if !reachable { div { class: "notice", role: "status", "{id} did not answer: its jobs are not shown." } }
            div { class: "summary six", "aria-label": "Jobs of {id}",
                div { span { class: "metric-label", "JOBS RECORDED" }, strong { "{current.jobs.len()}" }, small { "oldest {since_text}" } }
                div { span { class: "metric-label", "AVERAGE DURATION" }, strong { "{age(average)}" }, small { "per job" } }
                div { span { class: "metric-label", "INPUT TOKENS" }, strong { "{compact(input)}" }, small { "in the recorded jobs" } }
                div { span { class: "metric-label", "OUTPUT TOKENS" }, strong { "{compact(output)}" }, small { "in the recorded jobs" } }
                div { span { class: "metric-label", "COST" }, strong { "{money(cost)}" }, small { "in the recorded jobs" } }
                div { span { class: "metric-label", "MATCHING" }, strong { "{matching_count}" }, small { if filter_active { "outcome: {filter}" } else { "all outcomes" } } }
            }
            div { class: "chips pickers",
                for (name , n) in counts.iter() {
                    OutcomeChip { key: "{name}", name: name.clone(), n: *n, active: filter_active && *name == filter, pick: move |picked: String| { limit.set(PAGE); if *outcome.read() == picked { outcome.set(String::new()) } else { outcome.set(picked) } } }
                }
            }
            div { class: "machine-table history", table {
                caption { "Newest first · click a job for its details · only what the agent's job record holds, not the task input" }
                thead { tr { th { "Ended" }, th { "About" }, th { "Outcome" }, th { "Duration" }, th { "Tokens in / out" }, th { "Cost" } } }
                tbody {
                    if shown.is_empty() { tr { td { colspan: "6", class: "empty", "No jobs recorded for this agent yet." } } }
                    for job in shown { JobRows { key: "{job.task}{job.ended_at:?}", job, now } }
                }
            } }
            if hidden > 0 { p { class: "more", button { class: "tab", onclick: move |_| limit.set(limit() + PAGE), "Show {hidden.min(PAGE)} more · {hidden} not shown" } } }
            p { class: "footnote", "The job record keeps the latest 500 jobs per agent and starts with the jobs this version records; older work is in the logs. Jobs from the domain and from chat instructions are both listed." }
        }
    }
}

#[component]
fn JobRows(job: JobView, now: i64) -> Element {
    let mut open = use_signal(|| false);
    let ended = ago(job.ended_at.as_deref(), now);
    let about = job.subject.clone().unwrap_or_else(|| "—".into());
    let class = outcome_class(&job);
    let label = outcome_of(&job);
    let tokens = match (job.input_tokens, job.output_tokens) {
        (Some(input), Some(output)) => format!("{} / {}", compact(input), compact(output)),
        _ => job.tokens.map(|total| format!("{} total", compact(total))).unwrap_or_else(|| "—".into()),
    };
    let cost = job.cost_usd.map(money).unwrap_or_else(|| "—".into());
    let checks = match (job.checks_passed, job.checks_failed) {
        (Some(passed), Some(failed)) => Some(format!("{passed} passed · {failed} failed")),
        _ => None,
    };
    let marker = if open() { "▾" } else { "▸" };
    let kind = if job.source == "chat" { format!("{} · chat", job.capability) } else { job.capability.clone() };
    rsx! {
        tr { class: "job", onclick: move |_| open.set(!open()),
            td { span { class: "numeric", "{marker} {ended}" } }
            td { b { "{about}" }, small { "{kind}" } }
            td { span { class: "chip {class}", "{label}" }, if let Some(text) = checks.clone() { small { "{text}" } } }
            td { span { class: "numeric", "{age(job.seconds)}" } }
            td { span { class: "numeric", "{tokens}" } }
            td { span { class: "numeric", "{cost}" } }
        }
        if open() {
            tr { class: "job-detail",
                td { colspan: "6",
                    dl {
                        dt { "Task" } dd { "{job.task}" }
                        if let Some(start) = job.started_at.clone() { dt { "Started" } dd { "{start}" } }
                        if let Some(end) = job.ended_at.clone() { dt { "Ended" } dd { "{end}" } }
                        dt { "State" } dd { "{job.state}", if let Some(raw) = job.outcome.clone() { small { " · outcome {raw}" } } }
                        if let Some(text) = checks { dt { "Acceptance checks" } dd { "{text}" } }
                        if let Some(url) = job.pr_url.clone() { dt { "Pull request" } dd { a { href: "{url}", target: "_blank", rel: "noopener noreferrer", "{url}" } } }
                        if let Some(branch) = job.branch.clone() { dt { "Branch" } dd { "{branch}" } }
                        if let Some(total) = job.tokens { dt { "Tokens" } dd { "{total} total", small { " · {job.input_tokens.unwrap_or(0)} in · {job.output_tokens.unwrap_or(0)} out" } } }
                    }
                    if let Some(summary) = job.summary.clone() { pre { class: "summary-text", "{summary}" } } else { p { small { "The agent recorded no summary for this job." } } }
                }
            }
        }
    }
}

// ---------------------------------------------------------------- model usage

fn tokens_text(amount: &UsageAmount) -> String {
    format!("{} in · {} out", compact(amount.input), compact(amount.output))
}

fn sum(rows: &[UsageRow], pick: impl Fn(&UsageRow) -> &UsageAmount) -> UsageAmount {
    rows.iter().fold(UsageAmount::default(), |mut total, row| {
        let amount = pick(row);
        total.input += amount.input;
        total.output += amount.output;
        total.cache_read += amount.cache_read;
        total.cache_write += amount.cache_write;
        total.cost_usd += amount.cost_usd;
        total
    })
}

#[component]
pub fn UsagePanel(usage: Option<UsageView>, now: i64) -> Element {
    let Some(view) = usage else {
        return rsx! { section { id: "usage", class: "section", div { class: "section-heading", h2 { span { "03 /" }, "Model usage and cost" } }, p { class: "empty", "Not available: the metrics source is not configured on this dashboard or did not answer." } } };
    };
    let day = sum(&view.rows, |row| &row.day);
    let week = sum(&view.rows, |row| &row.week);
    let month = sum(&view.rows, |row| &row.month);
    let sampled = ago(view.observed_at.as_deref(), now);
    rsx! {
        section { id: "usage", class: "section",
            div { class: "section-heading", h2 { span { "03 /" }, "Model usage and cost" }, span { class: "section-note", "PROMETHEUS · PER AGENT, PROVIDER AND MODEL · SAMPLE {sampled}" } }
            div { class: "summary six", "aria-label": "Usage totals",
                div { span { class: "metric-label", "COST, 24 H" }, strong { "{money(day.cost_usd)}" }, small { "{tokens_text(&day)}" } }
                div { span { class: "metric-label", "COST, 7 D" }, strong { "{money(week.cost_usd)}" }, small { "{tokens_text(&week)}" } }
                div { span { class: "metric-label", "COST, 30 D" }, strong { "{money(month.cost_usd)}" }, small { "{tokens_text(&month)}" } }
                div { span { class: "metric-label", "CACHE READS, 7 D" }, strong { "{compact(week.cache_read)}" }, small { "{compact(week.cache_write)} written" } }
                div { span { class: "metric-label", "AGENTS WITH SPEND" }, strong { "{view.rows.iter().map(|row| row.agent.as_str()).collect::<std::collections::BTreeSet<_>>().len()}" }, small { "in the last 30 days" } }
                div { span { class: "metric-label", "MODELS" }, strong { "{view.rows.iter().map(|row| (row.provider.as_str(), row.model.as_str())).collect::<std::collections::BTreeSet<_>>().len()}" }, small { "in use" } }
            }
            div { class: "machine-table", table {
                caption { "Increase of the agents' usage counters · most expensive over 30 days first · counters restart with an agent, increases account for that" }
                thead { tr { th { "Agent" }, th { "Provider / model" }, th { "24 hours" }, th { "7 days" }, th { "30 days" } } }
                tbody {
                    if view.rows.is_empty() { tr { td { colspan: "5", class: "empty", "No usage recorded yet." } } }
                    for row in view.rows.clone() { UsageLine { key: "{row.agent}{row.provider}{row.model}", row } }
                }
            } }
        }
    }
}

#[component]
fn UsageLine(row: UsageRow) -> Element {
    rsx! {
        tr {
            td { div { class: "machine-name", "{short_agent(&row.agent)}" } }
            td { "{row.provider}", small { "{row.model}" } }
            td { span { class: "numeric", "{money(row.day.cost_usd)}" }, small { "{tokens_text(&row.day)}" } }
            td { span { class: "numeric", "{money(row.week.cost_usd)}" }, small { "{tokens_text(&row.week)}" } }
            td { span { class: "numeric", "{money(row.month.cost_usd)}" }, small { "{tokens_text(&row.month)}" } }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(outcome: Option<&str>, state: &str) -> JobView {
        JobView { task: "t".into(), capability: "c@1".into(), source: "task".into(), state: state.into(), outcome: outcome.map(Into::into), ..Default::default() }
    }

    #[test]
    fn money_and_counts_read_at_a_glance() {
        assert_eq!((money(0.0), money(0.004), money(0.5), money(12.345), money(250.4)), ("$0".into(), "<$0.01".into(), "$0.50".into(), "$12.35".into(), "$250".into()));
        assert_eq!((compact(950), compact(12_345), compact(456_000), compact(4_560_000)), ("950".into(), "12.3k".into(), "456k".into(), "4.56M".into()));
    }

    #[test]
    fn outcomes_are_grouped_and_coloured() {
        let jobs = vec![job(Some("verified"), "completed"), job(Some("not_fixed"), "completed"), job(Some("verified"), "completed"), job(None, "failed"), job(Some("skipped"), "completed")];
        assert_eq!(outcome_counts(&jobs), vec![("verified".to_string(), 2), ("failed".to_string(), 1), ("not fixed".to_string(), 1), ("skipped".to_string(), 1)]);
        let class: Vec<_> = jobs.iter().map(outcome_class).collect();
        assert_eq!(class, ["good", "bad", "good", "bad", "neutral"]);
    }

    #[test]
    fn the_agents_people_ask_about_come_first() {
        let agent = |id: &str| AgentEvents { id: id.into(), ..Default::default() };
        let ordered: Vec<_> = agents_in_order(&[agent("agent/reviewer"), agent("agent/qa"), agent("agent/pi-agent"), agent("agent/aikido-fixer")]).into_iter().map(|a| a.id).collect();
        assert_eq!(ordered, ["agent/aikido-fixer", "agent/qa", "agent/pi-agent", "agent/reviewer"]);
        assert_eq!(short_agent("agent/qa"), "qa");
    }

    #[test]
    fn totals_add_what_the_jobs_recorded() {
        let mut a = job(None, "completed");
        a.input_tokens = Some(10);
        a.output_tokens = Some(5);
        a.cost_usd = Some(0.5);
        let mut b = job(None, "completed");
        b.cost_usd = Some(0.25);
        assert_eq!(totals(&[a, b]), (10, 5, 0.75));
    }

    #[test]
    fn usage_sums_per_period() {
        let row = |day: f64, week: f64| UsageRow { day: UsageAmount { cost_usd: day, input: 1, ..Default::default() }, week: UsageAmount { cost_usd: week, ..Default::default() }, ..Default::default() };
        let rows = vec![row(1.0, 2.0), row(0.5, 0.5)];
        assert_eq!(sum(&rows, |r| &r.day).cost_usd, 1.5);
        assert_eq!(sum(&rows, |r| &r.day).input, 2);
        assert_eq!(sum(&rows, |r| &r.week).cost_usd, 2.5);
    }
}
