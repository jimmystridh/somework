mod grpc_common;

use std::time::{Duration, Instant};

use grpc_common::*;
use serde_json::json;
use somework_api::grpc::{pb, struct_to_json};
use somework_domain::policy::Permissions;
use tonic::{Code, Request};

fn text(body: &str) -> Option<prost_types::Value> {
    Some(prost_types::Value { kind: Some(prost_types::value::Kind::StringValue(body.into())) })
}

fn to_reviewer(body: &str) -> pb::SendMessageRequest {
    pb::SendMessageRequest {
        recipients: vec![pb::Member { kind: "agent".into(), id: "agent/reviewer".into() }],
        media_type: "text/plain".into(),
        data: text(body),
        ..Default::default()
    }
}

#[tokio::test]
async fn discover_then_talk_over_grpc() {
    let g = GrpcStack::start().await;
    let (reviewer, author) = g.review_pair().await;
    let (rc, ac) = (Creds::agent(&reviewer), Creds::agent(&author));

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

    let sent = g.messages(&ac).send(with_md(to_reviewer("Please review PR 729"), &[("idempotency-key", "ask-1")])).await.unwrap().into_inner();
    let replay = g.messages(&ac).send(with_md(to_reviewer("Please review PR 729"), &[("idempotency-key", "ask-1")])).await.unwrap().into_inner();
    assert_eq!(replay.message_id, sent.message_id, "an idempotency-key replay returns the same message");

    let mut stream = g.events(&rc).watch(pb::WatchEventsRequest { from_start: true, ..Default::default() }).await.unwrap().into_inner();
    let event = loop {
        let event = tokio::time::timeout(Duration::from_secs(5), stream.message()).await.unwrap().unwrap().unwrap();
        if event.r#type == "message.created" {
            break event;
        }
    };
    assert!(event.wake, "a directed message wakes its recipient");
    assert_eq!(event.message_id, sent.message_id);
    g.stack.stop().await;
}

#[tokio::test]
async fn invalid_requests_map_to_documented_codes() {
    let g = GrpcStack::start().await;
    let (_reviewer, author) = g.review_pair().await;
    let ac = Creds::agent(&author);

    expect_err(g.catalog(&ac).get_agent(pb::GetAgentRequest { agent_id: "agent/nobody".into() }).await, Code::NotFound, "not_found");
    expect_err(
        g.messages(&ac).send(pb::SendMessageRequest { media_type: "text/plain".into(), data: text("nobody to tell"), ..Default::default() }).await,
        Code::InvalidArgument,
        "validation_failed",
    );

    // payloads over the 32 KiB inline limit
    expect_err(g.messages(&ac).send(to_reviewer(&"x".repeat(40 * 1024))).await, Code::ResourceExhausted, "payload_too_large");

    // subscriptions must state wake behaviour explicitly, and follow topics or conversations only
    expect_err(
        g.subscriptions(&ac).create(pb::CreateSubscriptionRequest { kind: "topic".into(), selector: "catalog.changed".into(), wake_on_match: None }).await,
        Code::InvalidArgument,
        "validation_failed",
    );
    expect_err(
        g.subscriptions(&ac).create(pb::CreateSubscriptionRequest { kind: "task".into(), selector: "task_1".into(), wake_on_match: Some(true) }).await,
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
    let (_reviewer, author) = g.review_pair().await;
    let mut anonymous = pb::message_service_client::MessageServiceClient::new(g.channel.clone());
    let status = anonymous.send(to_reviewer("hi")).await.unwrap_err();
    assert_eq!(status.code(), Code::Unauthenticated);
    assert_eq!(reason(&status), "unauthenticated");
    assert!(status.metadata().get("trace-id").is_some(), "even failures carry the trace id");

    let mut forged = Creds::agent(&author);
    forged.key = std::sync::Arc::new(somework_core::jws::new_signing_key());
    expect_err(g.messages(&forged).send(to_reviewer("hi")).await, Code::Unauthenticated, "unauthenticated");

    let mut garbage = Request::new(to_reviewer("hi"));
    garbage.metadata_mut().insert("authorization", "Bearer not-a-token".parse().unwrap());
    let status = anonymous.send(garbage).await.unwrap_err();
    assert_eq!(status.code(), Code::Unauthenticated);
    g.stack.stop().await;
}

#[tokio::test]
async fn traceparent_propagates_into_the_response_and_the_event() {
    let g = GrpcStack::start().await;
    let (_reviewer, author) = g.review_pair().await;
    let ac = Creds::agent(&author);
    let trace_id = "4bf92f3577b34da6a3ce929d0e0e4736";
    let traceparent = format!("00-{trace_id}-00f067aa0ba902b7-01");
    let response = g.messages(&ac).send(with_md(to_reviewer("trace me"), &[("traceparent", &traceparent)])).await.unwrap();
    assert_eq!(response.metadata().get("trace-id").unwrap().to_str().unwrap(), trace_id);
    assert!(response.get_ref().trace_id.contains(trace_id));
    let envelope = struct_to_json(response.into_inner().envelope.unwrap());
    assert!(envelope["traceparent"].as_str().unwrap().contains(trace_id), "{envelope}");
    g.stack.stop().await;
}

#[tokio::test]
async fn policy_denial_is_permission_denied_and_audited_like_rest() {
    let g = GrpcStack::start().await;
    let (_reviewer, _author) = g.review_pair().await;
    // an agent that was never granted the right to send messages
    let key = g.stack.create_principal(somework_core::contracts::ActorKind::Agent, "agent/muted", Permissions::default()).await;
    let creds = Creds { key: key.clone(), issuer: "agent:agent/muted".into(), runtime: None };
    let rest = somework_client::Client::assertion(&g.stack.url, (*key).clone(), "agent", "agent/muted", "development");

    expect_err(g.messages(&creds).send(to_reviewer("hi")).await, Code::PermissionDenied, "policy_denied");
    let rest_err = rest
        .send_message(&json!({"recipients": [{"kind": "agent", "id": "agent/reviewer"}], "content": {"mediaType": "text/plain", "data": "hi"}}))
        .await
        .unwrap_err();
    assert_eq!(rest_err.status, 403);

    let audit = g.stack.admin.get("/v1/admin/audit?limit=500").await.unwrap();
    let denied: Vec<_> =
        audit["events"].as_array().unwrap().iter().filter(|e| e["outcome"] == "denied" && e["authenticatedActor"] == "agent:agent/muted").collect();
    assert_eq!(denied.len(), 2, "one denial per transport: {denied:?}");
    let transports: std::collections::BTreeSet<_> = denied.iter().map(|e| e["sourceTransport"].as_str().unwrap().to_string()).collect();
    assert_eq!(transports, ["grpc".to_string(), "rest".to_string()].into());
    assert!(denied.iter().all(|e| e["action"] == "message.send" && e["policyDecisionId"].is_string()));
    g.stack.stop().await;
}

#[tokio::test]
async fn event_watch_resumes_from_a_cursor_after_reconnect() {
    let g = GrpcStack::start().await;
    let (reviewer, author) = g.review_pair().await;
    let (rc, ac) = (Creds::agent(&reviewer), Creds::agent(&author));
    let first = g.messages(&ac).send(to_reviewer("first")).await.unwrap().into_inner();

    let mut stream = g.events(&rc).watch(pb::WatchEventsRequest { from_start: true, ..Default::default() }).await.unwrap().into_inner();
    let mut cursor = 0;
    while let Ok(next) = tokio::time::timeout(Duration::from_millis(400), stream.message()).await {
        cursor = cursor.max(next.unwrap().unwrap().seq);
    }
    assert!(cursor > 0);
    drop(stream);

    let second = g.messages(&ac).send(to_reviewer("second")).await.unwrap().into_inner();
    let mut resumed = g.events(&rc).watch(pb::WatchEventsRequest { after: cursor, ..Default::default() }).await.unwrap().into_inner();
    let mut next = None;
    let mut saw_second = false;
    while !saw_second {
        let e = tokio::time::timeout(Duration::from_secs(5), resumed.message()).await.unwrap().unwrap().unwrap();
        assert!(e.seq > cursor, "events up to the cursor are not replayed");
        assert_ne!(e.message_id, first.message_id);
        saw_second = e.message_id == second.message_id;
        next = Some(e);
    }
    let next = next.unwrap();
    // acknowledged cursors are honoured when no explicit `after` is given
    g.events(&rc).ack(pb::AckEventsRequest { cursor: next.seq + 1_000 }).await.unwrap();
    let mut from_ack = g.events(&rc).watch(pb::WatchEventsRequest::default()).await.unwrap().into_inner();
    assert!(tokio::time::timeout(Duration::from_millis(600), from_ack.message()).await.is_err(), "nothing newer than the acked cursor");
    drop((from_ack, resumed));
    g.stack.stop().await;
}

#[tokio::test]
async fn health_and_reflection_are_served() {
    let g = GrpcStack::start().await;
    let mut health = tonic_health::pb::health_client::HealthClient::new(g.channel.clone());
    let status = health.check(tonic_health::pb::HealthCheckRequest { service: "somework.v1.MessageService".into() }).await.unwrap().into_inner();
    assert_eq!(status.status, tonic_health::pb::health_check_response::ServingStatus::Serving as i32);
    let gone = health.check(tonic_health::pb::HealthCheckRequest { service: "somework.v1.TaskService".into() }).await;
    assert!(gone.is_err(), "there is no task service any more");
    g.stack.stop().await;
}

#[tokio::test]
async fn unary_send_latency_p95_is_under_50ms() {
    let g = GrpcStack::start().await;
    let (_reviewer, author) = g.review_pair().await;
    let ac = Creds::agent(&author);
    let mut client = g.messages(&ac);
    for _ in 0..10 {
        client.send(to_reviewer("warm up")).await.unwrap();
    }
    let mut samples = vec![];
    for _ in 0..200 {
        let started = Instant::now();
        client.send(to_reviewer("measure")).await.unwrap();
        samples.push(started.elapsed());
    }
    let p95 = pctl(samples, 0.95);
    assert!(p95 < Duration::from_millis(50), "p95 = {p95:?}");
    g.stack.stop().await;
}
