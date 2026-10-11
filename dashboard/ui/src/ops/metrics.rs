//! Per-agent figures worked out in the page: the hourly throughput of one agent and the counts of its jobs. The fleet-wide figures come
//! from the server; an agent's own come from its job events and its job record, which the agent page already holds.

use chrono::DateTime;
use fleet_shared::{
    somework::{HourBucket, JobView, LiveJob},
    timestamp_ms,
};
use std::collections::BTreeSet;

const HOUR_MS: i64 = 3_600_000;
pub const HOURS: usize = 24;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Ending {
    Completed,
    Failed,
    Cancelled,
}

struct Moment {
    started: Option<i64>,
    ended: Option<(i64, Ending)>,
}

fn ending_of(text: Option<&str>) -> Ending {
    match text {
        Some("failed") => Ending::Failed,
        Some("cancelled") => Ending::Cancelled,
        _ => Ending::Completed,
    }
}

fn moment_of_event(job: &LiveJob) -> Moment {
    Moment { started: job.started_at.as_deref().and_then(timestamp_ms), ended: job.finished_at.as_deref().and_then(timestamp_ms).map(|at| (at, ending_of(job.result.as_deref()))) }
}

fn moment_of_record(job: &JobView) -> Moment {
    let ending = if job.state == "failed" { Ending::Failed } else { ending_of(Some(job.state.as_str())) };
    Moment { started: job.started_at.as_deref().and_then(timestamp_ms), ended: job.ended_at.as_deref().and_then(timestamp_ms).map(|at| (at, ending)) }
}

fn rfc3339(ms: i64) -> String {
    DateTime::from_timestamp_millis(ms).map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)).unwrap_or_default()
}

/// The last 24 hours in hourly buckets, oldest first, from the agent's job events and, for jobs the events no longer hold, its job record.
/// A job that appears in both counts once.
pub fn hourly_buckets(now_ms: i64, events: &[LiveJob], record: &[JobView]) -> Vec<HourBucket> {
    let current_hour = now_ms.div_euclid(HOUR_MS) * HOUR_MS;
    let first = current_hour - (HOURS as i64 - 1) * HOUR_MS;
    let mut buckets: Vec<HourBucket> = (0..HOURS).map(|index| HourBucket { hour_start: rfc3339(first + index as i64 * HOUR_MS), started: 0, completed: 0, failed: 0 }).collect();
    let known: BTreeSet<&str> = events.iter().map(|job| job.id.as_str()).collect();
    let moments = events.iter().map(moment_of_event).chain(record.iter().filter(|job| !known.contains(job.job.as_str())).map(moment_of_record));
    let slot = |at: i64| (at >= first && at < current_hour + HOUR_MS).then(|| ((at - first) / HOUR_MS) as usize);
    for moment in moments {
        if let Some(index) = moment.started.and_then(slot) {
            buckets[index].started += 1;
        }
        if let Some((at, ending)) = moment.ended
            && let Some(index) = slot(at)
        {
            match ending {
                Ending::Completed => buckets[index].completed += 1,
                Ending::Failed => buckets[index].failed += 1,
                Ending::Cancelled => {}
            }
        }
    }
    buckets
}

/// How one agent's jobs stand: running, waiting, and finished jobs by result.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct JobCounts {
    pub running: usize,
    pub waiting: usize,
    pub completed: usize,
    pub failed: usize,
    pub cancelled: usize,
}

pub fn is_active(job: &LiveJob) -> bool {
    matches!(job.state.as_str(), "running" | "waiting")
}

pub fn job_counts(jobs: &[LiveJob]) -> JobCounts {
    let mut counts = JobCounts::default();
    for job in jobs {
        match (job.state.as_str(), job.result.as_deref()) {
            ("running", _) => counts.running += 1,
            ("waiting", _) => counts.waiting += 1,
            (_, Some("failed")) => counts.failed += 1,
            (_, Some("cancelled")) => counts.cancelled += 1,
            _ => counts.completed += 1,
        }
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-10-10T10:30:00.000Z";

    fn now() -> i64 {
        timestamp_ms(NOW).unwrap()
    }

    fn event(id: &str, started: Option<&str>, finished: Option<&str>, result: Option<&str>) -> LiveJob {
        LiveJob { id: id.into(), started_at: started.map(Into::into), finished_at: finished.map(Into::into), result: result.map(Into::into), state: if finished.is_some() { "completed".into() } else { "running".into() }, ..Default::default() }
    }

    fn record(id: &str, started: &str, ended: &str, state: &str) -> JobView {
        JobView { job: id.into(), started_at: Some(started.into()), ended_at: Some(ended.into()), state: state.into(), ..Default::default() }
    }

    #[test]
    fn there_are_twenty_four_buckets_ending_with_the_current_hour() {
        let buckets = hourly_buckets(now(), &[], &[]);
        assert_eq!(buckets.len(), 24);
        assert_eq!(buckets.last().unwrap().hour_start, "2026-10-10T10:00:00.000Z");
        assert_eq!(buckets[0].hour_start, "2026-10-09T11:00:00.000Z");
    }

    #[test]
    fn jobs_land_in_the_hour_they_started_and_ended() {
        let events = [event("a", Some("2026-10-10T09:10:00.000Z"), Some("2026-10-10T10:05:00.000Z"), Some("completed")), event("b", Some("2026-10-10T10:20:00.000Z"), None, None), event("c", Some("2026-10-10T08:00:00.000Z"), Some("2026-10-10T08:30:00.000Z"), Some("failed"))];
        let buckets = hourly_buckets(now(), &events, &[]);
        let at = |hour: usize| (buckets[hour].started, buckets[hour].completed, buckets[hour].failed);
        assert_eq!(at(23), (1, 1, 0), "b started and a ended in the 10 o'clock hour");
        assert_eq!(at(22), (1, 0, 0), "a started at 09:10");
        assert_eq!(at(21), (1, 0, 1), "c started and failed at 08");
    }

    #[test]
    fn jobs_older_than_a_day_or_in_the_future_are_left_out_and_cancelled_ones_do_not_count_as_finished_work() {
        let events = [event("old", Some("2026-10-08T08:00:00.000Z"), Some("2026-10-08T08:30:00.000Z"), Some("completed")), event("later", Some("2026-10-10T12:00:00.000Z"), None, None), event("x", None, Some("2026-10-10T10:01:00.000Z"), Some("cancelled"))];
        let buckets = hourly_buckets(now(), &events, &[]);
        assert_eq!(buckets.iter().map(|b| b.started + b.completed + b.failed).sum::<u64>(), 0);
    }

    #[test]
    fn a_job_in_the_events_and_in_the_record_counts_once_and_the_record_fills_what_the_events_lack() {
        let events = [event("same", Some("2026-10-10T10:00:00.000Z"), Some("2026-10-10T10:10:00.000Z"), Some("completed"))];
        let history = [record("same", "2026-10-10T10:00:00.000Z", "2026-10-10T10:10:00.000Z", "completed"), record("only-record", "2026-10-10T07:00:00.000Z", "2026-10-10T07:30:00.000Z", "failed")];
        let buckets = hourly_buckets(now(), &events, &history);
        assert_eq!((buckets[23].started, buckets[23].completed), (1, 1));
        assert_eq!((buckets[20].started, buckets[20].failed), (1, 1));
    }

    #[test]
    fn jobs_are_counted_by_state_and_result() {
        let job = |state: &str, result: Option<&str>| LiveJob { state: state.into(), result: result.map(Into::into), ..Default::default() };
        let counts = job_counts(&[job("running", None), job("waiting", None), job("completed", Some("completed")), job("failed", Some("failed")), job("cancelled", Some("cancelled")), job("completed", None)]);
        assert_eq!(counts, JobCounts { running: 1, waiting: 1, completed: 2, failed: 1, cancelled: 1 });
        assert!(is_active(&job("waiting", None)) && !is_active(&job("completed", None)));
    }
}
