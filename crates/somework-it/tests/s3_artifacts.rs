//! Artifact storage proven equivalent on the local filesystem store and on real MinIO (S3).

use std::time::Duration;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use somework_api::config::ServerConfig;
use somework_client::{Client, ClientError};
use somework_core::{
    ErrorCode,
    contracts::{ActorKind, ArtifactRef, SideEffects},
    fsm::TaskState,
};
use somework_domain::policy::Permissions;
use somework_testkit::{
    Agent, Stack, StackBuilder, capability,
    minio::{MinioServer, s3_stack},
};

const MIB: usize = 1024 * 1024;

struct Env {
    stack: Stack,
    minio: Option<MinioServer>,
}

async fn fs_env(tweak: impl FnOnce(&mut ServerConfig)) -> Env {
    Env { stack: StackBuilder::new().config(tweak).start().await, minio: None }
}

async fn s3_env(tweak: impl FnOnce(&mut ServerConfig)) -> Env {
    let minio = MinioServer::start().await;
    let stack = s3_stack(&minio, 5 * MIB as u64, 5 * MIB as u64).config(tweak).start().await;
    Env { stack, minio: Some(minio) }
}

fn sha(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn perms(classification: &str) -> Permissions {
    let mut p = Permissions::default_agent();
    p.classification_max = Some(classification.into());
    p
}

async fn principal(stack: &Stack, id: &str, p: Permissions) -> Client {
    let key = stack.create_principal(ActorKind::Agent, id, p).await;
    Client::assertion(&stack.url, (*key).clone(), "agent", id, &stack.domain_id)
}

async fn put_bytes(grant: &Value, bytes: &[u8]) -> reqwest::StatusCode {
    let mut req = reqwest::Client::new().put(grant["url"].as_str().unwrap()).body(bytes.to_vec());
    for (k, v) in grant["headers"].as_object().cloned().unwrap_or_default() {
        req = req.header(k, v.as_str().unwrap());
    }
    req.send().await.unwrap().status()
}

async fn begin(client: &Client, name: &str, class: &str, bytes_len: usize, declared_sha: &str, task: Option<&str>) -> Result<Value, ClientError> {
    client.post("/v1/artifacts/uploads", &json!({"filename": name, "mediaType": "text/plain", "sizeBytes": bytes_len, "sha256": declared_sha, "classification": class, "sourceTaskId": task})).await
}

struct Work {
    requester: Agent,
    worker: Agent,
    task_id: String,
    fence: u64,
}

async fn running_task(stack: &Stack, input_extra: Value) -> Work {
    let mut wp = Permissions::default_agent();
    wp.side_effects_at_most = Some(SideEffects::Read);
    let worker = stack.worker("agent/worker", vec![capability("code.review", "2.1", "read", "Review code")], wp).await;
    let requester = stack.requester("agent/requester", &["code.review"], SideEffects::Read).await;
    let mut input = json!({"repository": "r"});
    if let Some(extra) = input_extra.as_object() {
        input.as_object_mut().unwrap().extend(extra.clone());
    }
    let task = requester.client.submit_task(&json!({"capability": {"id": "code.review", "version": "2.1"}, "input": input}), None).await.unwrap();
    let claim = worker.client.claim_task(&task.task_id, Some(120)).await.unwrap();
    worker.client.progress_task(&task.task_id, &json!({"fencingToken": claim.fencing_token})).await.unwrap();
    Work { requester, worker, task_id: task.task_id, fence: claim.fencing_token }
}

// ---- scenarios -----------------------------------------------------------------------------------------------------

async fn roundtrip(env: &Env) {
    let client = principal(&env.stack, "agent/uploader", perms("internal")).await;
    let bytes = b"hello artifacts".repeat(1000);
    let aref = client.upload_artifact("hello.txt", "text/plain", "internal", &bytes, None).await.unwrap();
    assert_eq!(aref.digest.value, sha(&bytes));
    assert_eq!(aref.size_bytes as usize, bytes.len());
    let got = client.download_artifact(&aref.artifact_id, aref.version, None).await.unwrap();
    assert_eq!(got, bytes);
    let meta = client.get(&format!("/v1/artifacts/{}/{}", aref.artifact_id, aref.version)).await.unwrap();
    assert_eq!(meta["uri"], format!("artifact://development/{}/1", aref.artifact_id));
}

async fn integrity_failures(env: &Env) {
    let client = principal(&env.stack, "agent/uploader", perms("internal")).await;
    let before = env.stack.domain().metrics.artifact_integrity_failures.get();
    let good = b"the real bytes".to_vec();
    let tampered = b"the evil bytes".to_vec();
    assert_eq!(good.len(), tampered.len());

    // tampered content: declared digest is for different bytes of the same size
    let grant = begin(&client, "a.txt", "internal", good.len(), &sha(&good), None).await.unwrap();
    assert!(put_bytes(&grant, &tampered).await.is_success());
    let err = client.post(&format!("/v1/artifacts/{}/complete", grant["artifactId"].as_str().unwrap()), &json!({"version": 1})).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::IntegrityFailure);
    let again = client.post(&format!("/v1/artifacts/{}/complete", grant["artifactId"].as_str().unwrap()), &json!({"version": 1})).await.unwrap_err();
    assert_eq!(again.code, ErrorCode::IntegrityFailure, "a failed upload can never be completed");
    let dl = client.post(&format!("/v1/artifacts/{}/1/download-grants", grant["artifactId"].as_str().unwrap()), &json!({})).await.unwrap_err();
    assert_eq!(dl.code, ErrorCode::ArtifactNotReady);

    // wrong declared size
    let grant = begin(&client, "b.txt", "internal", good.len() + 5, &sha(&good), None).await.unwrap();
    assert!(put_bytes(&grant, &good).await.is_success());
    let err = client.post(&format!("/v1/artifacts/{}/complete", grant["artifactId"].as_str().unwrap()), &json!({"version": 1})).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::IntegrityFailure);

    // nothing uploaded at all
    let grant = begin(&client, "c.txt", "internal", good.len(), &sha(&good), None).await.unwrap();
    let err = client.post(&format!("/v1/artifacts/{}/complete", grant["artifactId"].as_str().unwrap()), &json!({"version": 1})).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::IntegrityFailure);

    assert_eq!(env.stack.domain().metrics.artifact_integrity_failures.get(), before + 3);
}

async fn required_artifacts_gate_completion(env: &Env) {
    let w = running_task(&env.stack, json!({})).await;
    let bytes = b"patch contents".to_vec();

    // pending (never completed) artifact
    let pending = begin(&w.worker.client, "p.patch", "internal", bytes.len(), &sha(&bytes), Some(&w.task_id)).await.unwrap();
    assert!(put_bytes(&pending, &bytes).await.is_success());
    let fake_ref = |artifact_id: &str| -> ArtifactRef {
        serde_json::from_value(json!({
            "artifactId": artifact_id, "version": 1, "uri": format!("artifact://development/{artifact_id}/1"), "mediaType": "text/plain", "sizeBytes": bytes.len(),
            "digest": {"algorithm": "sha-256", "value": sha(&bytes)}, "classification": "internal",
            "createdBy": {"kind": "agent", "id": "agent/worker", "domainId": "development"}, "createdAt": "2026-10-03T12:00:00.000Z"
        }))
        .unwrap()
    };
    let err = w
        .worker
        .client
        .complete_task(&w.task_id, w.fence, &json!({"verdict": "approve"}), &[fake_ref(pending["artifactId"].as_str().unwrap())])
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::ArtifactNotReady);

    // failed artifact
    let failed = begin(&w.worker.client, "f.patch", "internal", bytes.len(), &sha(b"other"), Some(&w.task_id)).await.unwrap();
    assert!(put_bytes(&failed, &bytes).await.is_success());
    let _ = w.worker.client.post(&format!("/v1/artifacts/{}/complete", failed["artifactId"].as_str().unwrap()), &json!({})).await;
    let err = w
        .worker
        .client
        .complete_task(&w.task_id, w.fence, &json!({"verdict": "approve"}), &[fake_ref(failed["artifactId"].as_str().unwrap())])
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::ArtifactNotReady);
    assert_eq!(w.worker.client.get_task(&w.task_id).await.unwrap().state, TaskState::Running, "failed attempts leave the task running");

    // a digest that disagrees with the verified one is rejected even for a complete artifact
    let good = w.worker.client.upload_artifact("g.patch", "text/plain", "internal", &bytes, Some(&w.task_id)).await.unwrap();
    let mut lying = good.clone();
    lying.digest.value = sha(b"lies");
    let err = w.worker.client.complete_task(&w.task_id, w.fence, &json!({"verdict": "approve"}), &[lying]).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::IntegrityFailure);

    let done = w.worker.client.complete_task(&w.task_id, w.fence, &json!({"verdict": "approve"}), std::slice::from_ref(&good)).await.unwrap();
    assert_eq!(done.state, TaskState::Succeeded);
    assert_eq!(done.result_artifacts[0].digest.value, good.digest.value);
    // the requester fetches the result artifact through its own grant
    let fetched = w.requester.client.download_artifact(&good.artifact_id, good.version, None).await.unwrap();
    assert_eq!(fetched, bytes);
}

async fn confused_deputy_and_leaked_grants(env: &Env) {
    let secret = b"restricted design document".to_vec();
    let uploader = principal(&env.stack, "agent/vault", perms("restricted")).await;
    let restricted = uploader.upload_artifact("design.txt", "text/plain", "restricted", &secret, None).await.unwrap();
    let confidential = uploader.upload_artifact("notes.txt", "text/plain", "confidential", b"notes", None).await.unwrap();
    let w = running_task(&env.stack, json!({"design": restricted.uri})).await;

    // the worker may be broadly capable, but under an internal-clearance task it cannot reach the restricted artifact
    let err = w.worker.client.download_artifact(&restricted.artifact_id, restricted.version, Some((&w.task_id, w.fence))).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::PolicyDenied, "{err:?}");
    let err = w.worker.client.download_artifact(&restricted.artifact_id, restricted.version, None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::PolicyDenied);
    // artifacts outside the task's scope are indistinguishable from nonexistent ones
    let err = w.worker.client.download_artifact(&confidential.artifact_id, confidential.version, Some((&w.task_id, w.fence))).await.unwrap_err();
    assert!(matches!(err.code, ErrorCode::NotFound | ErrorCode::PolicyDenied), "{err:?}");

    // leaked grant: a URL works for whoever holds it until it expires, but a new grant is refused to anyone without rights
    let grant = uploader.post(&format!("/v1/artifacts/{}/{}/download-grants", confidential.artifact_id, confidential.version), &json!({})).await.unwrap();
    let anonymous = reqwest::get(grant["url"].as_str().unwrap()).await.unwrap();
    assert!(anonymous.status().is_success());
    assert_eq!(sha(&anonymous.bytes().await.unwrap()), confidential.digest.value);
    let other = principal(&env.stack, "agent/other", perms("internal")).await;
    let err = other.post(&format!("/v1/artifacts/{}/{}/download-grants", confidential.artifact_id, confidential.version), &json!({})).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::PolicyDenied);

    // every grant and every denial is audited
    let audit = env.stack.admin.get("/v1/admin/audit?limit=1000").await.unwrap();
    let events = audit["events"].as_array().unwrap();
    assert!(events.iter().any(|e| e["action"] == "artifact.download_grant" && e["outcome"] == "success" && e["authenticatedActor"] == "agent:agent/vault"));
    assert!(
        events.iter().any(|e| e["action"] == "artifact.download_grant" && e["outcome"] == "denied" && e["authenticatedActor"] == "agent:agent/other"),
        "{events:?}"
    );
}

async fn limits_and_quota(env: &Env) {
    let client = principal(&env.stack, "agent/uploader", perms("internal")).await;
    let err = begin(&client, "big.bin", "internal", 5000, &sha(b"x"), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::PayloadTooLarge);
    let a = begin(&client, "a.bin", "internal", 2000, &sha(b"x"), None).await.unwrap();
    assert!(a["artifactId"].is_string());
    let err = begin(&client, "b.bin", "internal", 2000, &sha(b"x"), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::QuotaExceeded);
}

async fn stale_uploads_are_cleaned_up(env: &Env) {
    let client = principal(&env.stack, "agent/uploader", perms("internal")).await;
    let bytes = b"orphan".to_vec();
    let grant = begin(&client, "o.txt", "internal", bytes.len(), &sha(&bytes), None).await.unwrap();
    assert!(put_bytes(&grant, &bytes).await.is_success());
    let key = format!("development/{}/v1", grant["artifactId"].as_str().unwrap());
    let store = env.stack.domain().object_store().unwrap();
    assert!(store.digest(&key).await.unwrap().is_some());
    tokio::time::sleep(Duration::from_millis(3200)).await;
    // the maintenance loop may already have swept it; the sweep is idempotent either way
    env.stack.domain().expire_stale_uploads().await.unwrap();
    assert!(store.digest(&key).await.unwrap().is_none(), "the orphaned object is removed");
    let err = client.post(&format!("/v1/artifacts/{}/complete", grant["artifactId"].as_str().unwrap()), &json!({})).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::IntegrityFailure);
}

async fn grants_expire_and_objects_are_immutable(env: &Env) {
    let client = principal(&env.stack, "agent/uploader", perms("internal")).await;
    let bytes = b"short lived".to_vec();
    let grant = begin(&client, "s.txt", "internal", bytes.len(), &sha(&bytes), None).await.unwrap();
    assert!(put_bytes(&grant, &bytes).await.is_success());
    // overwriting a committed object through a reused upload grant is refused
    assert!(!put_bytes(&grant, b"overwrite!!").await.is_success());
    let aref: ArtifactRef =
        client.typed(client.post(&format!("/v1/artifacts/{}/complete", grant["artifactId"].as_str().unwrap()), &json!({})).await.unwrap()).await.unwrap();
    let dl = client.post(&format!("/v1/artifacts/{}/{}/download-grants", aref.artifact_id, aref.version), &json!({})).await.unwrap();
    assert!(reqwest::get(dl["url"].as_str().unwrap()).await.unwrap().status().is_success());
    tokio::time::sleep(Duration::from_millis(3200)).await;
    assert!(!reqwest::get(dl["url"].as_str().unwrap()).await.unwrap().status().is_success(), "an expired download URL stops working");
    // a late upload through an expired grant is refused as well
    let late = begin(&client, "l.txt", "internal", bytes.len(), &sha(&bytes), None).await.unwrap();
    tokio::time::sleep(Duration::from_millis(3200)).await;
    assert!(!put_bytes(&late, &bytes).await.is_success());
}

fn short_ttl(c: &mut ServerConfig) {
    c.domain.download_grant_ttl_seconds = 1;
    c.domain.upload_grant_ttl_seconds = 1;
}

fn tiny_limits(c: &mut ServerConfig) {
    c.domain.max_artifact_bytes = 4096;
    c.domain.artifact_quota_bytes = 3000;
}

// ---- filesystem store ----------------------------------------------------------------------------------------------

#[tokio::test]
async fn fs_roundtrip() {
    roundtrip(&fs_env(|_| {}).await).await;
}
#[tokio::test]
async fn fs_integrity_failures() {
    integrity_failures(&fs_env(|_| {}).await).await;
}
#[tokio::test]
async fn fs_required_artifacts_gate_completion() {
    required_artifacts_gate_completion(&fs_env(|_| {}).await).await;
}
#[tokio::test]
async fn fs_confused_deputy_and_leaked_grants() {
    confused_deputy_and_leaked_grants(&fs_env(|_| {}).await).await;
}
#[tokio::test]
async fn fs_limits_and_quota() {
    limits_and_quota(&fs_env(tiny_limits).await).await;
}
#[tokio::test]
async fn fs_stale_uploads_are_cleaned_up() {
    stale_uploads_are_cleaned_up(&fs_env(short_ttl).await).await;
}
#[tokio::test]
async fn fs_grants_expire_and_objects_are_immutable() {
    grants_expire_and_objects_are_immutable(&fs_env(short_ttl).await).await;
}

// ---- real MinIO ----------------------------------------------------------------------------------------------------

#[tokio::test]
async fn s3_roundtrip() {
    roundtrip(&s3_env(|_| {}).await).await;
}
#[tokio::test]
async fn s3_integrity_failures() {
    integrity_failures(&s3_env(|_| {}).await).await;
}
#[tokio::test]
async fn s3_required_artifacts_gate_completion() {
    required_artifacts_gate_completion(&s3_env(|_| {}).await).await;
}
#[tokio::test]
async fn s3_confused_deputy_and_leaked_grants() {
    confused_deputy_and_leaked_grants(&s3_env(|_| {}).await).await;
}
#[tokio::test]
async fn s3_limits_and_quota() {
    limits_and_quota(&s3_env(tiny_limits).await).await;
}
#[tokio::test]
async fn s3_stale_uploads_are_cleaned_up() {
    stale_uploads_are_cleaned_up(&s3_env(short_ttl).await).await;
}
#[tokio::test]
async fn s3_grants_expire_and_objects_are_immutable() {
    grants_expire_and_objects_are_immutable(&s3_env(short_ttl).await).await;
}

#[tokio::test]
async fn s3_multipart_upload_of_11_mib() {
    let env = s3_env(|_| {}).await;
    let client = principal(&env.stack, "agent/uploader", perms("internal")).await;
    let bytes: Vec<u8> = (0..11 * MIB).map(|i| (i % 251) as u8).collect();
    let grant = begin(&client, "big.bin", "internal", bytes.len(), &sha(&bytes), None).await.unwrap();
    assert_eq!(grant["multipart"]["parts"].as_array().unwrap().len(), 3, "11 MiB in 5 MiB parts");
    assert!(!grant.to_string().contains(&env.minio.as_ref().unwrap().secret_key), "no permanent credential in grants");
    let aref = client.upload_artifact("big.bin", "application/octet-stream", "internal", &bytes, None).await.unwrap();
    assert_eq!(aref.size_bytes as usize, bytes.len());
    assert_eq!(client.download_artifact(&aref.artifact_id, aref.version, None).await.unwrap(), bytes);

    // completing with the wrong number of parts is rejected and leaves the artifact unusable
    let grant = begin(&client, "big2.bin", "internal", bytes.len(), &sha(&bytes), None).await.unwrap();
    let err = client
        .post(&format!("/v1/artifacts/{}/complete", grant["artifactId"].as_str().unwrap()), &json!({"parts": [{"partNumber": 1, "etag": "x"}]}))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::ValidationFailed);
}

#[tokio::test]
async fn s3_single_upload_never_exposes_the_secret_key() {
    let env = s3_env(|_| {}).await;
    let client = principal(&env.stack, "agent/uploader", perms("internal")).await;
    let bytes = b"small".to_vec();
    let grant = begin(&client, "s.txt", "internal", bytes.len(), &sha(&bytes), None).await.unwrap();
    let secret = &env.minio.as_ref().unwrap().secret_key;
    assert!(!grant.to_string().contains(secret.as_str()));
    assert!(grant["url"].as_str().unwrap().contains("X-Amz-Signature="));
    let aref = client.upload_artifact("s.txt", "text/plain", "internal", &bytes, None).await.unwrap();
    let dl = client.post(&format!("/v1/artifacts/{}/{}/download-grants", aref.artifact_id, aref.version), &json!({})).await.unwrap();
    assert!(!dl.to_string().contains(secret.as_str()));
}

#[tokio::test]
async fn s3_outage_keeps_the_task_running_until_the_store_returns() {
    let mut env = s3_env(|_| {}).await;
    let w = running_task(&env.stack, json!({})).await;
    let bytes = b"result patch".to_vec();
    let verified = w.worker.client.upload_artifact("ok.patch", "text/plain", "internal", &bytes, Some(&w.task_id)).await.unwrap();
    let pending = begin(&w.worker.client, "later.patch", "internal", bytes.len(), &sha(&bytes), Some(&w.task_id)).await.unwrap();
    assert!(put_bytes(&pending, &bytes).await.is_success());

    env.minio.as_mut().unwrap().stop();
    let err = w.worker.client.complete_task(&w.task_id, w.fence, &json!({"verdict": "approve"}), std::slice::from_ref(&verified)).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Unavailable, "{err:?}");
    assert!(err.is_retryable());
    let err = w.worker.client.post(&format!("/v1/artifacts/{}/complete", pending["artifactId"].as_str().unwrap()), &json!({})).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Unavailable, "{err:?}");
    assert_eq!(w.worker.client.get_task(&w.task_id).await.unwrap().state, TaskState::Running, "an outage never fails the task");

    env.minio.as_mut().unwrap().restart().await;
    let aref = w.worker.client.post(&format!("/v1/artifacts/{}/complete", pending["artifactId"].as_str().unwrap()), &json!({})).await.unwrap();
    assert_eq!(aref["digest"]["value"], sha(&bytes));
    let done = w.worker.client.complete_task(&w.task_id, w.fence, &json!({"verdict": "approve"}), &[verified]).await.unwrap();
    assert_eq!(done.state, TaskState::Succeeded);
}
