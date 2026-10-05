//! Events and rules end to end through the admin CLI, REST and gRPC: principals are enrolled with the real admin commands, a
//! rule is applied by the deployer, a producer publishes (twice), the server's own reaction worker starts exactly one
//! task, and the reviewer can claim and finish it.

mod grpc_common;

use std::{path::Path, sync::Arc, time::Duration};

use grpc_common::{Creds, with_md};
use serde_json::{Value, json};
use somework_api::{
    cli::{AdminCommand, KeyFile, run_admin},
    config::ServerConfig,
    grpc::pb,
    runner,
};
use somework_client::Client;
use somework_core::ErrorCode;
use tonic::transport::Channel;

fn write_config(dir: &Path) -> std::path::PathBuf {
    let path = dir.join("server.toml");
    std::fs::write(
        &path,
        format!(
            "[domain]\nid = \"development\"\ndb = \"{db}\"\nlisten = \"127.0.0.1:0\"\npublic_url = \"auto\"\nsynchronous_full = false\nmaintenance_interval_ms = 100\n\n[objects]\ndir = \"{objects}\"\n\n[grpc]\nlisten = \"127.0.0.1:0\"\nreflection = false\n",
            db = dir.join("somework.db").display(),
            objects = dir.join("objects").display()
        ),
    )
    .unwrap();
    path
}

fn client_for(url: &str, key_file: &Path) -> Client {
    let kf = KeyFile::read(key_file).unwrap();
    Client::assertion(url, kf.signing_key().unwrap(), &kf.kind, &kf.id, &kf.domain_id)
}

async fn eventually<T, F, Fut>(what: &str, mut probe: F) -> T
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    for _ in 0..100 {
        if let Some(found) = probe().await {
            return found;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test]
async fn enrolled_producers_and_deployers_drive_a_rule_to_a_task_over_rest_and_grpc() {
    let dir = tempfile::tempdir().unwrap();
    let config = write_config(dir.path());
    let key = |name: &str| dir.path().join(format!("{name}.key.json"));

    run_admin(&config, AdminCommand::Bootstrap { name: "root".into(), key_out: key("root") }).await.unwrap();
    run_admin(
        &config,
        AdminCommand::EnrollService {
            id: "deployer/rules".into(),
            actions: vec!["rules.manage".into()],
            clearance: "internal".into(),
            key_out: Some(key("deployer")),
            public_key: None,
        },
    )
    .await
    .unwrap();
    run_admin(
        &config,
        AdminCommand::EnrollService {
            id: "ops/controller".into(),
            actions: vec!["rules.control".into()],
            clearance: "internal".into(),
            key_out: Some(key("controller")),
            public_key: None,
        },
    )
    .await
    .unwrap();
    run_admin(
        &config,
        AdminCommand::EnrollProducer {
            id: "producer/github".into(),
            publish: vec!["github.*".into()],
            clearance: "internal".into(),
            key_out: Some(key("producer")),
            public_key: None,
        },
    )
    .await
    .unwrap();
    run_admin(
        &config,
        AdminCommand::EnrollAgent {
            id: "automation/pr-review".into(),
            side_effects: "read".into(),
            classification: "internal".into(),
            may_invoke: vec!["code.review".into()],
            key_out: Some(key("automation")),
            public_key: None,
        },
    )
    .await
    .unwrap();
    run_admin(
        &config,
        AdminCommand::EnrollAgent {
            id: "agent/reviewer".into(),
            side_effects: "read".into(),
            classification: "internal".into(),
            may_invoke: vec![],
            key_out: Some(key("reviewer")),
            public_key: None,
        },
    )
    .await
    .unwrap();
    let card = dir.path().join("reviewer-card.json");
    std::fs::write(
        &card,
        somework_testkit::card("agent/reviewer", "development", vec![somework_testkit::capability("code.review", "2.1", "read", "Review pull requests")])
            .to_string(),
    )
    .unwrap();
    run_admin(&config, AdminCommand::RegisterCard { card, approve: true }).await.unwrap();

    let runtime = runner::start(ServerConfig::load(&config).unwrap()).await.unwrap();
    let url = runtime.url();
    let deployer = client_for(&url, &key("deployer"));
    let producer = client_for(&url, &key("producer"));
    let automation = client_for(&url, &key("automation"));
    let controller = client_for(&url, &key("controller"));
    let reviewer = client_for(&url, &key("reviewer")).with_runtime(somework_core::ids::runtime_instance_id());
    reviewer.register_runtime(json!({})).await.unwrap();

    // the deployer applies a rule; nobody else may
    let rule = json!({
        "owner": "automation/pr-review",
        "selector": "github.pull_request.opened",
        "where": [{"path": "/data/draft", "equals": false}],
        "reaction": {"capability": {"id": "code.review", "version": 2.1}, "input": {"repository": "${/data/repository}"}, "budget": {"maxTokens": 1000, "maxMinutes": 5}}
    });
    assert_eq!(automation.put_rule("pr-review", &rule).await.unwrap_err().code, ErrorCode::PolicyDenied);
    let stored = deployer.put_rule("pr-review", &rule).await.unwrap();
    assert_eq!(stored["status"], "active");
    assert_eq!(stored["reaction"]["capability"]["version"], "2.1");
    assert_eq!(stored["reaction"]["maxDepth"], 3);
    assert_eq!(deployer.put_rule("pr-review", &rule).await.unwrap()["updatedAt"], stored["updatedAt"], "a repeated PUT changes nothing");
    assert_eq!(deployer.list_rules().await.unwrap().len(), 1);

    // the producer may publish github.* only
    let event =
        json!({"topic": "github.pull_request.opened", "key": "delivery-1", "data": {"draft": false, "repository": "billing/import-service"}, "verified": true});
    let first = producer.publish_event(&event).await.unwrap();
    assert_eq!(first["duplicate"], false);
    let again = producer.publish_event(&event).await.unwrap();
    assert_eq!((again["duplicate"].clone(), again["seq"].clone()), (json!(true), first["seq"].clone()));
    assert_eq!(producer.publish_event(&json!({"topic": "jira.issue.created", "key": "x"})).await.unwrap_err().code, ErrorCode::PolicyDenied);
    assert_eq!(producer.list_rules().await.unwrap_err().code, ErrorCode::PolicyDenied);

    // gRPC sees the same dedupe state
    let grpc_addr = runtime.grpc_addr.expect("grpc listener");
    let channel = Channel::from_shared(format!("http://{grpc_addr}")).unwrap().connect().await.unwrap();
    let producer_key = KeyFile::read(&key("producer")).unwrap();
    let creds = Creds { key: Arc::new(producer_key.signing_key().unwrap()), issuer: "service:producer/github".into(), runtime: None };
    let mut events = pb::event_service_client::EventServiceClient::with_interceptor(channel, creds);
    let data = prost_types_struct(&json!({"draft": false, "repository": "billing/import-service"}));
    let replay = events
        .publish(with_md(
            pb::PublishEventRequest { topic: "github.pull_request.opened".into(), key: "delivery-1".into(), data: Some(data.clone()), ..Default::default() },
            &[],
        ))
        .await
        .unwrap()
        .into_inner();
    assert!(replay.duplicate);
    assert_eq!(replay.seq, first["seq"].as_i64().unwrap());
    let fresh = events
        .publish(with_md(
            pb::PublishEventRequest { topic: "github.pull_request.opened".into(), key: "delivery-2".into(), data: Some(data), ..Default::default() },
            &[],
        ))
        .await
        .unwrap()
        .into_inner();
    assert!(!fresh.duplicate);
    let denied =
        events.publish(with_md(pb::PublishEventRequest { topic: "jira.issue.created".into(), key: "k".into(), ..Default::default() }, &[])).await.unwrap_err();
    assert_eq!(denied.code(), tonic::Code::PermissionDenied);

    // the server's own reaction worker created one task per distinct delivery (two keys → two tasks), none for the replay
    let tasks = eventually("the reactions to start tasks", || {
        let automation = automation.clone();
        async move {
            let v = automation.get("/v1/tasks").await.ok()?;
            let tasks = v["tasks"].as_array()?.clone();
            (tasks.len() == 2).then_some(tasks)
        }
    })
    .await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(automation.get("/v1/tasks").await.unwrap()["tasks"].as_array().unwrap().len(), 2);
    let task_id = tasks[0]["taskId"].as_str().unwrap().to_string();
    let task = automation.get(&format!("/v1/tasks/{task_id}")).await.unwrap();
    assert_eq!(task["origin"]["kind"], "reaction");
    assert_eq!(task["origin"]["rule"], "pr-review");
    assert_eq!(task["input"]["budget"], json!({"maxTokens": 1000, "maxMinutes": 5}));

    // the reviewer works the task like any other
    let claim = reviewer.claim_task(&task_id, None).await.unwrap();
    reviewer.progress_task(&task_id, &json!({"fencingToken": claim.fencing_token, "message": "reading"})).await.unwrap();
    let done = reviewer.complete_task(&task_id, claim.fencing_token, &json!({"verdict": "approve"}), &[]).await.unwrap();
    assert_eq!(done.state, somework_core::fsm::TaskState::Succeeded);

    let counters = deployer.get_rule("pr-review").await.unwrap()["counters"].clone();
    assert_eq!(counters["fired"], 2);

    // the controller (rules.control only) can read and pause/resume, but neither change nor remove a rule
    assert_eq!(controller.list_rules().await.unwrap().len(), 1);
    assert_eq!(controller.get("/v1/rules/pr-review/firings").await.unwrap()["firings"].as_array().unwrap().len(), 2);
    assert_eq!(controller.put_rule("pr-review", &rule).await.unwrap_err().status, 403);
    assert_eq!(controller.put_rule("other", &rule).await.unwrap_err().status, 403);
    assert_eq!(controller.delete_rule("pr-review").await.unwrap_err().status, 403);
    assert_eq!(controller.pause_rule("pr-review").await.unwrap()["status"], "paused");
    assert_eq!(controller.resume_rule("pr-review").await.unwrap()["status"], "active");

    // pause stops it, delete removes it
    assert_eq!(deployer.pause_rule("pr-review").await.unwrap()["status"], "paused");
    producer.publish_event(&json!({"topic": "github.pull_request.opened", "key": "delivery-3", "data": {"draft": false, "repository": "r"}})).await.unwrap();
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(automation.get("/v1/tasks").await.unwrap()["tasks"].as_array().unwrap().len(), 2);
    deployer.delete_rule("pr-review").await.unwrap();
    assert_eq!(deployer.get_rule("pr-review").await.unwrap_err().code, ErrorCode::NotFound);

    // set-publish-permissions narrows the producer
    run_admin(
        &config,
        AdminCommand::SetPublishPermissions { id: "producer/github".into(), publish: vec!["github.push.*".into()], clearance: "internal".into() },
    )
    .await
    .unwrap();
    assert_eq!(
        producer.publish_event(&json!({"topic": "github.pull_request.opened", "key": "late", "data": {}})).await.unwrap_err().code,
        ErrorCode::PolicyDenied
    );
    assert!(producer.publish_event(&json!({"topic": "github.push.main", "key": "p1", "data": {}})).await.is_ok());

    runtime.stop().await;
}

fn prost_types_struct(v: &Value) -> prost_types::Struct {
    somework_api::grpc::json_to_struct(v).expect("object")
}
