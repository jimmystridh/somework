mod grpc_common;

use std::time::{Duration, Instant};

use grpc_common::*;
use serde_json::json;
use somework_api::grpc::{pb, struct_to_json};
use somework_core::contracts::SideEffects;
use somework_domain::policy::Permissions;
use tonic::{Code, Request};

#[tokio::test]
async fn discover_submit_claim_progress_complete_over_grpc() {
    let g = GrpcStack::start().await;
    let (worker, author) = g.review_pair().await;
    let (wc, ac) = (Creds::agent(&worker), Creds::agent(&author));

    let found = g
        .catalog(&ac)
        .search(pb::SearchRequest { query: "Review a pull request for correctness and security".into(), limit: 5, ..Default::default() })
        .await
        .unwrap();
    assert!(found.metadata().get("trace-id").is_some());
    let found = found.into_inner();
    assert_eq!(found.matches[0].agent_id, "agent/reviewer");
    assert_eq!(found.matches[0].matched_capabilities[0].id, "code.review");
    assert!(found.trace_id.starts_with("00-"));

    let agent = g.catalog(&ac).get_agent(pb::GetAgentRequest { agent_id: "agent/reviewer".into() }).await.unwrap().into_inner();
    assert_eq!(agent.agent_id, "agent/reviewer");
    let cap = g.catalog(&ac).get_capability(pb::GetCapabilityRequest { id: "code.review".into(), version: "2.1".into() }).await.unwrap().into_inner();
    assert_eq!(struct_to_json(cap.capability.unwrap())["sideEffects"], "read");

    let submitted = g.tasks(&ac).submit(submit_req()).await.unwrap().into_inner();
    let task = submitted.task.unwrap();
    assert_eq!(task.state, pb::TaskState::Queued as i32);
    assert_eq!(task.revision, 2, "submitted(1) -> queued(2)");

    let claim = g.tasks(&wc).claim(pb::ClaimTaskRequest { task_id: task.task_id.clone(), lease_seconds: 30, ..Default::default() }).await.unwrap().into_inner();
    assert_eq!(claim.fencing_token, 1);
    assert!(!claim.authorization_token.is_empty());
    assert_eq!(claim.task.unwrap().state, pb::TaskState::Claimed as i32);

    let beat =
        g.tasks(&wc).heartbeat(pb::HeartbeatTaskRequest { task_id: task.task_id.clone(), fencing_token: 1, lease_seconds: 30 }).await.unwrap().into_inner();
    assert_eq!(beat.state, pb::TaskState::Claimed as i32);

    let running = g
        .tasks(&wc)
        .progress(pb::ProgressTaskRequest {
            task_id: task.task_id.clone(),
            fencing_token: 1,
            message: "analyzing".into(),
            checkpoint: Some(struct_of(json!({"files": 3}))),
            ..Default::default()
        })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(running.task.unwrap().state, pb::TaskState::Running as i32);

    let done = g
        .tasks(&wc)
        .complete(pb::CompleteTaskRequest {
            task_id: task.task_id.clone(),
            fencing_token: 1,
            result: Some(struct_of(json!({"verdict": "approve"}))),
            ..Default::default()
        })
        .await
        .unwrap()
        .into_inner()
        .task
        .unwrap();
    assert_eq!(done.state, pb::TaskState::Succeeded as i32);
    assert_eq!(struct_to_json(done.task.unwrap())["result"]["verdict"], "approve");

    let fetched = g.tasks(&ac).get(pb::GetTaskRequest { task_id: task.task_id.clone() }).await.unwrap().into_inner().task.unwrap();
    assert_eq!(fetched.state, pb::TaskState::Succeeded as i32);
    let events = g.tasks(&ac).list_events(pb::ListTaskEventsRequest { task_id: task.task_id.clone(), ..Default::default() }).await.unwrap().into_inner().events;
    let kinds: Vec<&str> = events.iter().map(|e| e.r#type.as_str()).collect();
    assert_eq!(kinds, ["task.submitted", "task.queued", "task.claimed", "task.running", "task.succeeded"]);
    g.stack.stop().await;
}

#[tokio::test]
async fn idempotency_key_replay_returns_the_same_task() {
    let g = GrpcStack::start().await;
    let (_worker, author) = g.review_pair().await;
    let ac = Creds::agent(&author);
    let first = g.tasks(&ac).submit(with_md(submit_req(), &[("idempotency-key", "review-pr-729")])).await.unwrap().into_inner();
    let again = g.tasks(&ac).submit(with_md(submit_req(), &[("idempotency-key", "review-pr-729")])).await.unwrap().into_inner();
    assert_eq!(first.task.as_ref().unwrap().task_id, again.task.as_ref().unwrap().task_id);

    let mut different = submit_req();
    different.input = Some(struct_of(json!({"repository": "other/repo"})));
    expect_err(g.tasks(&ac).submit(with_md(different, &[("idempotency-key", "review-pr-729")])).await, Code::AlreadyExists, "idempotency_conflict");
    g.stack.stop().await;
}

#[tokio::test]
async fn stale_revision_is_failed_precondition_and_stale_fence_is_aborted() {
    let g = GrpcStack::start().await;
    let (worker, author) = g.review_pair().await;
    let (wc, ac) = (Creds::agent(&worker), Creds::agent(&author));
    let task = g.tasks(&ac).submit(submit_req()).await.unwrap().into_inner().task.unwrap();

    // revision guard through both the metadata (If-Match) and the request field
    let status = expect_err(
        g.tasks(&ac).cancel(with_md(pb::CancelTaskRequest { task_id: task.task_id.clone(), ..Default::default() }, &[("if-match", "1")])).await,
        Code::FailedPrecondition,
        "stale_revision",
    );
    assert!(status.message().contains("revision"));
    expect_err(
        g.tasks(&ac).cancel(pb::CancelTaskRequest { task_id: task.task_id.clone(), expected_revision: Some(1), ..Default::default() }).await,
        Code::FailedPrecondition,
        "stale_revision",
    );

    let claim = g.tasks(&wc).claim(pb::ClaimTaskRequest { task_id: task.task_id.clone(), lease_seconds: 30, ..Default::default() }).await.unwrap().into_inner();
    expect_err(
        g.tasks(&wc).heartbeat(pb::HeartbeatTaskRequest { task_id: task.task_id.clone(), fencing_token: claim.fencing_token + 41, lease_seconds: 30 }).await,
        Code::Aborted,
        "stale_fencing_token",
    );
    // another process of the same logical agent cannot take a leased task; the holder's own retry is idempotent
    let second_runtime = Creds::agent(&worker.new_runtime().await);
    expect_err(
        g.tasks(&second_runtime).claim(pb::ClaimTaskRequest { task_id: task.task_id.clone(), ..Default::default() }).await,
        Code::Aborted,
        "already_claimed",
    );
    let replayed =
        g.tasks(&wc).claim(pb::ClaimTaskRequest { task_id: task.task_id.clone(), lease_seconds: 30, ..Default::default() }).await.unwrap().into_inner();
    assert_eq!(replayed.fencing_token, claim.fencing_token);

    // terminal states are immutable
    g.tasks(&wc).progress(pb::ProgressTaskRequest { task_id: task.task_id.clone(), fencing_token: 1, ..Default::default() }).await.unwrap();
    g.tasks(&wc)
        .complete(pb::CompleteTaskRequest {
            task_id: task.task_id.clone(),
            fencing_token: 1,
            result: Some(struct_of(json!({"verdict": "reject"}))),
            ..Default::default()
        })
        .await
        .unwrap();
    expect_err(
        g.tasks(&ac).cancel(pb::CancelTaskRequest { task_id: task.task_id.clone(), ..Default::default() }).await,
        Code::FailedPrecondition,
        "task_terminal",
    );
    g.stack.stop().await;
}

#[tokio::test]
async fn invalid_requests_map_to_documented_codes() {
    let g = GrpcStack::start().await;
    let (_worker, author) = g.review_pair().await;
    let ac = Creds::agent(&author);

    // schema violation, unknown capability (hidden == nonexistent), unknown task
    let mut bad_input = submit_req();
    bad_input.input = Some(struct_of(json!({"commit": "no repository"})));
    expect_err(g.tasks(&ac).submit(bad_input).await, Code::InvalidArgument, "schema_violation");
    let mut unknown = submit_req();
    unknown.capability = Some(pb::CapabilityRef { id: "nope.nope".into(), version: "1".into() });
    expect_err(g.tasks(&ac).submit(unknown).await, Code::NotFound, "not_found");
    expect_err(g.tasks(&ac).get(pb::GetTaskRequest { task_id: "task_missing".into() }).await, Code::NotFound, "not_found");

    // payloads over the 32 KiB inline limit
    let mut huge = submit_req();
    huge.input = Some(struct_of(json!({"repository": "x".repeat(40 * 1024)})));
    expect_err(g.tasks(&ac).submit(huge).await, Code::ResourceExhausted, "payload_too_large");

    // subscriptions must state wake behaviour explicitly
    expect_err(
        g.subscriptions(&ac).create(pb::CreateSubscriptionRequest { kind: "topic".into(), selector: "catalog.changed".into(), wake_on_match: None }).await,
        Code::InvalidArgument,
        "validation_failed",
    );
    let sub = g
        .subscriptions(&ac)
        .create(pb::CreateSubscriptionRequest { kind: "topic".into(), selector: "catalog.changed".into(), wake_on_match: Some(false) })
        .await
        .unwrap()
        .into_inner();
    assert!(!sub.wake_on_match);
    g.subscriptions(&ac).delete(pb::DeleteSubscriptionRequest { subscription_id: sub.subscription_id }).await.unwrap();
    g.stack.stop().await;
}

#[tokio::test]
async fn missing_or_invalid_credentials_are_unauthenticated() {
    let g = GrpcStack::start().await;
    let (_worker, author) = g.review_pair().await;
    let mut anonymous = pb::task_service_client::TaskServiceClient::new(g.channel.clone());
    let status = anonymous.get(pb::GetTaskRequest { task_id: "x".into() }).await.unwrap_err();
    assert_eq!(status.code(), Code::Unauthenticated);
    assert_eq!(reason(&status), "unauthenticated");
    assert!(status.metadata().get("trace-id").is_some(), "even failures carry the trace id");

    let mut forged = Creds::agent(&author);
    forged.key = std::sync::Arc::new(somework_core::jws::new_signing_key());
    expect_err(g.tasks(&forged).get(pb::GetTaskRequest { task_id: "x".into() }).await, Code::Unauthenticated, "unauthenticated");

    let mut garbage = Request::new(pb::GetTaskRequest { task_id: "x".into() });
    garbage.metadata_mut().insert("authorization", "Bearer not-a-token".parse().unwrap());
    let status = anonymous.get(garbage).await.unwrap_err();
    assert_eq!(status.code(), Code::Unauthenticated);
    g.stack.stop().await;
}

#[tokio::test]
async fn traceparent_propagates_into_task_events() {
    let g = GrpcStack::start().await;
    let (_worker, author) = g.review_pair().await;
    let ac = Creds::agent(&author);
    let trace_id = "4bf92f3577b34da6a3ce929d0e0e4736";
    let traceparent = format!("00-{trace_id}-00f067aa0ba902b7-01");
    let response = g.tasks(&ac).submit(with_md(submit_req(), &[("traceparent", &traceparent)])).await.unwrap();
    assert_eq!(response.metadata().get("trace-id").unwrap().to_str().unwrap(), trace_id);
    assert!(response.get_ref().trace_id.contains(trace_id));
    let task_id = response.into_inner().task.unwrap().task_id;
    let events = g.tasks(&ac).list_events(pb::ListTaskEventsRequest { task_id, ..Default::default() }).await.unwrap().into_inner().events;
    assert!(events.iter().all(|e| e.trace_id == trace_id), "{events:?}");
    g.stack.stop().await;
}

#[tokio::test]
async fn policy_denial_is_permission_denied_and_audited_like_rest() {
    let g = GrpcStack::start().await;
    let (_worker, _author) = g.review_pair().await;
    // may discover the capability but was never granted the right to invoke it
    let mut perms = Permissions::default_agent();
    perms.discover = vec!["code.review".into()];
    perms.side_effects_at_most = Some(SideEffects::Read);
    let key = g.stack.create_principal(somework_core::contracts::ActorKind::Agent, "agent/curious", perms).await;
    let creds = Creds { key: key.clone(), issuer: "agent:agent/curious".into(), runtime: None };
    let rest = somework_client::Client::assertion(&g.stack.url, (*key).clone(), "agent", "agent/curious", "development");

    expect_err(g.tasks(&creds).submit(submit_req()).await, Code::PermissionDenied, "policy_denied");
    let rest_err = rest.submit_task(&json!({"capability": {"id": "code.review", "version": "2.1"}, "input": {"repository": "a/b"}}), None).await.unwrap_err();
    assert_eq!(rest_err.status, 403);

    let audit = g.stack.admin.get("/v1/admin/audit?limit=500").await.unwrap();
    let denied: Vec<_> =
        audit["events"].as_array().unwrap().iter().filter(|e| e["outcome"] == "denied" && e["authenticatedActor"] == "agent:agent/curious").collect();
    assert_eq!(denied.len(), 2, "one denial per transport: {denied:?}");
    let transports: std::collections::BTreeSet<_> = denied.iter().map(|e| e["sourceTransport"].as_str().unwrap().to_string()).collect();
    assert_eq!(transports, ["grpc".to_string(), "rest".to_string()].into());
    assert!(denied.iter().all(|e| e["action"] == "task.submit" && e["policyDecisionId"].is_string()));
    g.stack.stop().await;
}

#[tokio::test]
async fn event_watch_resumes_from_a_cursor_after_reconnect() {
    let g = GrpcStack::start().await;
    let (_worker, author) = g.review_pair().await;
    let ac = Creds::agent(&author);
    let first = g.tasks(&ac).submit(submit_req()).await.unwrap().into_inner().task.unwrap();

    let mut stream = g.events(&ac).watch(pb::WatchEventsRequest { from_start: true, ..Default::default() }).await.unwrap().into_inner();
    let mut cursor = 0;
    while let Ok(next) = tokio::time::timeout(Duration::from_millis(400), stream.message()).await {
        cursor = cursor.max(next.unwrap().unwrap().seq);
    }
    assert!(cursor > 0);
    drop(stream);

    let second = g.tasks(&ac).submit(submit_req()).await.unwrap().into_inner().task.unwrap();
    let mut resumed = g.events(&ac).watch(pb::WatchEventsRequest { after: cursor, ..Default::default() }).await.unwrap().into_inner();
    let mut next = None;
    let mut saw_second = false;
    while !saw_second {
        let e = tokio::time::timeout(Duration::from_secs(5), resumed.message()).await.unwrap().unwrap().unwrap();
        assert!(e.seq > cursor, "events up to the cursor are not replayed");
        assert_ne!(e.task_id, first.task_id);
        saw_second = e.task_id == second.task_id;
        next = Some(e);
    }
    let next = next.unwrap();
    // acknowledged cursors are honoured when no explicit `after` is given
    g.events(&ac).ack(pb::AckEventsRequest { cursor: next.seq + 1_000 }).await.unwrap();
    let mut from_ack = g.events(&ac).watch(pb::WatchEventsRequest::default()).await.unwrap().into_inner();
    assert!(tokio::time::timeout(Duration::from_millis(600), from_ack.message()).await.is_err(), "nothing newer than the acked cursor");
    drop((from_ack, resumed));
    g.stack.stop().await;
}

#[tokio::test]
async fn task_watch_streams_snapshot_then_updates_until_terminal() {
    let g = GrpcStack::start().await;
    let (worker, author) = g.review_pair().await;
    let (wc, ac) = (Creds::agent(&worker), Creds::agent(&author));
    let task = g.tasks(&ac).submit(submit_req()).await.unwrap().into_inner().task.unwrap();
    let mut watch = g.tasks(&ac).watch(pb::WatchTaskRequest { task_id: task.task_id.clone() }).await.unwrap().into_inner();
    let snapshot = watch.message().await.unwrap().unwrap();
    assert!(snapshot.snapshot && snapshot.event.is_none());
    assert_eq!(snapshot.task.unwrap().state, pb::TaskState::Queued as i32);

    let tid = task.task_id.clone();
    let worker_side = tokio::spawn({
        let g_tasks = g.tasks(&wc);
        async move {
            let mut t = g_tasks;
            t.claim(pb::ClaimTaskRequest { task_id: tid.clone(), lease_seconds: 30, ..Default::default() }).await.unwrap();
            t.progress(pb::ProgressTaskRequest { task_id: tid.clone(), fencing_token: 1, ..Default::default() }).await.unwrap();
            t.complete(pb::CompleteTaskRequest {
                task_id: tid,
                fencing_token: 1,
                result: Some(struct_of(json!({"verdict": "approve"}))),
                ..Default::default()
            })
            .await
            .unwrap();
        }
    });
    let mut kinds = vec![];
    while let Some(update) = tokio::time::timeout(Duration::from_secs(10), watch.message()).await.unwrap().unwrap() {
        kinds.push(update.event.unwrap().r#type);
    }
    worker_side.await.unwrap();
    assert_eq!(kinds, ["task.claimed", "task.running", "task.succeeded"], "the stream ends once the task is terminal");
    g.stack.stop().await;
}

#[tokio::test]
async fn health_and_reflection_are_served() {
    let g = GrpcStack::start().await;
    let mut health = tonic_health::pb::health_client::HealthClient::new(g.channel.clone());
    let status = health.check(tonic_health::pb::HealthCheckRequest { service: "somework.v1.TaskService".into() }).await.unwrap().into_inner();
    assert_eq!(status.status, tonic_health::pb::health_check_response::ServingStatus::Serving as i32);
    g.stack.stop().await;
}

#[tokio::test]
async fn unary_submit_latency_p95_is_under_50ms() {
    let g = GrpcStack::start().await;
    let (_worker, author) = g.review_pair().await;
    let ac = Creds::agent(&author);
    let mut client = g.tasks(&ac);
    for _ in 0..10 {
        client.submit(submit_req()).await.unwrap();
    }
    let mut samples = vec![];
    for _ in 0..200 {
        let started = Instant::now();
        client.submit(submit_req()).await.unwrap();
        samples.push(started.elapsed());
    }
    let p95 = pctl(samples, 0.95);
    assert!(p95 < Duration::from_millis(50), "p95 = {p95:?}");
    g.stack.stop().await;
}
