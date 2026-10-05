mod common;

use common::*;
use serde_json::{Value, json};
use somework_core::{ErrorCode, contracts::*, fsm::TaskState};
use somework_domain::{
    artifacts::{BeginUpload, DownloadRequest},
    context::{AcceptRequest, OfferRequest},
    messages::MemberRef,
    tasks::{ClaimRequest, ProgressRequest},
};

fn pack(extra: Value) -> Value {
    let mut p = json!({
        "objective": "Diagnose and fix the invoice-import regression",
        "acceptanceCriteria": ["Regression test fails before the fix and passes after"],
        "currentState": {"summary": "Failure isolated to date parsing", "completed": ["Reproduced"], "remaining": ["Patch"]},
        "facts": [{"statement": "Reproduces at 61a8d52", "confidence": 1.0, "assertedBy": {"kind": "agent", "id": "agent/a", "domainId": "development"}}],
        "hypotheses": [{"statement": "Culture-dependent parsing", "confidence": 0.7}],
        "decisions": [{"decision": "Keep investigation read-only", "rationale": "Shared production path"}],
        "openQuestions": ["Was the change intentional?"],
        "requestedContinuation": {"mode": "consultation", "instruction": "Verify the hypothesis"},
        "security": {"classification": "internal", "allowedDomains": ["development"], "instructionsTrusted": false},
    });
    if let (Some(o), Some(e)) = (p.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            o.insert(k.clone(), v.clone());
        }
    }
    p
}

async fn agents() -> (Env, Principal, Principal) {
    let env = Env::new().await;
    let a = env.worker("agent/a", vec![capability("code.review", "2.1", "read", "Review")], worker_permissions(SideEffects::Read)).await;
    let b = env.worker("agent/b", vec![capability("code.review", "2.1", "read", "Review")], worker_permissions(SideEffects::Read)).await;
    (env, a, b)
}

#[tokio::test]
async fn context_packs_are_immutable_versioned_and_digest_checked() {
    let (env, a, _b) = agents().await;
    let ca = env.ctx(&a).await;
    let v1 = env.domain.create_context_pack(&ca, pack(json!({"contextPackId": "ctxp_inv", "version": 1}))).await.unwrap();
    assert_eq!(v1.version, 1);
    let dup = env.domain.create_context_pack(&ca, pack(json!({"contextPackId": "ctxp_inv", "version": 1}))).await.unwrap_err();
    assert_eq!(dup.code, ErrorCode::Conflict);
    let v2 = env.domain.create_context_pack(&ca, pack(json!({"contextPackId": "ctxp_inv"}))).await.unwrap();
    assert_eq!(v2.version, 2);
    let bad_digest = env.domain.create_context_pack(&ca, pack(json!({"digest": "0".repeat(64)}))).await.unwrap_err();
    assert_eq!(bad_digest.code, ErrorCode::ValidationFailed);
    let mut trusted = pack(json!({}));
    trusted["security"]["instructionsTrusted"] = json!(true);
    assert_eq!(
        env.domain.create_context_pack(&ca, trusted).await.unwrap_err().code,
        ErrorCode::SchemaViolation,
        "imported context is data, never trusted instructions (CTX-05)"
    );
    assert!(sqlx::query("UPDATE context_packs SET manifest = '{}'").execute(env.domain.db.pool()).await.is_err());
}

#[tokio::test]
async fn oversized_packs_must_reference_artifacts_instead_of_embedding() {
    let (env, a, _b) = agents().await;
    let big: Vec<Value> = (0..400).map(|i| json!({"statement": format!("{i}: {}", "y".repeat(100)), "confidence": 0.5, "assertedBy": {"kind": "agent", "id": "agent/a", "domainId": "development"}})).collect();
    let err = env.domain.create_context_pack(&env.ctx(&a).await, pack(json!({"facts": big}))).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::PayloadTooLarge);
}

#[tokio::test]
async fn receiver_sees_a_manifest_first_and_only_the_disclosed_sections() {
    let (env, a, b) = agents().await;
    let ca = env.ctx(&a).await;
    let created = env.domain.create_context_pack(&ca, pack(json!({}))).await.unwrap();
    // before any offer the pack does not exist for b
    let cb = env.ctx(&b).await;
    assert_eq!(env.domain.get_context_pack(&cb, &created.context_pack_id, 1, None, None).await.unwrap_err().code, ErrorCode::NotFound);

    let offer = env
        .domain
        .offer_context(
            &ca,
            &created.context_pack_id,
            1,
            OfferRequest {
                to: Some(MemberRef { kind: ActorKind::Agent, id: "agent/b".into() }),
                sections: Some(vec!["facts".into(), "openQuestions".into()]),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(offer.mode, "consultation");
    // the offer message carries a compact manifest and wakes the receiver
    let woken = env.domain.list_events(&cb, 0, 20).await.unwrap();
    assert!(woken.iter().any(|e| e.payload["messageType"] == "context.offer" && e.wake));

    let manifest = env.domain.get_context_pack(&cb, &created.context_pack_id, 1, None, None).await.unwrap();
    assert!(manifest.pack.get("hypotheses").is_none() && manifest.pack.get("objective").is_some());
    let facts = env.domain.get_context_pack(&cb, &created.context_pack_id, 1, Some(vec!["facts".into()]), None).await.unwrap();
    assert_eq!(facts.disclosed_sections, ["facts"]);
    let hypotheses = env.domain.get_context_pack(&cb, &created.context_pack_id, 1, Some(vec!["hypotheses".into()]), None).await.unwrap();
    assert_eq!(hypotheses.withheld_sections, ["hypotheses"]);
    assert!(hypotheses.pack.get("hypotheses").is_none());
    assert_eq!(hypotheses.section_index["hypotheses"]["present"], true);

    // the receiver cannot forward sections it was never given
    let c = env.create_principal(ActorKind::Agent, "agent/c", None).await;
    let forward = env
        .domain
        .offer_context(
            &cb,
            &created.context_pack_id,
            1,
            OfferRequest { to: Some(MemberRef { kind: ActorKind::Agent, id: "agent/c".into() }), ..Default::default() },
        )
        .await
        .unwrap_err();
    assert_eq!(forward.code, ErrorCode::NotFound);
    let _ = c;
    let accepted =
        env.domain.accept_context(&cb, &created.context_pack_id, 1, AcceptRequest { offer_id: offer.offer_id.clone(), ..Default::default() }).await.unwrap();
    assert_eq!(accepted.offer.status, "accepted");
    assert!(accepted.task.is_none(), "a consultation never changes ownership");
}

#[tokio::test]
async fn clearance_and_allowed_domains_gate_context_disclosure() {
    let (env, a, _b) = agents().await;
    let ca = env.ctx(&a).await;
    let mut restricted = pack(json!({}));
    restricted["security"]["classification"] = json!("restricted");
    let mut perms = somework_domain::policy::Permissions::default_agent();
    perms.classification_max = Some("restricted".into());
    let high = env.create_principal(ActorKind::Agent, "agent/high", Some(perms)).await;
    let created = env.domain.create_context_pack(&env.ctx(&high).await, restricted).await.unwrap();
    // internal-cleared a cannot read or be offered it
    assert_eq!(env.domain.get_context_pack(&ca, &created.context_pack_id, 1, None, None).await.unwrap_err().code, ErrorCode::NotFound);
    let offer_err = env
        .domain
        .offer_context(
            &env.ctx(&high).await,
            &created.context_pack_id,
            1,
            OfferRequest { to: Some(MemberRef { kind: ActorKind::Agent, id: "agent/a".into() }), ..Default::default() },
        )
        .await
        .unwrap_err();
    assert_eq!(offer_err.code, ErrorCode::PolicyDenied);

    let mut elsewhere = pack(json!({}));
    elsewhere["security"]["allowedDomains"] = json!(["operations"]);
    let created = env.domain.create_context_pack(&ca, elsewhere).await.unwrap();
    let err = env
        .domain
        .offer_context(
            &ca,
            &created.context_pack_id,
            1,
            OfferRequest { to: Some(MemberRef { kind: ActorKind::Agent, id: "agent/b".into() }), ..Default::default() },
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::PolicyDenied, "the pack does not allow this domain");
}

#[tokio::test]
async fn ownership_transfer_requires_acceptance_and_moves_the_fence_atomically() {
    let (env, a, b) = agents().await;
    let requester = env.create_principal(ActorKind::Agent, "agent/req", Some(caller_permissions(&["code.review"], SideEffects::Read))).await;
    let task = env.domain.submit_task(&env.ctx(&requester).await, submit("code.review", "2.1")).await.unwrap().task.task.task_id;
    let ca = env.ctx(&a).await;
    env.domain.claim_task(&ca, &task, ClaimRequest::default()).await.unwrap();
    env.domain.progress_task(&ca, &task, ProgressRequest { fencing_token: Some(1), ..Default::default() }).await.unwrap();
    let mut transfer = pack(json!({"provenance": {"createdBy": {"kind": "agent", "id": "agent/a", "domainId": "development"}, "sourceTaskId": task}}));
    transfer["requestedContinuation"] = json!({"mode": "ownership_transfer", "instruction": "Take over the review"});
    let created = env.domain.create_context_pack(&ca, transfer).await.unwrap();
    let offer = env
        .domain
        .offer_context(
            &ca,
            &created.context_pack_id,
            1,
            OfferRequest { to: Some(MemberRef { kind: ActorKind::Agent, id: "agent/b".into() }), task_id: Some(task.clone()), ..Default::default() },
        )
        .await
        .unwrap();

    // until b accepts, a remains the owner and can keep working
    let view = env.domain.get_task(&ca, &task).await.unwrap();
    assert_eq!(view.task.assignee.as_ref().unwrap().id, "agent/a");
    env.domain.progress_task(&ca, &task, ProgressRequest { fencing_token: Some(1), message: Some("still mine".into()), ..Default::default() }).await.unwrap();

    let cb = env.ctx(&b).await;
    let accepted =
        env.domain.accept_context(&cb, &created.context_pack_id, 1, AcceptRequest { offer_id: offer.offer_id.clone(), ..Default::default() }).await.unwrap();
    assert_eq!(accepted.fencing_token, Some(2));
    let after = env.domain.get_task(&cb, &task).await.unwrap();
    assert_eq!(after.task.assignee.as_ref().unwrap().id, "agent/b");
    assert_eq!(after.task.state, TaskState::Running);
    // the previous owner is fenced out
    let stale = env.domain.progress_task(&ca, &task, ProgressRequest { fencing_token: Some(1), ..Default::default() }).await.unwrap_err();
    assert_eq!(stale.code, ErrorCode::StaleFencingToken);
    env.domain.progress_task(&cb, &task, ProgressRequest { fencing_token: Some(2), ..Default::default() }).await.unwrap();
    // an offer cannot be accepted twice
    assert_eq!(
        env.domain.accept_context(&cb, &created.context_pack_id, 1, AcceptRequest { offer_id: offer.offer_id, ..Default::default() }).await.unwrap_err().code,
        ErrorCode::InvalidTransition
    );
}

#[tokio::test]
async fn transfer_fails_if_the_offerer_lost_the_task_in_the_meantime() {
    let (env, a, b) = agents().await;
    let requester = env.create_principal(ActorKind::Agent, "agent/req", Some(caller_permissions(&["code.review"], SideEffects::Read))).await;
    let task = env.domain.submit_task(&env.ctx(&requester).await, submit("code.review", "2.1")).await.unwrap().task.task.task_id;
    let ca = env.ctx(&a).await;
    env.domain.claim_task(&ca, &task, ClaimRequest { lease_seconds: Some(5), ..Default::default() }).await.unwrap();
    env.domain.progress_task(&ca, &task, ProgressRequest { fencing_token: Some(1), ..Default::default() }).await.unwrap();
    let mut transfer = pack(json!({}));
    transfer["requestedContinuation"] = json!({"mode": "ownership_transfer", "instruction": "x"});
    let created = env.domain.create_context_pack(&ca, transfer).await.unwrap();
    let offer = env
        .domain
        .offer_context(
            &ca,
            &created.context_pack_id,
            1,
            OfferRequest { to: Some(MemberRef { kind: ActorKind::Agent, id: "agent/b".into() }), task_id: Some(task.clone()), ..Default::default() },
        )
        .await
        .unwrap();
    env.advance(30);
    env.domain.run_maintenance().await.unwrap();
    let err = env
        .domain
        .accept_context(&env.ctx(&b).await, &created.context_pack_id, 1, AcceptRequest { offer_id: offer.offer_id, ..Default::default() })
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict, "never both-own and never silently adopt a task the sender lost");
}

#[tokio::test]
async fn artifacts_are_digest_verified_before_use() {
    let (env, a, _b) = agents().await;
    let data = b"hello artifact".to_vec();
    let aref = env.upload(&a, "hello.txt", "internal", &data, None).await;
    assert_eq!(aref.size_bytes, data.len() as u64);
    assert!(aref.uri.starts_with("artifact://development/"));

    // wrong bytes under a declared digest -> integrity failure, never usable
    use sha2::{Digest, Sha256};
    let ca = env.ctx(&a).await;
    let grant = env
        .domain
        .begin_artifact_upload(
            &ca,
            BeginUpload {
                media_type: Some("text/plain".into()),
                size_bytes: Some(5),
                sha256: Some(hex::encode(Sha256::digest(b"right"))),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    env.fs.put_with_grant(grant.plan.url.rsplit("/v1/objects/").next().unwrap(), b"wrong".to_vec()).await.unwrap();
    let err = env.domain.complete_artifact_upload(&ca, &grant.artifact_id, Default::default()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::IntegrityFailure);
    let grant_err = env.domain.artifact_download_grant(&ca, &grant.artifact_id, 1, DownloadRequest::default()).await.unwrap_err();
    assert_eq!(grant_err.code, ErrorCode::ArtifactNotReady, "a failed upload can never be downloaded");
    // completed objects are immutable: a second PUT to the same key is refused
    let token = aref.uri.clone();
    let _ = token;
    let again = env
        .domain
        .begin_artifact_upload(
            &ca,
            BeginUpload {
                artifact_id: Some(aref.artifact_id.clone()),
                media_type: Some("text/plain".into()),
                size_bytes: Some(1),
                sha256: Some(hex::encode(Sha256::digest(b"z"))),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(again.version, 2, "new bytes get a new immutable version");
}

#[tokio::test]
async fn result_artifacts_must_be_complete_before_a_task_can_succeed() {
    let (env, a, _b) = agents().await;
    let requester = env.create_principal(ActorKind::Agent, "agent/req", Some(caller_permissions(&["code.review"], SideEffects::Read))).await;
    let task = env.domain.submit_task(&env.ctx(&requester).await, submit("code.review", "2.1")).await.unwrap().task.task.task_id;
    let ca = env.ctx(&a).await;
    env.domain.claim_task(&ca, &task, ClaimRequest::default()).await.unwrap();
    env.domain.progress_task(&ca, &task, ProgressRequest { fencing_token: Some(1), ..Default::default() }).await.unwrap();
    use sha2::{Digest, Sha256};
    let pending = env
        .domain
        .begin_artifact_upload(
            &ca,
            BeginUpload {
                media_type: Some("text/plain".into()),
                size_bytes: Some(3),
                sha256: Some(hex::encode(Sha256::digest(b"abc"))),
                source_task_id: Some(task.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let fake = ArtifactRef {
        artifact_id: pending.artifact_id.clone(),
        version: 1,
        uri: pending.uri.clone(),
        filename: None,
        media_type: "text/plain".into(),
        size_bytes: 3,
        digest: somework_core::contracts::Digest::sha256(hex::encode(Sha256::digest(b"abc"))),
        classification: "internal".into(),
        created_by: ca.actor.actor_ref(),
        created_at: env.domain.now_ts(),
        expires_at: None,
        source_task_id: None,
        provenance: None,
        encryption: None,
    };
    let err = env
        .domain
        .complete_task(
            &ca,
            &task,
            somework_domain::tasks::CompleteRequest {
                fencing_token: Some(1),
                result: Some(json!({"verdict": "approve"})),
                artifacts: vec![fake.clone()],
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::ArtifactNotReady);
    let real = env.upload(&a, "patch.diff", "internal", b"abc", Some(&task)).await;
    let done = env
        .domain
        .complete_task(
            &ca,
            &task,
            somework_domain::tasks::CompleteRequest {
                fencing_token: Some(1),
                result: Some(json!({"verdict": "approve"})),
                artifacts: vec![real.clone()],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(done.task.result_artifacts[0].digest.value, real.digest.value);
}

#[tokio::test]
async fn download_grants_respect_clearance_and_task_authority() {
    let (env, a, _b) = agents().await;
    let mut high_perms = somework_domain::policy::Permissions::default_agent();
    high_perms.classification_max = Some("restricted".into());
    let high = env.create_principal(ActorKind::Agent, "agent/high", Some(high_perms)).await;
    let secret = env.upload(&high, "secret.bin", "restricted", b"top secret", None).await;
    let ca = env.ctx(&a).await;
    let denied = env.domain.artifact_download_grant(&ca, &secret.artifact_id, 1, DownloadRequest::default()).await.unwrap_err();
    assert!(matches!(denied.code, ErrorCode::PolicyDenied | ErrorCode::NotFound), "{denied:?}");
    let own = env.domain.artifact_download_grant(&env.ctx(&high).await, &secret.artifact_id, 1, DownloadRequest::default()).await.unwrap();
    assert!(own.url.contains("/v1/objects/"));
    assert!(own.url.len() < 1024 && !own.url.contains("secret"), "grants are opaque signed URLs, not permanent credentials");
    env.advance(3600);
    let token = own.url.rsplit("/v1/objects/").next().unwrap();
    assert_eq!(env.fs.get_with_grant(token).await.unwrap_err().code, ErrorCode::Expired, "grants are short-lived");
}
