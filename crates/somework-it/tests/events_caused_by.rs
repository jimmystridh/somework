//! `causedByEvent` over REST, the client crate and gRPC: the domain verifies the event and records it as the task's origin.

mod grpc_common;

use grpc_common::*;
use serde_json::json;
use somework_api::grpc::struct_to_json;
use somework_client::Client;
use somework_core::{ErrorCode, contracts::ActorKind};
use somework_domain::{policy::Permissions, rules::RuleSpec};
use tonic::Code;

#[tokio::test]
async fn agents_submit_tasks_for_events_they_received_over_rest_and_grpc() {
    let g = GrpcStack::start().await;
    let (_worker, author) = g.review_pair().await;
    let stack = &g.stack;
    let producer_key = stack
        .create_principal(ActorKind::Service, "producer/grafana", Permissions { actions: vec!["events.publish:grafana.*".into()], ..Default::default() })
        .await;
    let producer = Client::assertion(&stack.url, (*producer_key).clone(), "service", "producer/grafana", &stack.domain_id);
    let wake = RuleSpec { owner: Some("agent/author".into()), selector: Some("grafana.alert.*".into()), wake: true, ..Default::default() };
    stack.domain().put_rule(&stack.domain().system_ctx(), "alerts-to-author", wake).await.unwrap();

    let published = producer.publish_event(&json!({"topic": "grafana.alert.firing", "key": "a1", "data": {"rule": "disk"}})).await.unwrap();
    let event_id = published["eventId"].as_str().unwrap().to_string();
    let (received, _) = author.client.events(0, 0).await.unwrap();
    assert!(received.iter().any(|e| e["eventId"] == json!(event_id) && e["wake"] == json!(true)));

    let request = json!({"capability": {"id": "code.review", "version": "2.1"}, "input": {"repository": "billing/import-service"}});

    // REST: forged and foreign ids are validation failures (422), the real one is recorded with depth + 1
    let forged = author.client.submit_task_for_event("evt_forged", &request, None).await.unwrap_err();
    assert_eq!((forged.status, forged.code), (422, ErrorCode::ValidationFailed));
    let stranger = stack.requester("agent/stranger", &["code.review"], somework_core::contracts::SideEffects::Read).await;
    let foreign = stranger.client.submit_task_for_event(&event_id, &request, None).await.unwrap_err();
    assert_eq!((foreign.status, foreign.code), (422, ErrorCode::ValidationFailed));
    let task = author.client.submit_task_for_event(&event_id, &request, Some("for-a1")).await.unwrap();
    assert_eq!(task.origin.as_ref().unwrap(), &json!({"kind": "event", "eventId": event_id, "depth": 1}));
    assert_eq!(author.client.get_task(&task.task_id).await.unwrap().origin, task.origin);

    // gRPC: the same checks
    let creds = Creds::agent(&author);
    let mut forged = submit_req();
    forged.caused_by_event = "evt_forged".into();
    expect_err(g.tasks(&creds).submit(forged).await, Code::InvalidArgument, "validation_failed");
    let mut foreign = submit_req();
    foreign.caused_by_event = event_id.clone();
    expect_err(g.tasks(&Creds::agent(&stranger)).submit(foreign).await, Code::InvalidArgument, "validation_failed");
    let mut genuine = submit_req();
    genuine.caused_by_event = event_id.clone();
    let task = g.tasks(&creds).submit(genuine).await.unwrap().into_inner().task.unwrap();
    let origin = struct_to_json(task.task.unwrap())["origin"].clone();
    assert_eq!(origin, json!({"kind": "event", "eventId": event_id, "depth": 1}));

    g.stack.stop().await;
}
