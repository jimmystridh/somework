//! Prometheus metrics (TEL-02). Gauges derived from canonical state are refreshed on scrape by
//! [`crate::Domain::refresh_gauges`].

use prometheus::{Encoder, Histogram, HistogramOpts, HistogramVec, IntCounter, IntCounterVec, IntGauge, IntGaugeVec, Opts, Registry, TextEncoder};

#[derive(Clone)]
pub struct Metrics {
    pub registry: Registry,
    pub catalog_search_latency: Histogram,
    pub catalog_searches: IntCounter,
    pub catalog_no_match: IntCounter,
    pub tasks_submitted: IntCounter,
    pub tasks_queued: IntGauge,
    pub task_queue_age: IntGauge,
    pub task_claim_latency: Histogram,
    pub task_duration: HistogramVec,
    pub tasks_terminal: IntCounterVec,
    pub task_retry_count: IntCounter,
    pub task_lease_expiry_count: IntCounter,
    pub task_reconciliation_count: IntCounter,
    pub outbox_backlog: IntGaugeVec,
    pub outbox_oldest_age: IntGaugeVec,
    pub outbox_dead: IntGaugeVec,
    pub jetstream_consumer_lag: IntGaugeVec,
    pub jetstream_redelivery_count: IntCounter,
    pub matrix_projection_lag: IntGauge,
    pub matrix_ingest_errors: IntCounter,
    pub matrix_undecryptable_events: IntCounter,
    pub artifact_upload_bytes: IntCounter,
    pub artifact_download_bytes: IntCounter,
    pub artifact_integrity_failures: IntCounter,
    pub policy_allow_count: IntCounter,
    pub policy_deny_count: IntCounter,
    pub policy_latency: Histogram,
    pub cross_domain_requests: IntCounterVec,
    pub cross_domain_denials: IntCounter,
    pub cross_domain_latency: Histogram,
    pub context_pack_size: Histogram,
    pub context_pack_artifact_count: Histogram,
    pub agent_connected: IntGauge,
    pub agent_offline: IntGauge,
    pub agent_runtime_restarts: IntCounter,
    pub api_requests: IntCounterVec,
    pub api_latency: HistogramVec,
}

fn counter(registry: &Registry, name: &str, help: &str) -> IntCounter {
    let c = IntCounter::new(name, help).expect("valid metric");
    registry.register(Box::new(c.clone())).expect("register metric");
    c
}

fn gauge(registry: &Registry, name: &str, help: &str) -> IntGauge {
    let g = IntGauge::new(name, help).expect("valid metric");
    registry.register(Box::new(g.clone())).expect("register metric");
    g
}

fn histogram(registry: &Registry, name: &str, help: &str, buckets: Vec<f64>) -> Histogram {
    let h = Histogram::with_opts(HistogramOpts::new(name, help).buckets(buckets)).expect("valid metric");
    registry.register(Box::new(h.clone())).expect("register metric");
    h
}

const LATENCY: &[f64] = &[0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0];

impl Metrics {
    pub fn new() -> Self {
        let r = Registry::new();
        let task_duration = HistogramVec::new(
            HistogramOpts::new("somework_task_duration_seconds", "Time from submission to terminal state")
                .buckets(vec![0.01, 0.1, 0.5, 1.0, 5.0, 30.0, 120.0, 600.0, 3600.0]),
            &["capability", "state"],
        )
        .expect("valid metric");
        r.register(Box::new(task_duration.clone())).expect("register");
        let tasks_terminal = IntCounterVec::new(Opts::new("somework_tasks_terminal_total", "Tasks reaching a terminal state"), &["state"]).expect("valid");
        r.register(Box::new(tasks_terminal.clone())).expect("register");
        let outbox_backlog = IntGaugeVec::new(Opts::new("somework_outbox_backlog", "Pending outbox rows per sink"), &["sink"]).expect("valid");
        r.register(Box::new(outbox_backlog.clone())).expect("register");
        let outbox_oldest_age =
            IntGaugeVec::new(Opts::new("somework_outbox_oldest_age_seconds", "Age of the oldest pending outbox row"), &["sink"]).expect("valid");
        r.register(Box::new(outbox_oldest_age.clone())).expect("register");
        let outbox_dead = IntGaugeVec::new(Opts::new("somework_outbox_dead", "Dead-lettered outbox rows per sink"), &["sink"]).expect("valid");
        r.register(Box::new(outbox_dead.clone())).expect("register");
        let jetstream_consumer_lag =
            IntGaugeVec::new(Opts::new("somework_jetstream_consumer_lag", "Pending messages per durable consumer"), &["stream", "consumer"]).expect("valid");
        r.register(Box::new(jetstream_consumer_lag.clone())).expect("register");
        let cross_domain_requests =
            IntCounterVec::new(Opts::new("somework_cross_domain_requests_total", "Federated requests"), &["direction", "outcome"]).expect("valid");
        r.register(Box::new(cross_domain_requests.clone())).expect("register");
        let api_requests = IntCounterVec::new(Opts::new("somework_api_requests_total", "API requests"), &["route", "status"]).expect("valid");
        r.register(Box::new(api_requests.clone())).expect("register");
        let api_latency =
            HistogramVec::new(HistogramOpts::new("somework_api_latency_seconds", "API latency").buckets(LATENCY.to_vec()), &["route"]).expect("valid");
        r.register(Box::new(api_latency.clone())).expect("register");

        Self {
            catalog_search_latency: histogram(&r, "somework_catalog_search_latency_seconds", "catalog.search latency", LATENCY.to_vec()),
            catalog_searches: counter(&r, "somework_catalog_searches_total", "catalog.search calls"),
            catalog_no_match: counter(&r, "somework_catalog_no_match_total", "catalog.search calls without matches"),
            tasks_submitted: counter(&r, "somework_tasks_submitted_total", "Tasks submitted"),
            tasks_queued: gauge(&r, "somework_tasks_queued", "Tasks in queued state"),
            task_queue_age: gauge(&r, "somework_task_queue_age_seconds", "Age of the oldest queued task"),
            task_claim_latency: histogram(
                &r,
                "somework_task_claim_latency_seconds",
                "Queued to claimed latency",
                vec![0.01, 0.05, 0.1, 0.5, 1.0, 5.0, 30.0, 300.0],
            ),
            task_duration,
            tasks_terminal,
            task_retry_count: counter(&r, "somework_task_retry_count_total", "Tasks re-queued after lease expiry"),
            task_lease_expiry_count: counter(&r, "somework_task_lease_expiry_count_total", "Leases that expired"),
            task_reconciliation_count: counter(&r, "somework_task_reconciliation_count_total", "Tasks parked for reconciliation"),
            outbox_backlog,
            outbox_oldest_age,
            outbox_dead,
            jetstream_consumer_lag,
            jetstream_redelivery_count: counter(&r, "somework_jetstream_redelivery_count_total", "JetStream redeliveries observed"),
            matrix_projection_lag: gauge(&r, "somework_matrix_projection_lag_seconds", "Age of the oldest unprojected Matrix event"),
            matrix_ingest_errors: counter(&r, "somework_matrix_ingest_errors_total", "Matrix ingestion failures"),
            matrix_undecryptable_events: counter(
                &r,
                "somework_matrix_undecryptable_events_total",
                "Encrypted Matrix events the bridge could not or must not decrypt",
            ),
            artifact_upload_bytes: counter(&r, "somework_artifact_upload_bytes_total", "Verified artifact bytes uploaded"),
            artifact_download_bytes: counter(&r, "somework_artifact_download_bytes_total", "Artifact bytes granted for download"),
            artifact_integrity_failures: counter(&r, "somework_artifact_integrity_failures_total", "Artifact digest mismatches"),
            policy_allow_count: counter(&r, "somework_policy_allow_total", "Policy allow decisions"),
            policy_deny_count: counter(&r, "somework_policy_deny_total", "Policy deny decisions"),
            policy_latency: histogram(&r, "somework_policy_latency_seconds", "Policy evaluation latency", vec![0.00005, 0.0001, 0.0005, 0.001, 0.005, 0.025]),
            cross_domain_requests,
            cross_domain_denials: counter(&r, "somework_cross_domain_denials_total", "Federated requests denied"),
            cross_domain_latency: histogram(&r, "somework_cross_domain_latency_seconds", "Federated request latency", LATENCY.to_vec()),
            context_pack_size: histogram(&r, "somework_context_pack_size_bytes", "ContextPack manifest size", vec![512.0, 2048.0, 8192.0, 16384.0, 32768.0]),
            context_pack_artifact_count: histogram(
                &r,
                "somework_context_pack_artifact_count",
                "Artifacts referenced per ContextPack",
                vec![0.0, 1.0, 2.0, 5.0, 10.0, 25.0],
            ),
            agent_connected: gauge(&r, "somework_agent_connected", "Agents with a live runtime instance"),
            agent_offline: gauge(&r, "somework_agent_offline", "Agents without a live runtime instance"),
            agent_runtime_restarts: counter(&r, "somework_agent_runtime_restarts_total", "Runtime instances registered for an agent that had one before"),
            api_requests,
            api_latency,
            registry: r,
        }
    }

    pub fn render(&self) -> String {
        let mut buf = Vec::new();
        TextEncoder::new().encode(&self.registry.gather(), &mut buf).expect("encode metrics");
        String::from_utf8(buf).unwrap_or_default()
    }
}

impl Default for Metrics {
    fn default() -> Self {
        Self::new()
    }
}
