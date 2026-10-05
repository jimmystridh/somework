//! Load profile from the spec: provisional workload (<= 20 task submissions/s, <= 100 persistent messages/s) and a 10x
//! stress profile. Acceptance: control-plane write p95 <= 250 ms excluding model/tool work. The strict assertions run
//! with `SOMEWORK_LOAD_STRICT=1` (use `cargo test --release`); debug builds assert a relaxed bound.

use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use serde_json::json;
use somework_core::contracts::SideEffects;
use somework_domain::policy::Permissions;
use somework_testkit::{Stack, capability};

fn percentile(samples: &mut [f64], p: f64) -> f64 {
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    if samples.is_empty() {
        return 0.0;
    }
    samples[((samples.len() as f64 - 1.0) * p).round() as usize]
}

fn strict() -> bool {
    std::env::var("SOMEWORK_LOAD_STRICT").is_ok() || !cfg!(debug_assertions)
}

struct Profile {
    name: &'static str,
    rate_per_second: u64,
    seconds: u64,
    message_rate: u64,
}

async fn run_profile(profile: Profile) -> (f64, f64, usize) {
    let stack = Stack::start().await;
    let mut perms = Permissions::default_agent();
    perms.side_effects_at_most = Some(SideEffects::Read);
    let _worker = stack.worker("agent/reviewer", vec![capability("code.review", "2.1", "read", "Review")], perms).await;
    let author = Arc::new(stack.requester("agent/author", &["code.review"], SideEffects::Read).await);
    let peer = Arc::new(stack.requester("agent/peer", &[], SideEffects::None).await);

    let task_latencies = Arc::new(parking_lot_free::Samples::default());
    let message_latencies = Arc::new(parking_lot_free::Samples::default());
    let errors = Arc::new(AtomicUsize::new(0));
    let started = Instant::now();
    let mut handles = vec![];
    let total_tasks = profile.rate_per_second * profile.seconds;
    for i in 0..total_tasks {
        let at = started + Duration::from_micros(i * 1_000_000 / profile.rate_per_second);
        let (author, lat, errors) = (author.clone(), task_latencies.clone(), errors.clone());
        handles.push(tokio::spawn(async move {
            tokio::time::sleep_until(tokio::time::Instant::from_std(at)).await;
            let t = Instant::now();
            match author
                .client
                .submit_task(
                    &json!({"capability": {"id": "code.review", "version": "2.1"}, "input": {"repository": format!("r{i}")}}),
                    Some(&format!("load-{i}")),
                )
                .await
            {
                Ok(_) => lat.push(t.elapsed().as_secs_f64() * 1000.0),
                Err(_) => {
                    errors.fetch_add(1, Ordering::Relaxed);
                }
            }
        }));
    }
    let total_messages = profile.message_rate * profile.seconds;
    for i in 0..total_messages {
        let at = started + Duration::from_micros(i * 1_000_000 / profile.message_rate.max(1));
        let (peer, lat, errors) = (peer.clone(), message_latencies.clone(), errors.clone());
        handles.push(tokio::spawn(async move {
            tokio::time::sleep_until(tokio::time::Instant::from_std(at)).await;
            let t = Instant::now();
            match peer
                .client
                .send_message(
                    &json!({"recipients": [{"kind": "agent", "id": "agent/author"}], "content": {"mediaType": "text/plain", "data": format!("m{i}")}}),
                )
                .await
            {
                Ok(_) => lat.push(t.elapsed().as_secs_f64() * 1000.0),
                Err(_) => {
                    errors.fetch_add(1, Ordering::Relaxed);
                }
            }
        }));
    }
    for h in handles {
        let _ = h.await;
    }
    let mut tasks = task_latencies.take();
    let mut messages = message_latencies.take();
    let (p95_task, p95_msg) = (percentile(&mut tasks, 0.95), percentile(&mut messages, 0.95));
    let failed = errors.load(Ordering::Relaxed);
    println!(
        "[{}] {} tasks @ {}/s + {} messages @ {}/s: task p50 {:.1} ms p95 {:.1} ms p99 {:.1} ms | message p95 {:.1} ms | errors {}",
        profile.name,
        tasks.len(),
        profile.rate_per_second,
        messages.len(),
        profile.message_rate,
        percentile(&mut tasks, 0.5),
        p95_task,
        percentile(&mut tasks, 0.99),
        p95_msg,
        failed
    );
    stack.stop().await;
    (p95_task, p95_msg, failed)
}

mod parking_lot_free {
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct Samples(Mutex<Vec<f64>>);

    impl Samples {
        pub fn push(&self, v: f64) {
            self.0.lock().unwrap().push(v);
        }
        pub fn take(&self) -> Vec<f64> {
            std::mem::take(&mut *self.0.lock().unwrap())
        }
    }
}

/// Both profiles saturate the same CPUs, so they must not overlap: run concurrently they measure each other.
static ONE_PROFILE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn provisional_load_meets_the_control_plane_write_latency_target() {
    let _alone = ONE_PROFILE_AT_A_TIME.lock().await;
    let (p95_task, p95_msg, failed) = run_profile(Profile { name: "provisional", rate_per_second: 20, seconds: 15, message_rate: 100 }).await;
    assert_eq!(failed, 0, "no request fails at the provisional load");
    let limit = if strict() { 250.0 } else { 1500.0 };
    assert!(p95_task <= limit, "task submit p95 {p95_task:.1} ms exceeds {limit} ms");
    assert!(p95_msg <= limit, "message send p95 {p95_msg:.1} ms exceeds {limit} ms");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ten_times_stress_degrades_gracefully_without_errors() {
    let _alone = ONE_PROFILE_AT_A_TIME.lock().await;
    let (p95_task, _p95_msg, failed) = run_profile(Profile { name: "10x stress", rate_per_second: 200, seconds: 8, message_rate: 1000 }).await;
    assert_eq!(failed, 0, "the 10x profile completes without a single failed request (back-pressure shows up as latency, not errors)");
    let limit = if strict() { 2000.0 } else { 15000.0 };
    assert!(p95_task <= limit, "10x stress p95 {p95_task:.1} ms exceeds {limit} ms");
}
