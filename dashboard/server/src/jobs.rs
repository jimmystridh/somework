//! The jobs of the agents as their events tell them. An agent publishes `agent.<slug>.job.started`, `.waiting` and `.finished` for every job; the
//! dashboard reads them from the domain's admin event log and reduces them to what is running, what waits for what, and how finished jobs ended.
//!
//! Same rule as the rest of the SomeWork view: values are picked by name and pass through `identifier` or a length-limited text reader. The only free
//! wording is what the agent says about its own job (label, what it waits for, the summary of how it ended); it is shown as plain text.

use crate::somework::{HOUR_MS, iso, identifier, short, time_ms};
use fleet_shared::somework::{HourBucket, LiveJob, SwAgent, Work};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};

const MAX_JOBS: usize = 2000;
const RECENT: usize = 30;
const LABEL_CHARS: usize = 120;
const WAITING_FOR_CHARS: usize = 200;
const SUMMARY_CHARS: usize = 300;

fn text(value: Option<&Value>, max: usize) -> Option<String> {
    let raw = value?.as_str()?;
    let cleaned: String = raw.chars().map(|c| if c.is_control() { ' ' } else { c }).take(max).collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    (!cleaned.is_empty()).then_some(cleaned)
}

/// `agent:agent/x` -> `agent/x`.
fn principal(value: Option<&Value>) -> Option<String> {
    let id = identifier(value)?;
    Some(id.strip_prefix("agent:").map(str::to_string).unwrap_or(id))
}

#[derive(Clone, Debug, Default)]
struct Job {
    agent: String,
    label: String,
    capability: Option<String>,
    requested_by: Option<String>,
    state: &'static str,
    waiting_for: Option<String>,
    first_at: i64,
    updated_at: i64,
    waiting_at: Option<i64>,
    started_at: Option<i64>,
    finished_at: Option<i64>,
    result: Option<&'static str>,
    summary: Option<String>,
}

/// What the job events have said, reduced to lifecycle facts per job.
#[derive(Default)]
pub struct JobBook {
    jobs: HashMap<String, Job>,
    first_event_ms: Option<i64>,
}

impl JobBook {
    pub fn apply_event(&mut self, event: &Value) {
        let topic = event.get("type").and_then(Value::as_str).unwrap_or_default();
        let parts: Vec<&str> = topic.split('.').collect();
        let ["agent", slug, "job", state] = parts[..] else { return };
        let state = match state {
            "started" => "running",
            "waiting" => "waiting",
            "finished" => "finished",
            _ => return,
        };
        let payload = event.get("payload");
        let data = payload.and_then(|p| p.get("data"));
        let field = |name: &str| data.and_then(|d| d.get(name));
        let Some(id) = identifier(field("jobId")) else { return };
        let Some(at) = time_ms(event.get("createdAt")) else { return };
        self.first_event_ms = Some(self.first_event_ms.map_or(at, |first| first.min(at)));
        let agent = principal(payload.and_then(|p| p.get("publishedBy"))).unwrap_or_else(|| format!("agent/{slug}"));
        let job = self.jobs.entry(id).or_insert_with(|| Job { agent, first_at: at, state: "waiting", ..Default::default() });
        if job.state == "finished" {
            return;
        }
        if let Some(label) = text(field("label"), LABEL_CHARS) {
            job.label = label;
        }
        job.capability = identifier(field("capability")).or(job.capability.take());
        job.requested_by = principal(field("requestedBy")).or(job.requested_by.take());
        job.updated_at = job.updated_at.max(at);
        job.state = state;
        match state {
            "waiting" => {
                job.waiting_at.get_or_insert(at);
                job.waiting_for = text(field("waitingFor"), WAITING_FOR_CHARS);
            }
            "running" => {
                job.started_at = Some(at);
                job.waiting_for = None;
            }
            _ => {
                job.finished_at = Some(at);
                job.waiting_for = None;
                job.result = match field("result").and_then(Value::as_str) {
                    Some("completed") => Some("completed"),
                    Some("failed") => Some("failed"),
                    Some("cancelled") => Some("cancelled"),
                    _ => Some("completed"),
                };
                job.summary = text(field("summary"), SUMMARY_CHARS);
            }
        }
        if self.jobs.len() > MAX_JOBS {
            self.prune(at);
        }
    }

    fn prune(&mut self, now_ms: i64) {
        let cutoff = now_ms - 48 * HOUR_MS;
        self.jobs.retain(|_, job| job.finished_at.is_none() || job.updated_at >= cutoff);
        if self.jobs.len() > MAX_JOBS {
            let mut by_age: Vec<_> = self.jobs.iter().filter(|(_, job)| job.finished_at.is_some()).map(|(id, job)| (job.updated_at, id.clone())).collect();
            by_age.sort();
            for (_, id) in by_age.into_iter().take(self.jobs.len() - MAX_JOBS) {
                self.jobs.remove(&id);
            }
        }
    }

    fn view(id: &str, job: &Job) -> LiveJob {
        let since = match job.state {
            "waiting" => job.waiting_at,
            "running" => job.started_at,
            _ => job.finished_at,
        };
        LiveJob {
            id: short(id),
            agent: job.agent.clone(),
            label: if job.label.is_empty() { short(id) } else { job.label.clone() },
            capability: job.capability.clone(),
            requested_by: job.requested_by.clone(),
            state: job.state.into(),
            waiting_for: job.waiting_for.clone(),
            since: since.and_then(iso),
            started_at: job.started_at.and_then(iso),
            finished_at: job.finished_at.and_then(iso),
            seconds: job.finished_at.zip(job.started_at).map(|(done, start)| (done - start).max(0) as f64 / 1000.0),
            result: job.result.map(str::to_string),
            summary: job.summary.clone(),
        }
    }

    pub fn work(&self, now_ms: i64) -> Work {
        let day_ago = now_ms - 24 * HOUR_MS;
        let mut active: Vec<(&String, &Job)> = self.jobs.iter().filter(|(_, job)| job.state != "finished").collect();
        active.sort_by(|a, b| a.1.first_at.cmp(&b.1.first_at).then_with(|| a.0.cmp(b.0)));
        let mut finished: Vec<(&String, &Job)> = self.jobs.iter().filter(|(_, job)| job.state == "finished").collect();
        finished.sort_by(|a, b| b.1.finished_at.cmp(&a.1.finished_at).then_with(|| a.0.cmp(b.0)));

        let this_hour = now_ms - now_ms.rem_euclid(HOUR_MS);
        let mut throughput: Vec<HourBucket> = (0..24).map(|i| HourBucket { hour_start: iso(this_hour - (23 - i) * HOUR_MS).unwrap_or_default(), ..Default::default() }).collect();
        let bucket = |at: i64| -> Option<usize> {
            let index = (at - (this_hour - 23 * HOUR_MS)).div_euclid(HOUR_MS);
            (0..24).contains(&index).then_some(index as usize)
        };
        let (mut completed, mut failed, mut cancelled) = (0, 0, 0);
        for job in self.jobs.values() {
            if let Some(index) = job.started_at.and_then(bucket) {
                throughput[index].started += 1;
            }
            let Some(done) = job.finished_at else { continue };
            if done >= day_ago {
                match job.result {
                    Some("failed") => failed += 1,
                    Some("cancelled") => cancelled += 1,
                    _ => completed += 1,
                }
            }
            if let Some(index) = bucket(done) {
                match job.result {
                    Some("failed") => throughput[index].failed += 1,
                    Some("cancelled") => {}
                    _ => throughput[index].completed += 1,
                }
            }
        }
        Work {
            active: active.into_iter().map(|(id, job)| Self::view(id, job)).collect(),
            finished: finished.into_iter().take(RECENT).map(|(id, job)| Self::view(id, job)).collect(),
            completed_24h: completed,
            failed_24h: failed,
            cancelled_24h: cancelled,
            throughput,
            history_from: self.first_event_ms.and_then(iso),
        }
    }

    /// Sets the job figures of each agent: how many run, how many wait, and what the waiting ones wait for.
    pub fn annotate(&self, agents: &mut Vec<SwAgent>) {
        for job in self.jobs.values().filter(|job| job.state != "finished") {
            let position = agents.iter().position(|agent| agent.id == job.agent).unwrap_or_else(|| {
                agents.push(SwAgent { id: job.agent.clone(), role: "requester".into(), ..Default::default() });
                agents.len() - 1
            });
            let agent = &mut agents[position];
            match job.state {
                "running" => agent.running_jobs += 1,
                _ => {
                    agent.waiting_jobs += 1;
                    if let Some(reason) = &job.waiting_for {
                        agent.blocked_on.push(reason.clone());
                    }
                }
            }
        }
        for agent in agents.iter_mut() {
            let unique: BTreeSet<String> = agent.blocked_on.drain(..).collect();
            agent.blocked_on = unique.into_iter().collect();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_790_000_000_000;

    fn at(seconds_ago: i64) -> String {
        iso(NOW - seconds_ago * 1000).unwrap()
    }

    fn event(state: &str, slug: &str, job: &str, seconds_ago: i64, data: Value) -> Value {
        let mut body = json!({"jobId": job, "label": format!("verify {job}"), "capability": "qa.verify@1", "requestedBy": "agent/manager"});
        if let (Some(target), Some(extra)) = (body.as_object_mut(), data.as_object()) {
            target.extend(extra.clone());
        }
        json!({"seq": 1, "type": format!("agent.{slug}.job.{state}"), "createdAt": at(seconds_ago), "payload": {"topic": format!("agent.{slug}.job.{state}"), "source": slug, "publishedBy": format!("agent:agent/{slug}"), "data": body}})
    }

    fn book() -> JobBook {
        let mut book = JobBook::default();
        // j1 completed, j2 failed, j3 runs, j4 waits for the app stack that j3 holds, j5 was cancelled while waiting
        book.apply_event(&event("started", "qa", "job-j1", 900, json!({})));
        book.apply_event(&event("finished", "qa", "job-j1", 600, json!({"result": "completed", "summary": "all checks passed"})));
        book.apply_event(&event("started", "qa", "job-j2", 590, json!({})));
        book.apply_event(&event("finished", "qa", "job-j2", 500, json!({"result": "failed", "summary": "the sandbox went away"})));
        book.apply_event(&event("started", "qa", "job-j3", 400, json!({})));
        book.apply_event(&event("waiting", "qa", "job-j4", 300, json!({"waitingFor": "app-stack (held by verify job-j3)"})));
        book.apply_event(&event("waiting", "qa", "job-j5", 250, json!({"waitingFor": "app-stack (held by verify job-j3)"})));
        book.apply_event(&event("finished", "qa", "job-j5", 100, json!({"result": "cancelled"})));
        book
    }

    #[test]
    fn events_are_reduced_to_active_and_finished_jobs() {
        let work = book().work(NOW);
        assert_eq!(work.active.iter().map(|job| (job.id.as_str(), job.state.as_str())).collect::<Vec<_>>(), [("job-j3", "running"), ("job-j4", "waiting")]);
        assert_eq!(work.active[1].waiting_for.as_deref(), Some("app-stack (held by verify job-j3)"));
        assert_eq!(work.active[1].agent, "agent/qa");
        assert_eq!(work.finished.iter().map(|job| (job.id.as_str(), job.result.as_deref())).collect::<Vec<_>>(), [("job-j5", Some("cancelled")), ("job-j2", Some("failed")), ("job-j1", Some("completed"))]);
        let j1 = work.finished.iter().find(|job| job.id == "job-j1").unwrap();
        assert_eq!((j1.seconds, j1.summary.as_deref(), j1.label.as_str(), j1.requested_by.as_deref()), (Some(300.0), Some("all checks passed"), "verify job-j1", Some("agent/manager")));
        assert_eq!((work.completed_24h, work.failed_24h, work.cancelled_24h), (1, 1, 1));
    }

    #[test]
    fn throughput_counts_each_job_once_in_the_right_hour() {
        let work = book().work(NOW);
        assert_eq!(work.throughput.len(), 24);
        let started: u64 = work.throughput.iter().map(|b| b.started).sum();
        let completed: u64 = work.throughput.iter().map(|b| b.completed).sum();
        let failed: u64 = work.throughput.iter().map(|b| b.failed).sum();
        assert_eq!((started, completed, failed), (3, 1, 1));
    }

    #[test]
    fn a_finished_job_stays_finished_and_a_replayed_event_changes_nothing() {
        let mut book = book();
        book.apply_event(&event("started", "qa", "job-j1", 900, json!({})));
        book.apply_event(&event("waiting", "qa", "job-j1", 800, json!({"waitingFor": "x"})));
        let work = book.work(NOW);
        assert!(work.finished.iter().any(|job| job.id == "job-j1" && job.state == "finished"));
        assert_eq!(work.active.len(), 2);
    }

    #[test]
    fn a_job_that_starts_after_waiting_no_longer_waits_for_anything() {
        let mut book = JobBook::default();
        book.apply_event(&event("waiting", "qa", "job-a", 100, json!({"waitingFor": "app-stack (held by x)"})));
        book.apply_event(&event("started", "qa", "job-a", 50, json!({})));
        let work = book.work(NOW);
        assert_eq!((work.active[0].state.as_str(), work.active[0].waiting_for.clone()), ("running", None));
    }

    #[test]
    fn each_agent_gets_its_running_and_waiting_jobs_and_what_they_wait_for_once() {
        let mut agents = vec![SwAgent { id: "agent/qa".into(), role: "provider".into(), ..Default::default() }, SwAgent { id: "agent/idle".into(), ..Default::default() }];
        let mut book = book();
        book.apply_event(&event("waiting", "qa", "job-j6", 60, json!({"waitingFor": "app-stack (held by verify job-j3)"})));
        book.apply_event(&event("started", "pi", "job-p1", 60, json!({})));
        book.annotate(&mut agents);
        let qa = agents.iter().find(|agent| agent.id == "agent/qa").unwrap();
        assert_eq!((qa.running_jobs, qa.waiting_jobs), (1, 2));
        assert_eq!(qa.blocked_on, vec!["app-stack (held by verify job-j3)".to_string()]);
        assert_eq!(agents.iter().find(|agent| agent.id == "agent/idle").unwrap().running_jobs, 0);
        assert_eq!(agents.iter().find(|agent| agent.id == "agent/pi").map(|agent| agent.running_jobs), Some(1), "an agent only seen in job events still shows");
    }

    #[test]
    fn other_events_and_malformed_ones_are_ignored() {
        let mut book = JobBook::default();
        book.apply_event(&json!({"seq": 1, "type": "task.queued", "createdAt": at(5), "payload": {}}));
        book.apply_event(&json!({"seq": 2, "type": "agent.qa.job.exploded", "createdAt": at(5), "payload": {"data": {"jobId": "job-x"}}}));
        book.apply_event(&json!({"seq": 3, "type": "agent.qa.job.started", "createdAt": at(5), "payload": {"data": {"jobId": "bad id with spaces"}}}));
        book.apply_event(&json!({"seq": 4, "type": "agent.qa.job.started", "payload": {"data": {"jobId": "job-y"}}}));
        book.apply_event(&json!({"seq": 5, "type": "agent.qa.extra.job.started", "createdAt": at(5), "payload": {"data": {"jobId": "job-z"}}}));
        let work = book.work(NOW);
        assert!(work.active.is_empty() && work.finished.is_empty());
        assert_eq!(work.history_from, None);
    }

    #[test]
    fn only_short_plain_wording_reaches_the_output() {
        let mut book = JobBook::default();
        let mut started = event("started", "qa", "job-leak", 60, json!({"label": format!("verify\u{7} <b>SAD-1</b>\n{}", "x".repeat(400)), "input": {"instruction": "PRIVATE INSTRUCTION"}, "requestedBy": "bad actor <script>", "capability": "has space"}));
        started["payload"]["data"]["result"] = json!({"nested": "PRIVATE RESULT"});
        started["body"] = json!("PRIVATE BODY");
        book.apply_event(&started);
        book.apply_event(&event("finished", "qa", "job-leak", 30, json!({"requestedBy": "bad actor <script>", "capability": "has space", "result": "weird", "summary": format!("fine\u{1b}[31m{}", "y".repeat(900)), "artifact": "PRIVATE ARTIFACT"})));
        let work = book.work(NOW);
        let output = serde_json::to_string(&work).unwrap();
        assert!(!output.contains("PRIVATE"), "leaked: {output}");
        let job = &work.finished[0];
        assert!(job.label.chars().count() <= LABEL_CHARS && !job.label.chars().any(char::is_control));
        assert!(job.summary.as_deref().unwrap().chars().count() <= SUMMARY_CHARS);
        assert_eq!((job.requested_by.clone(), job.capability.clone(), job.result.as_deref()), (None, None, Some("completed")));
    }

    #[test]
    fn the_book_stays_bounded() {
        let mut book = JobBook::default();
        for i in 0..(MAX_JOBS + 200) {
            book.apply_event(&event("started", "qa", &format!("job-{i}"), 100, json!({})));
            book.apply_event(&event("finished", "qa", &format!("job-{i}"), 50, json!({"result": "completed"})));
        }
        assert!(book.jobs.len() <= MAX_JOBS + 1);
    }
}
