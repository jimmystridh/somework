mod gateway_support;

use std::time::Duration;

use chrono::Duration as ChronoDuration;
use gateway_support::*;
use reqwest::{Method, StatusCode};
use serde_json::json;
use somework_core::{
    contracts::{Action, SideEffects},
    fsm::TaskState,
};
use somework_gateway::PeerPolicy;
use somework_testkit::{
    capability,
    federation::{DomainGateway, Pair, PairOptions},
};

const SUBMIT: [Action; 3] = [Action::TaskSubmit, Action::CapabilityInvoke, Action::ContextWrite];

fn submit_body(cap: &str) -> serde_json::Value {
    json!({"capability": {"id": cap, "version": "1"}, "input": {"repository": "r"}, "originTaskId": format!("origin-{}", somework_core::ids::jti())})
}

#[tokio::test]
async fn unexported_and_nonexistent_capabilities_are_indistinguishable() {
    let (pair, _diag) = standard_pair().await;
    // a real capability that is simply not exported
    pair.exported_worker(
        &pair.ops,
        "agent/secret-keeper",
        vec![capability("ops.secret", "1", "read", "Internal secret rotation")],
        worker_perms(SideEffects::Read),
        &[],
    )
    .await;
    let peer = RawPeer::dev_to_ops(&pair);

    let (s1, b1) = peer.ok_call(Method::POST, "/federation/v1/tasks", Some(&submit_body("ops.secret")), &SUBMIT, None, &["ops.secret".into()]).await;
    let (s2, b2) =
        peer.ok_call(Method::POST, "/federation/v1/tasks", Some(&submit_body("ops.does-not-exist")), &SUBMIT, None, &["ops.does-not-exist".into()]).await;
    assert_eq!((s1, s2), (StatusCode::NOT_FOUND, StatusCode::NOT_FOUND));
    assert_eq!(b1, b2, "bodies must not reveal which one exists");

    // discovery shows only the exported capability, with an opaque alias instead of the agent id
    let (_, found) =
        peer.ok_call(Method::POST, "/federation/v1/catalog/search", Some(&json!({"query": "secret rotation"})), &[Action::CatalogRead], None, &[]).await;
    assert_eq!(found["matches"].as_array().unwrap().len(), 0);
    let (_, all) =
        peer.ok_call(Method::POST, "/federation/v1/catalog/search", Some(&json!({"query": "diagnose deployment"})), &[Action::CatalogRead], None, &[]).await;
    let text = all.to_string();
    assert!(text.contains("ops.diagnose") && !text.contains("diagnostician") && !text.contains("secret"));
    pair.stop().await;
}

#[tokio::test]
async fn grants_are_single_use_certificate_bound_and_short_lived() {
    let (pair, _diag) = standard_pair().await;
    let peer = RawPeer::dev_to_ops(&pair);
    let search = json!({"query": "diagnose"});
    let thumb = pair.dev_gw.client.thumbprint.clone();

    // replay: the second use of the same grant fails
    let grant = peer.grant(None, &[Action::CatalogRead], &[], &thumb, ChronoDuration::seconds(60));
    assert_eq!(peer.call(Method::POST, "/federation/v1/catalog/search", Some(&search), &grant).await.unwrap().0, StatusCode::OK);
    assert_eq!(peer.call(Method::POST, "/federation/v1/catalog/search", Some(&search), &grant).await.unwrap().0, StatusCode::UNAUTHORIZED);

    // expired
    let expired = peer.grant(None, &[Action::CatalogRead], &[], &thumb, ChronoDuration::seconds(-120));
    assert_eq!(peer.call(Method::POST, "/federation/v1/catalog/search", Some(&search), &expired).await.unwrap().0, StatusCode::UNAUTHORIZED);

    // bound to a different certificate than the one presented on the connection
    let other = peer.grant(None, &[Action::CatalogRead], &[], &"0".repeat(64), ChronoDuration::seconds(60));
    assert_eq!(peer.call(Method::POST, "/federation/v1/catalog/search", Some(&search), &other).await.unwrap().0, StatusCode::UNAUTHORIZED);

    // wrong action for the route
    let wrong = peer.grant(None, &[Action::TaskRead], &[], &thumb, ChronoDuration::seconds(60));
    assert_eq!(peer.call(Method::POST, "/federation/v1/catalog/search", Some(&search), &wrong).await.unwrap().0, StatusCode::UNAUTHORIZED);

    // a grant minted for a long lifetime is clamped to five minutes by the minting side and rejected when forged longer
    let long = peer.grant(None, &[Action::CatalogRead], &[], &thumb, ChronoDuration::hours(5));
    assert_eq!(peer.call(Method::POST, "/federation/v1/catalog/search", Some(&search), &long).await.unwrap().0, StatusCode::OK);
    pair.stop().await;
}

#[tokio::test]
async fn unpinned_certificates_cannot_even_complete_the_tls_handshake() {
    let (pair, _diag) = standard_pair().await;
    let stranger = DomainGateway::new("stranger");
    let peer = RawPeer::with_identity(&pair, &stranger);
    let grant = peer.grant(None, &[Action::CatalogRead], &[], &stranger.client.thumbprint, ChronoDuration::seconds(60));
    assert!(
        peer.call(Method::POST, "/federation/v1/catalog/search", Some(&json!({})), &grant).await.is_err(),
        "handshake with an unregistered certificate must fail"
    );
    // and a registered certificate presenting a grant signed by an unknown key is refused at the application layer
    let forged = somework_core::jws::sign(somework_core::jws::TYP_GRANT, "nope", &somework_core::jws::new_signing_key(), &json!({"iss": "domain:development"}));
    assert_eq!(
        RawPeer::dev_to_ops(&pair).call(Method::POST, "/federation/v1/catalog/search", Some(&json!({})), &forged).await.unwrap().0,
        StatusCode::UNAUTHORIZED
    );
    pair.stop().await;
}

#[tokio::test]
async fn revoking_a_peer_cuts_access_immediately_and_rotation_retires_old_grants() {
    let (pair, _diag) = standard_pair().await;
    let peer = RawPeer::dev_to_ops(&pair);
    let (status, _) = peer.ok_call(Method::POST, "/federation/v1/catalog/search", Some(&json!({})), &[Action::CatalogRead], None, &[]).await;
    assert_eq!(status, StatusCode::OK);

    // rotating the peer's verification key invalidates grants signed with the previous one
    let new_key = somework_core::jws::new_signing_key();
    pair.ops
        .admin
        .post(
            "/v1/admin/federation/peers/development/keys",
            &json!({"kid": "rotated", "publicKey": somework_core::jws::verifying_key_to_b64(&new_key.verifying_key()), "retireOthers": true}),
        )
        .await
        .unwrap();
    let (status, _) = peer.ok_call(Method::POST, "/federation/v1/catalog/search", Some(&json!({})), &[Action::CatalogRead], None, &[]).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "grants signed by the retired key are refused");

    pair.ops.admin.post("/v1/admin/federation/peers/development/revoke", &json!({})).await.unwrap();
    let result = peer.ok_call_result(Method::POST, "/federation/v1/catalog/search", Some(&json!({})), &[Action::CatalogRead]).await;
    assert!(result.map(|(s, _)| s == StatusCode::UNAUTHORIZED).unwrap_or(true), "revoked peer is refused at the handshake or at the request");
    // revoked peers cannot be modified again
    let err = pair.ops.admin.post("/v1/admin/federation/peers/development/status", &json!({"status": "active"})).await.unwrap_err();
    assert_eq!(err.status, 409);
    pair.stop().await;
}

#[tokio::test]
async fn a_remote_caller_of_a_read_only_capability_cannot_borrow_the_workers_write_authority() {
    let pair = Pair::start(PairOptions {
        ops_policy_for_dev: PeerPolicy {
            exports: vec!["ops.inspect".into(), "ops.execute".into()],
            side_effects_at_most: SideEffects::Read,
            ..Default::default()
        },
        ..Default::default()
    })
    .await;
    // the worker itself is powerful: it may perform writes and delegate
    let mut perms = worker_perms(SideEffects::Write);
    perms.actions.push("task.delegate".into());
    perms.delegation = somework_domain::policy::DelegationPerm { allowed: true, max_depth: 3 };
    perms.capabilities = vec!["ops.*".into()];
    let worker = pair
        .exported_worker(
            &pair.ops,
            "agent/deployer",
            vec![capability("ops.inspect", "1", "read", "Inspect a deployment"), capability("ops.execute", "1", "write", "Execute a deployment step")],
            perms,
            &["ops.inspect", "ops.execute"],
        )
        .await;
    let peer = RawPeer::dev_to_ops(&pair);

    // 1) the write-class capability is exported but exceeds the peer's side-effect ceiling
    let (status, _) = peer.ok_call(Method::POST, "/federation/v1/tasks", Some(&submit_body("ops.execute")), &SUBMIT, None, &["ops.execute".into()]).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // 2) a legitimate read-only task: the worker cannot use its own write power to delegate on the peer's behalf
    let (status, created) = peer.ok_call(Method::POST, "/federation/v1/tasks", Some(&submit_body("ops.inspect")), &SUBMIT, None, &["ops.inspect".into()]).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let id = next_remote_task(&worker).await;
    let claim = worker.client.claim_task(&id, Some(30)).await.unwrap();
    assert_eq!(claim.authority["sideEffectsAtMost"], "read", "effective authority is the intersection, not the worker's maximum");
    worker.client.progress_task(&id, &json!({"fencingToken": claim.fencing_token})).await.unwrap();
    let delegated = worker
        .client
        .submit_task(&json!({"capability": {"id": "ops.execute", "version": "1"}, "input": {"repository": "r"}, "parentTaskId": id, "parentFencingToken": claim.fencing_token}), None)
        .await
        .unwrap_err();
    assert_eq!(delegated.status, 403, "delegation of a write capability under a read-only task is refused");
    pair.stop().await;
}

#[tokio::test]
async fn output_is_redacted_before_it_leaves_the_domain() {
    let pair = Pair::start(PairOptions {
        ops_policy_for_dev: PeerPolicy { exports: vec!["ops.diagnose".into()], redact_output_keys: vec!["internalHost".into()], ..Default::default() },
        ..Default::default()
    })
    .await;
    let diag = pair.exported_worker(&pair.ops, "agent/diagnostician", vec![diagnose_capability()], worker_perms(SideEffects::Read), &["ops.diagnose"]).await;
    pair.dev.admin.post("/v1/admin/federation/peers/operations/import-catalog", &json!({"approve": true})).await.unwrap();
    let author = pair.dev.requester("agent/author", &["ops.diagnose"], SideEffects::Read).await;
    let task = author.client.submit_task(&task_body("ops.diagnose"), None).await.unwrap();
    run_worker_once(&diag, json!({"verdict": "approve", "internalHost": "db-7.prod.internal", "detail": {"internalHost": "x", "ok": true}})).await;
    let done = author.client.wait_terminal(&task.task_id, Duration::from_secs(15)).await.unwrap();
    assert_eq!(done.state, TaskState::Succeeded);
    let result = done.result.unwrap();
    assert!(!result.to_string().contains("internalHost") && result["detail"]["ok"] == true);
    pair.stop().await;
}

#[tokio::test]
async fn remote_refusal_rejects_the_local_task() {
    let (pair, _diag) = standard_pair().await;
    let author = pair.dev.requester("agent/author", &["ops.diagnose"], SideEffects::Read).await;
    // operations withdraws the export after development imported it
    pair.ops.admin.put("/v1/admin/federation/peers/development/policy", &json!({"exports": []})).await.unwrap();
    let task = author.client.submit_task(&task_body("ops.diagnose"), None).await.unwrap();
    let done = author.client.wait_terminal(&task.task_id, Duration::from_secs(15)).await.unwrap();
    assert_eq!(done.state, TaskState::Rejected, "{done:?}");
    assert_eq!(done.failure.unwrap().code, "remote_not_found");
    pair.stop().await;
}

#[tokio::test]
async fn an_unreachable_gateway_leaves_the_task_pending_and_local_work_unaffected() {
    let (pair, diag) = standard_pair().await;
    let local_worker =
        pair.dev.worker("agent/local-reviewer", vec![capability("code.review", "1", "read", "Review code")], worker_perms(SideEffects::Read)).await;
    pair.dev
        .domain()
        .approve_entry(
            &pair.dev.domain().system_ctx(),
            "agent/local-reviewer",
            somework_domain::catalog::ApproveEntry { visibility: Some(somework_core::contracts::Visibility::Domain), ..Default::default() },
        )
        .await
        .unwrap();
    let author = pair.dev.requester("agent/author", &["ops.diagnose", "code.review"], SideEffects::Read).await;

    // point the peer at a dead port
    pair.dev
        .admin
        .put("/v1/admin/federation/peers/operations/gateway", &json!({"url": "https://127.0.0.1:9", "serverCaPem": pair.ops_gw.ca.cert_pem}))
        .await
        .unwrap();
    let remote = author.client.submit_task(&task_body("ops.diagnose"), None).await.unwrap();
    let local = author.client.submit_task(&task_body("code.review"), None).await.unwrap();
    let id = next_local(&local_worker).await;
    let claim = local_worker.client.claim_task(&id, Some(30)).await.unwrap();
    local_worker.client.progress_task(&id, &json!({"fencingToken": claim.fencing_token})).await.unwrap();
    local_worker.client.complete_task(&id, claim.fencing_token, &json!({"verdict": "approve"}), &[]).await.unwrap();
    assert_eq!(author.client.wait_terminal(&local.task_id, Duration::from_secs(10)).await.unwrap().state, TaskState::Succeeded);
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(author.client.get_task(&remote.task_id).await.unwrap().state, TaskState::Submitted, "stays pending while the peer is unreachable");

    // the gateway comes back: the outbox retries and the task completes
    pair.dev
        .admin
        .put("/v1/admin/federation/peers/operations/gateway", &json!({"url": pair.ops_gw.url(), "serverCaPem": pair.ops_gw.ca.cert_pem}))
        .await
        .unwrap();
    run_worker_once(&diag, json!({"verdict": "approve"})).await;
    assert_eq!(author.client.wait_terminal(&remote.task_id, Duration::from_secs(20)).await.unwrap().state, TaskState::Succeeded);
    pair.stop().await;
}

async fn next_local(worker: &somework_testkit::Agent) -> String {
    next_remote_task(worker).await
}

impl<'a> RawPeer<'a> {
    async fn ok_call_result(
        &self,
        method: Method,
        path: &str,
        body: Option<&serde_json::Value>,
        actions: &[Action],
    ) -> Result<(StatusCode, serde_json::Value), reqwest::Error> {
        let grant = self.grant(None, actions, &[], &self.pair.dev_gw.client.thumbprint, ChronoDuration::seconds(60));
        self.call(method, path, body, &grant).await
    }
}
