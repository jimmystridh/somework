//! Smoke coverage of the remaining gRPC services: messages and artifacts.

mod grpc_common;

use grpc_common::*;
use sha2::{Digest, Sha256};
use somework_api::grpc::{pb, struct_to_json};
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
                r#type: "artifact.published".into(),
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
async fn an_artifact_is_uploaded_verified_and_attached_to_a_message() {
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
    let fetched =
        g.artifacts(&ac).get_metadata(pb::GetArtifactRequest { artifact_id: grant.artifact_id.clone(), version: grant.version }).await.unwrap().into_inner();
    assert_eq!(fetched.size_bytes, bytes.len() as u64);
    let download =
        g.artifacts(&ac).get_download(pb::GetDownloadRequest { artifact_id: grant.artifact_id.clone(), version: grant.version }).await.unwrap().into_inner();
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

    // attach it to a message: the receiver reads the reference and downloads the same bytes
    let sent = g
        .messages(&ac)
        .send(pb::SendMessageRequest {
            recipients: vec![pb::Member { kind: "agent".into(), id: "agent/reviewer".into() }],
            media_type: "text/plain".into(),
            data: Some(prost_types::Value { kind: Some(prost_types::value::Kind::StringValue("see the repro".into())) }),
            artifacts: vec![meta.artifact.clone().unwrap()],
            ..Default::default()
        })
        .await
        .unwrap()
        .into_inner();
    let page =
        g.messages(&wc).list(pb::ListMessagesRequest { conversation_id: sent.conversation_id.clone(), ..Default::default() }).await.unwrap().into_inner();
    let attached = struct_to_json(page.messages[0].envelope.clone().unwrap())["artifacts"][0].clone();
    assert_eq!(attached["artifactId"], grant.artifact_id.as_str());
    let seen =
        g.artifacts(&wc).get_download(pb::GetDownloadRequest { artifact_id: grant.artifact_id.clone(), version: grant.version }).await.unwrap().into_inner();
    assert_eq!(reqwest::get(&seen.url).await.unwrap().bytes().await.unwrap().to_vec(), bytes);
    // a reference to something that was never uploaded is refused
    let mut unknown = meta.artifact.clone().unwrap();
    unknown.fields.insert("artifactId".into(), prost_types::Value { kind: Some(prost_types::value::Kind::StringValue("art_missing".into())) });
    expect_err(
        g.messages(&ac)
            .send(pb::SendMessageRequest {
                recipients: vec![pb::Member { kind: "agent".into(), id: "agent/reviewer".into() }],
                media_type: "text/plain".into(),
                data: Some(prost_types::Value { kind: Some(prost_types::value::Kind::StringValue("ghost".into())) }),
                artifacts: vec![unknown],
                ..Default::default()
            })
            .await,
        Code::FailedPrecondition,
        "artifact_not_ready",
    );
    g.stack.stop().await;
}
