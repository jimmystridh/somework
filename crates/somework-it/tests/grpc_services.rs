//! Smoke coverage of the remaining gRPC services: messages, contexts, artifacts, delegation.

mod grpc_common;

use grpc_common::*;
use serde_json::json;
use sha2::{Digest, Sha256};
use somework_api::grpc::{pb, struct_to_json};
use somework_core::contracts::SideEffects;
use tonic::Code;

#[tokio::test]
async fn messages_send_and_list_with_trigger_rules() {
    let g = GrpcStack::start().await;
    let (worker, author) = g.review_pair().await;
    let (wc, ac) = (Creds::agent(&worker), Creds::agent(&author));
    let to_worker = vec![pb::Member { kind: "agent".into(), id: "agent/reviewer".into() }];
    let sent = g
        .messages(&ac)
        .send(with_md(
            pb::SendMessageRequest {
                recipients: to_worker.clone(),
                media_type: "text/plain".into(),
                data: Some(prost_types::Value { kind: Some(prost_types::value::Kind::StringValue("hello".into())) }),
                ..Default::default()
            },
            &[("idempotency-key", "m1")],
        ))
        .await
        .unwrap()
        .into_inner();
    assert_eq!(sent.r#type, "chat.message");
    assert_eq!(sent.trigger_mode, "directed");
    let replay = g
        .messages(&ac)
        .send(with_md(
            pb::SendMessageRequest {
                recipients: to_worker.clone(),
                media_type: "text/plain".into(),
                data: Some(prost_types::Value { kind: Some(prost_types::value::Kind::StringValue("hello".into())) }),
                ..Default::default()
            },
            &[("idempotency-key", "m1")],
        ))
        .await
        .unwrap()
        .into_inner();
    assert_eq!(replay.message_id, sent.message_id);

    // loop protection: notices can never wake an agent
    let notice = pb::SendMessageRequest {
        r#type: "chat.notice".into(),
        recipients: to_worker.clone(),
        media_type: "text/plain".into(),
        data: Some(prost_types::Value { kind: Some(prost_types::value::Kind::StringValue("working".into())) }),
        trigger_mode: "directed".into(),
        ..Default::default()
    };
    expect_err(g.messages(&ac).send(notice).await, Code::InvalidArgument, "trigger_not_allowed");
    // platform-emitted types cannot be sent by callers
    expect_err(
        g.messages(&ac)
            .send(pb::SendMessageRequest {
                r#type: "task.result".into(),
                recipients: to_worker,
                media_type: "text/plain".into(),
                data: Some(Default::default()),
                ..Default::default()
            })
            .await,
        Code::InvalidArgument,
        "validation_failed",
    );

    let page =
        g.messages(&wc).list(pb::ListMessagesRequest { conversation_id: sent.conversation_id.clone(), ..Default::default() }).await.unwrap().into_inner();
    assert_eq!(page.messages.len(), 1);
    assert_eq!(struct_to_json(page.messages[0].envelope.clone().unwrap())["content"]["data"], "hello");
    g.stack.stop().await;
}

#[tokio::test]
async fn context_pack_create_offer_accept_and_artifact_roundtrip() {
    let g = GrpcStack::start().await;
    let (worker, author) = g.review_pair().await;
    let (wc, ac) = (Creds::agent(&worker), Creds::agent(&author));

    // artifact: begin -> PUT with the presigned grant -> complete (digest verified) -> download grant -> bytes verify
    let bytes = b"fn main() { println!(\"repro\"); }".to_vec();
    let sha = hex::encode(Sha256::digest(&bytes));
    let grant = g
        .artifacts(&ac)
        .begin_upload(pb::BeginUploadRequest {
            filename: "repro.rs".into(),
            media_type: "text/x-rust".into(),
            size_bytes: bytes.len() as u64,
            sha256: sha.clone(),
            classification: "internal".into(),
            ..Default::default()
        })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(grant.method, "PUT");
    let put = reqwest::Client::new().put(&grant.url).body(bytes.clone()).send().await.unwrap();
    assert!(put.status().is_success());
    let meta = g
        .artifacts(&ac)
        .complete_upload(pb::CompleteUploadRequest { artifact_id: grant.artifact_id.clone(), version: grant.version, parts: vec![] })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(meta.sha256, sha);
    let fetched = g
        .artifacts(&ac)
        .get_metadata(pb::GetArtifactRequest { artifact_id: grant.artifact_id.clone(), version: grant.version, ..Default::default() })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(fetched.size_bytes, bytes.len() as u64);
    let download = g
        .artifacts(&ac)
        .get_download(pb::GetDownloadRequest { artifact_id: grant.artifact_id.clone(), version: grant.version, ..Default::default() })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(reqwest::get(&download.url).await.unwrap().bytes().await.unwrap().to_vec(), bytes);
    // a digest that does not match the uploaded bytes is rejected before the artifact becomes usable
    let bad = g
        .artifacts(&ac)
        .begin_upload(pb::BeginUploadRequest {
            media_type: "text/plain".into(),
            size_bytes: 3,
            sha256: "0".repeat(64),
            classification: "internal".into(),
            ..Default::default()
        })
        .await
        .unwrap()
        .into_inner();
    reqwest::Client::new().put(&bad.url).body("abc").send().await.unwrap();
    expect_err(
        g.artifacts(&ac).complete_upload(pb::CompleteUploadRequest { artifact_id: bad.artifact_id, version: bad.version, parts: vec![] }).await,
        Code::InvalidArgument,
        "integrity_failure",
    );

    // context pack: create (digest computed), manifest view, offer, accept
    let pack = json!({
        "objective": "Verify the date-parsing hypothesis",
        "currentState": {"summary": "reproduced", "completed": ["repro"], "remaining": ["patch"]},
        "facts": [{"statement": "repro fails at 61a8d52", "confidence": 1.0, "assertedBy": {"kind": "agent", "id": "agent/author", "domainId": "development"}}],
        "requestedContinuation": {"mode": "consultation", "instruction": "review the hypothesis"},
        "security": {"classification": "internal", "allowedDomains": ["development"], "instructionsTrusted": false},
        "artifacts": [struct_to_json(meta.artifact.clone().unwrap())]
    });
    let record = g.contexts(&ac).create(pb::CreateContextPackRequest { pack: Some(struct_of(pack)) }).await.unwrap().into_inner();
    assert_eq!(record.version, 1);
    assert_eq!(record.digest.len(), 64);
    let offer = g
        .contexts(&ac)
        .offer(pb::OfferContextRequest {
            context_pack_id: record.context_pack_id.clone(),
            version: 1,
            to: Some(pb::Member { kind: "agent".into(), id: "agent/reviewer".into() }),
            sections: vec!["facts".into()],
            ..Default::default()
        })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(offer.status, "pending");
    assert_eq!(offer.mode, "consultation");

    // the receiver sees the manifest, plus only the sections the offerer disclosed
    let manifest = g
        .contexts(&wc)
        .get(pb::GetContextPackRequest { context_pack_id: record.context_pack_id.clone(), version: 1, ..Default::default() })
        .await
        .unwrap()
        .into_inner();
    assert!(manifest.withheld_sections.is_empty());
    let facts = g
        .contexts(&wc)
        .get(pb::GetContextPackRequest { context_pack_id: record.context_pack_id.clone(), version: 1, sections: vec!["facts".into()], ..Default::default() })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(facts.disclosed_sections, ["facts"]);
    let decisions = g
        .contexts(&wc)
        .get(pb::GetContextPackRequest {
            context_pack_id: record.context_pack_id.clone(),
            version: 1,
            sections: vec!["decisions".into()],
            ..Default::default()
        })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(decisions.withheld_sections, ["decisions"]);

    let accepted = g
        .contexts(&wc)
        .accept(pb::AcceptContextRequest {
            context_pack_id: record.context_pack_id.clone(),
            version: 1,
            offer_id: offer.offer_id.clone(),
            ..Default::default()
        })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(accepted.offer.unwrap().status, "accepted");
    expect_err(
        g.contexts(&wc)
            .accept(pb::AcceptContextRequest { context_pack_id: record.context_pack_id, version: 1, offer_id: offer.offer_id, ..Default::default() })
            .await,
        Code::FailedPrecondition,
        "invalid_transition",
    );
    g.stack.stop().await;
}

#[tokio::test]
async fn delegation_mints_only_narrower_grants() {
    let g = GrpcStack::start().await;
    let mut perms = worker_perms(SideEffects::Read);
    perms.delegation = somework_domain::policy::DelegationPerm { allowed: true, max_depth: 3 };
    perms.actions.push("task.delegate".into());
    let worker = g.stack.worker("agent/reviewer", vec![somework_testkit::capability("code.review", "2.1", "read", "Review pull requests")], perms).await;
    let mut author_perms = worker_perms(SideEffects::Read);
    author_perms.capabilities = vec!["code.review".into()];
    author_perms.delegation = somework_domain::policy::DelegationPerm { allowed: true, max_depth: 3 };
    let author_key = g.stack.create_principal(somework_core::contracts::ActorKind::Agent, "agent/author", author_perms).await;
    let (wc, ac) = (Creds::agent(&worker), Creds { key: author_key, issuer: "agent:agent/author".into(), runtime: None });

    // an ordinary workload assertion carries no grant to delegate from
    expect_err(
        g.authorization(&wc)
            .delegate(pb::DelegateRequest {
                subject: Some(pb::Member { kind: "agent".into(), id: "agent/author".into() }),
                actions: vec!["task.read".into()],
                ..Default::default()
            })
            .await,
        Code::PermissionDenied,
        "policy_denied",
    );

    let task = g.tasks(&ac).submit(submit_req()).await.unwrap().into_inner().task.unwrap();
    let claim = g.tasks(&wc).claim(pb::ClaimTaskRequest { task_id: task.task_id.clone(), lease_seconds: 30, ..Default::default() }).await.unwrap().into_inner();
    // present the task grant itself as the bearer credential
    let grant_creds = BearerOnly(claim.authorization_token.clone());
    let mut auth = pb::authorization_service_client::AuthorizationServiceClient::with_interceptor(g.channel.clone(), grant_creds.clone());
    let child = auth
        .delegate(pb::DelegateRequest {
            subject: Some(pb::Member { kind: "agent".into(), id: "agent/author".into() }),
            actions: vec!["task.read".into()],
            ttl_seconds: 60,
            ..Default::default()
        })
        .await
        .unwrap()
        .into_inner();
    assert!(!child.parent_jti.is_empty());
    // widening beyond the parent grant is refused
    let wider = auth
        .delegate(pb::DelegateRequest {
            subject: Some(pb::Member { kind: "agent".into(), id: "agent/author".into() }),
            actions: vec!["task.cancel".into()],
            ..Default::default()
        })
        .await;
    assert_eq!(wider.unwrap_err().code(), Code::PermissionDenied);
    g.stack.stop().await;
}

#[derive(Clone)]
struct BearerOnly(String);

impl tonic::service::Interceptor for BearerOnly {
    fn call(&mut self, mut req: tonic::Request<()>) -> Result<tonic::Request<()>, tonic::Status> {
        req.metadata_mut().insert("authorization", format!("Bearer {}", self.0).parse().unwrap());
        Ok(req)
    }
}
