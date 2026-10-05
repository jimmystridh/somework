//! Disaster-recovery drills: backups taken under write load must recreate outstanding accepted work.

use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use somework_api::{backup, config::ServerConfig, runner};
use somework_client::Client;
use somework_core::{ErrorCode, contracts::SideEffects, fsm::TaskState};
use somework_domain::{
    Domain,
    backup::{BackupOptions, restore_backup},
    outbox::{OutboxConfig, OutboxItem, OutboxSink, SinkError},
    policy::Permissions,
};
use somework_testkit::{Agent, Stack, StackBuilder, capability};
use sqlx::SqlitePool;
use tempfile::TempDir;

fn pool_of(domain: &Domain) -> SqlitePool {
    domain.db.pool().clone()
}

fn restored_config(dir: &Path) -> ServerConfig {
    let mut cfg = ServerConfig::default();
    cfg.domain.id = "development".into();
    cfg.domain.db = dir.join("somework.db");
    cfg.domain.listen = "127.0.0.1:0".into();
    cfg.domain.public_url = "auto".into();
    cfg.domain.synchronous_full = false;
    cfg.domain.maintenance_interval_ms = 100;
    cfg.objects.dir = Some(dir.join("objects"));
    cfg
}

fn backup_options(stack: &Stack, include_key: bool) -> BackupOptions {
    BackupOptions { objects_dir: Some(stack.dir.path().join("objects")), include_master_key: include_key, object_store: json!({"kind": "fs"}) }
}

fn sha(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

fn agent_client(url: &str, agent: &Agent, runtime: Option<String>) -> Client {
    let c = Client::assertion(url, (*agent.key).clone(), "agent", &agent.id, &agent.domain_id);
    match runtime {
        Some(rt) => c.with_runtime(rt),
        None => c,
    }
}

struct World {
    stack: Stack,
    worker: Agent,
    requester: Agent,
    approver_key: Arc<ed25519_dalek::SigningKey>,
    queued_task: String,
    queued_key: String,
    leased_task: String,
    approval_task: String,
    pack_id: String,
    pack_digest: String,
    artifact_ids: Vec<(String, u64, String)>,
    denials_before: i64,
}

async fn build_world(stack: Stack) -> World {
    let mut wp = Permissions::default_agent();
    wp.side_effects_at_most = Some(SideEffects::Irreversible);
    let worker = stack
        .worker(
            "agent/worker",
            vec![capability("code.review", "2.1", "read", "Review code"), capability("deployment.execute", "1.0", "irreversible", "Deploy to production")],
            wp,
        )
        .await;
    let requester = stack.requester("agent/requester", &["code.review", "deployment.execute"], SideEffects::Irreversible).await;
    let mut hp = Permissions::default_human();
    hp.approves = vec!["*".into()];
    let approver = stack.human("human/approver", hp).await;

    // artifacts and a ContextPack that references them
    let mut artifact_ids = vec![];
    let mut refs = vec![];
    for i in 0..3 {
        let bytes = format!("evidence file {i}").repeat(100).into_bytes();
        let aref = requester.client.upload_artifact(&format!("e{i}.txt"), "text/plain", "internal", &bytes, None).await.unwrap();
        artifact_ids.push((aref.artifact_id.clone(), aref.version, aref.digest.value.clone()));
        refs.push(serde_json::to_value(&aref).unwrap());
    }
    let pack = requester
        .client
        .post(
            "/v1/context-packs",
            &json!({
                "objective": "Diagnose the invoice import regression",
                "currentState": {"summary": "reproduced", "completed": ["repro"], "remaining": ["patch"]},
                "requestedContinuation": {"mode": "consultation", "instruction": "verify the hypothesis"},
                "security": {"classification": "internal", "allowedDomains": ["development"]},
                "artifacts": refs,
            }),
        )
        .await
        .unwrap();

    // a queued task with an idempotency key, a task leased for only 2 seconds, and a task waiting for human approval
    let queued_key = "dr-queued-1".to_string();
    let queued = requester
        .client
        .submit_task(&json!({"capability": {"id": "code.review", "version": "2.1"}, "input": {"repository": "billing/import-service"}, "contextRefs": [{"contextPackId": pack["contextPackId"], "version": 1}]}), Some(&queued_key))
        .await
        .unwrap();
    let leased =
        requester.client.submit_task(&json!({"capability": {"id": "code.review", "version": "2.1"}, "input": {"repository": "leased"}}), None).await.unwrap();
    worker.client.claim_task(&leased.task_id, Some(2)).await.unwrap();
    let leased_task = leased.task_id.clone();
    let approval = requester
        .client
        .submit_task(&json!({"capability": {"id": "deployment.execute", "version": "1.0"}, "input": {"repository": "prod"}}), None)
        .await
        .unwrap();
    assert_eq!(approval.state, TaskState::Submitted, "irreversible work waits for approval");

    // a policy denial and audit history
    let outsider = stack.requester("agent/outsider", &[], SideEffects::Read).await;
    let denied = outsider.client.download_artifact(&artifact_ids[0].0, 1, None).await;
    assert!(denied.is_err() || outsider.client.get("/v1/admin/audit").await.is_err());
    let pool = pool_of(stack.domain());
    let denials_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM policy_decisions WHERE decision = 'deny'").fetch_one(&pool).await.unwrap();
    let approver_key = approver.key.clone();
    World {
        stack,
        worker,
        requester,
        approver_key,
        queued_task: queued.task_id,
        queued_key,
        leased_task,
        approval_task: approval.task_id,
        pack_id: pack["contextPackId"].as_str().unwrap().to_string(),
        pack_digest: pack["digest"].as_str().unwrap().to_string(),
        artifact_ids,
        denials_before,
    }
}

async fn start_restored(dir: &Path) -> runner::Runtime {
    runner::start(restored_config(dir)).await.expect("start restored server")
}

#[tokio::test]
async fn backup_under_write_load_recreates_outstanding_work() {
    let world = build_world(StackBuilder::new().start().await).await;
    let backups = TempDir::new().unwrap();
    let backup_dir = backups.path().join("snapshot");

    // sustained writes while the snapshot is taken
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let acked: Arc<Mutex<Vec<(String, DateTime<Utc>)>>> = Arc::new(Mutex::new(vec![]));
    let load = {
        let (client, stop, acked) = (world.requester.client.clone(), stop.clone(), acked.clone());
        tokio::spawn(async move {
            let mut n = 0;
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                n += 1;
                if let Ok(t) = client
                    .submit_task(
                        &json!({"capability": {"id": "code.review", "version": "2.1"}, "input": {"repository": format!("load-{n}")}}),
                        Some(&format!("load-{n}")),
                    )
                    .await
                {
                    acked.lock().unwrap().push((t.task_id, Utc::now()));
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    let manifest = world.stack.domain().backup_to(&backup_dir, &backup_options(&world.stack, true)).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    load.await.unwrap();
    assert!(manifest.queued_tasks >= 2);
    assert!(manifest.master_key_included && manifest.files.iter().any(|f| f.path.starts_with("objects/")));

    // disaster: the server and every byte of its data directory are gone
    let (worker, requester, approver_key) = (world.worker.clone(), world.requester.clone(), world.approver_key.clone());
    let admin_key = world.stack.admin_key.clone();
    let rt = worker.client.runtime_instance_id();
    let (queued_task, queued_key, leased_task, approval_task, pack_id, pack_digest, artifact_ids, denials_before) = (
        world.queued_task.clone(),
        world.queued_key.clone(),
        world.leased_task.clone(),
        world.approval_task.clone(),
        world.pack_id.clone(),
        world.pack_digest.clone(),
        world.artifact_ids.clone(),
        world.denials_before,
    );
    let data_dir = world.stack.dir.path().to_path_buf();
    world.stack.runtime.stop().await;
    std::fs::remove_dir_all(&data_dir).unwrap();
    assert!(!data_dir.join("somework.db").exists());

    let restore_dir = TempDir::new().unwrap();
    let started = Instant::now();
    let report = restore_backup(&backup_dir, restore_dir.path(), None).await.unwrap();
    let server = start_restored(restore_dir.path()).await;
    let rto = started.elapsed();
    println!(
        "DR restore: {:.2}s restore, {:.2}s until serving (RTO), {} files verified, {} artifacts re-verified",
        report.restore_seconds,
        rto.as_secs_f64(),
        report.files_verified,
        report.artifacts_verified
    );
    assert!(rto < Duration::from_secs(60), "RTO {rto:?}");
    assert!(report.audit_intact && report.artifacts_verified >= 3);
    let url = server.url();

    // no acknowledged write before the snapshot began may be missing
    let snapshot_at = DateTime::parse_from_rfc3339(&manifest.created_at).unwrap().with_timezone(&Utc);
    let pool = pool_of(&server.domain);
    let before_snapshot: Vec<_> = acked.lock().unwrap().iter().filter(|(_, at)| *at < snapshot_at).cloned().collect();
    for (task_id, at) in &before_snapshot {
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tasks WHERE task_id = ?").bind(task_id).fetch_one(&pool).await.unwrap();
        assert_eq!(n, 1, "task {task_id} acknowledged at {at} before the snapshot is missing after restore");
    }

    // principals, grants, policy and audit chain survived
    let admin = Client::assertion(&url, (*admin_key).clone(), "service", "root", "development");
    assert_eq!(admin.get("/v1/admin/audit/verify").await.unwrap()["intact"], true);
    assert!(admin.get("/v1/admin/policy").await.unwrap()["version"].is_string());
    let principals = admin.get("/v1/admin/principals").await.unwrap();
    assert!(principals["principals"].as_array().unwrap().iter().any(|p| p["id"] == "agent/worker"));
    let denials: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM policy_decisions WHERE decision = 'deny'").fetch_one(&pool).await.unwrap();
    assert!(denials >= denials_before);

    // the queued task is claimable and completes; the leased task is recovered once its lease lapses
    let worker2 = agent_client(&url, &worker, rt.clone());
    let candidates = worker2.next_tasks(0).await.unwrap();
    assert!(candidates.iter().any(|c| c["taskId"] == queued_task), "{candidates:?}");
    let claim = worker2.claim_task(&queued_task, Some(60)).await.unwrap();
    worker2.progress_task(&queued_task, &json!({"fencingToken": claim.fencing_token})).await.unwrap();
    let done = worker2.complete_task(&queued_task, claim.fencing_token, &json!({"verdict": "approve"}), &[]).await.unwrap();
    assert_eq!(done.state, TaskState::Succeeded);
    let requester2 = agent_client(&url, &requester, requester.client.runtime_instance_id());
    let replay = requester2.submit_task(&json!({"capability": {"id": "code.review", "version": "2.1"}, "input": {"repository": "billing/import-service"}, "contextRefs": [{"contextPackId": pack_id, "version": 1}]}), Some(&queued_key)).await.unwrap();
    assert_eq!(replay.task_id, queued_task, "idempotency keys survive the restore");

    somework_testkit::process::eventually("leased task is re-queued after its lease lapses", Duration::from_secs(15), || async {
        let t = requester2.get_task(&leased_task).await.ok()?;
        (t.state == TaskState::Queued && t.attempt >= 2).then_some(())
    })
    .await;
    let reclaimed = worker2.claim_task(&leased_task, Some(60)).await.unwrap();
    assert!(reclaimed.fencing_token >= 2, "fencing token keeps increasing across the restore");

    // ContextPack: same digest, same authorization; artifacts verify through fresh grants
    let pack = requester2.get(&format!("/v1/context-packs/{pack_id}/1")).await.unwrap();
    assert_eq!(pack["digest"], pack_digest);
    for (id, version, digest) in &artifact_ids {
        let bytes = requester2.download_artifact(id, *version, None).await.unwrap();
        assert_eq!(&sha(&bytes), digest);
    }

    // the pending approval is still bound to its digest and can be decided after the restore
    let approver = Client::assertion(&url, (*approver_key).clone(), "human", "human/approver", "development");
    let pending: Value = requester2.get(&format!("/v1/tasks/{approval_task}")).await.unwrap();
    let pa = &pending["pendingApproval"];
    let decided = approver
        .post(
            &format!("/v1/approvals/{}/decision", pa["approvalId"].as_str().unwrap()),
            &json!({"decision": "approved", "actionDigest": pa["actionDigest"], "taskRevision": pa["taskRevision"]}),
        )
        .await
        .unwrap();
    assert_eq!(decided["state"], "queued");
    server.stop().await;
}

#[tokio::test]
async fn scheduled_backups_bound_the_data_loss_window() {
    let backups = TempDir::new().unwrap();
    let backup_root = backups.path().join("scheduled");
    let interval = 2u64;
    let root = backup_root.clone();
    let stack = StackBuilder::new()
        .config(move |c| {
            c.domain.backup_interval_seconds = interval;
            c.domain.backup_dir = Some(root);
            c.domain.backup_keep = 2;
            c.domain.backup_include_master_key = true;
        })
        .start()
        .await;
    let mut wp = Permissions::default_agent();
    wp.side_effects_at_most = Some(SideEffects::Read);
    let _worker = stack.worker("agent/worker", vec![capability("code.review", "2.1", "read", "Review code")], wp).await;
    let requester = stack.requester("agent/requester", &["code.review"], SideEffects::Read).await;

    let mut acked: Vec<(String, DateTime<Utc>)> = vec![];
    let run_until = Instant::now() + Duration::from_secs(7);
    let mut n = 0;
    while Instant::now() < run_until {
        n += 1;
        let t = requester
            .client
            .submit_task(
                &json!({"capability": {"id": "code.review", "version": "2.1"}, "input": {"repository": format!("load-{n}")}}),
                Some(&format!("rpo-{n}")),
            )
            .await
            .unwrap();
        acked.push((t.task_id, Utc::now()));
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    let crash_at = Utc::now();
    let data_dir = stack.dir.path().to_path_buf();
    stack.runtime.stop().await;
    std::fs::remove_dir_all(&data_dir).unwrap();

    let all = backup::list_backups(&backup_root);
    assert!(!all.is_empty() && all.len() <= 2, "retention keeps at most 2 backups, found {}", all.len());
    assert!(std::fs::read_dir(&backup_root).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().ends_with(".partial")));
    let latest = backup::latest_backup(&backup_root).unwrap();
    let restore_dir = TempDir::new().unwrap();
    let started = Instant::now();
    let report = restore_backup(&latest, restore_dir.path(), None).await.unwrap();
    let server = start_restored(restore_dir.path()).await;
    let rto = started.elapsed();

    let pool = pool_of(&server.domain);
    let restored: Vec<String> = sqlx::query_scalar("SELECT task_id FROM tasks").fetch_all(&pool).await.unwrap();
    let survivors: Vec<&(String, DateTime<Utc>)> = acked.iter().filter(|(id, _)| restored.contains(id)).collect();
    assert!(!survivors.is_empty(), "the latest backup contains acknowledged work");
    let last_survivor = survivors.iter().map(|(_, at)| *at).max().unwrap();
    let rpo = (crash_at - last_survivor).to_std().unwrap();
    println!(
        "DR schedule: interval {interval}s, measured data-loss window (RPO) {:.2}s, restore+start (RTO) {:.2}s, {} of {} tasks survived",
        rpo.as_secs_f64(),
        rto.as_secs_f64(),
        survivors.len(),
        acked.len()
    );
    assert!(rpo <= Duration::from_secs(interval) + Duration::from_millis(2500), "RPO {rpo:?} exceeds the backup interval");
    assert!(rto < Duration::from_secs(60));
    assert_eq!(report.manifest.total_tasks as usize, restored.len());
    server.stop().await;
}

#[tokio::test]
async fn restore_fails_clearly_without_the_master_key() {
    let stack = StackBuilder::new().start().await;
    let backups = TempDir::new().unwrap();
    let no_key = backups.path().join("no-key");
    let with_key = backups.path().join("with-key");
    stack.domain().backup_to(&no_key, &backup_options(&stack, false)).await.unwrap();
    stack.domain().backup_to(&with_key, &backup_options(&stack, true)).await.unwrap();

    let err = restore_backup(&no_key, TempDir::new().unwrap().path(), None).await.unwrap_err();
    assert!(err.message.contains("master key"), "{}", err.message);

    let wrong = somework_domain::secrets::MasterKey::generate().to_b64();
    let err = restore_backup(&no_key, TempDir::new().unwrap().path(), Some(wrong)).await.unwrap_err();
    assert!(err.message.contains("could not be opened"), "{}", err.message);

    // the right key, supplied out of band, restores the data without ever writing the key into the restore directory
    let key = stack.domain().master.to_b64();
    let out = TempDir::new().unwrap();
    let report = restore_backup(&no_key, out.path(), Some(key)).await.unwrap();
    assert!(report.audit_intact);
    assert!(!out.path().join("somework.masterkey").exists());

    // restoring into a directory that already holds a database is refused
    let err = restore_backup(&with_key, out.path(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    stack.stop().await;
}

#[tokio::test]
async fn tampered_backups_are_rejected() {
    let stack = StackBuilder::new().start().await;
    let requester = stack.requester("agent/requester", &[], SideEffects::Read).await;
    requester.client.upload_artifact("a.txt", "text/plain", "internal", b"original bytes", None).await.unwrap();
    let backups = TempDir::new().unwrap();
    let dir = backups.path().join("b");
    let manifest = stack.domain().backup_to(&dir, &backup_options(&stack, true)).await.unwrap();
    let object = manifest.files.iter().find(|f| f.path.starts_with("objects/")).unwrap();
    // objects are hard links into the live store: replace the backup's copy instead of writing through the link
    let target = dir.join(&object.path);
    std::fs::remove_file(&target).unwrap();
    std::fs::write(&target, b"tampered bytes").unwrap();
    let err = restore_backup(&dir, TempDir::new().unwrap().path(), None).await.unwrap_err();
    assert!(err.message.contains("manifest"), "{}", err.message);
    stack.stop().await;
}

struct Recorder(Mutex<Vec<(String, Value)>>);

#[async_trait]
impl OutboxSink for Recorder {
    fn name(&self) -> &'static str {
        "nats"
    }
    async fn deliver(&self, item: &OutboxItem) -> Result<(), SinkError> {
        self.0.lock().unwrap().push((item.subject.clone(), item.payload.clone()));
        Ok(())
    }
}

#[tokio::test]
async fn outbox_rows_survive_restore_and_lost_broker_state_is_republished() {
    // a stack whose domain writes outbox rows for a NATS sink (the broker itself is not needed for this drill)
    let dir = TempDir::new().unwrap();
    let mut cfg = restored_config(dir.path());
    cfg.domain.db = dir.path().join("somework.db");
    cfg.objects.dir = Some(dir.path().join("objects"));
    let mut domain_cfg = cfg.domain_config();
    domain_cfg.outbox_sinks = vec!["nats".into()];
    let domain = Domain::open(domain_cfg).await.unwrap();
    let key = somework_core::jws::new_signing_key();
    domain.bootstrap_admin("root", &somework_core::jws::verifying_key_to_b64(&key.verifying_key())).await.unwrap();
    let runtime = runner::start_with_domain(domain, cfg).await.unwrap();
    let url = runtime.url();
    let stack = Stack {
        runtime,
        dir,
        url: url.clone(),
        domain_id: "development".into(),
        admin_key: Arc::new(key.clone()),
        admin: Client::assertion(&url, key, "service", "root", "development"),
    };
    let mut wp = Permissions::default_agent();
    wp.side_effects_at_most = Some(SideEffects::Read);
    let _worker = stack.worker("agent/worker", vec![capability("code.review", "2.1", "read", "Review code")], wp).await;
    let requester = stack.requester("agent/requester", &["code.review"], SideEffects::Read).await;
    let task = requester.client.submit_task(&json!({"capability": {"id": "code.review", "version": "2.1"}, "input": {"repository": "r"}}), None).await.unwrap();

    let pending: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM outbox_events WHERE status = 'pending' AND sink = 'nats'").fetch_one(&pool_of(stack.domain())).await.unwrap();
    assert!(pending > 0, "the transactional outbox holds undelivered rows");

    let backups = TempDir::new().unwrap();
    let snapshot = backups.path().join("s");
    stack.domain().backup_to(&snapshot, &backup_options(&stack, true)).await.unwrap();
    stack.runtime.stop().await;

    let restored = TempDir::new().unwrap();
    restore_backup(&snapshot, restored.path(), None).await.unwrap();
    let mut dcfg = somework_domain::config::DomainConfig::new("development", restored.path().join("somework.db"));
    dcfg.db_synchronous_full = false;
    dcfg.outbox_sinks = vec!["nats".into()];
    let domain = Domain::open(dcfg).await.unwrap();
    let sink = Recorder(Mutex::new(vec![]));
    let cfg = OutboxConfig::default();
    let report = domain.outbox_step(&sink, "dr", &cfg).await.unwrap();
    assert!(report.published >= 1, "rows committed before the backup are published after the restore");
    assert!(sink.0.lock().unwrap().iter().any(|(subject, payload)| subject.starts_with("somework.work.pool.") && payload["taskId"] == task.task_id));

    // the broker lost its streams: every queued task is announced again, idempotently (same task, new notification)
    let before = sink.0.lock().unwrap().len();
    let n = domain.republish_queued_tasks().await.unwrap();
    assert!(n >= 1);
    domain.outbox_step(&sink, "dr", &cfg).await.unwrap();
    let after = sink.0.lock().unwrap();
    assert!(after.len() > before);
    assert!(after[before..].iter().any(|(_, p)| p["taskId"] == task.task_id));
}

#[tokio::test]
async fn cli_backup_and_restore_roundtrip() {
    let stack = StackBuilder::new().start().await;
    let requester = stack.requester("agent/requester", &[], SideEffects::Read).await;
    let aref = requester.client.upload_artifact("a.txt", "text/plain", "internal", b"cli bytes", None).await.unwrap();
    let cfg_dir = TempDir::new().unwrap();
    let config = cfg_dir.path().join("somework.toml");
    std::fs::write(
        &config,
        format!(
            "[domain]\nid = \"development\"\ndb = \"{}\"\n\n[objects]\nkind = \"fs\"\ndir = \"{}\"\n",
            stack.dir.path().join("somework.db").display(),
            stack.dir.path().join("objects").display()
        ),
    )
    .unwrap();
    let out = TempDir::new().unwrap();
    let snapshot = out.path().join("snap");
    backup::backup(&config, &snapshot).await.unwrap();
    let restored = out.path().join("restored");
    backup::restore(&snapshot, &restored).await.unwrap();
    assert!(restored.join("somework.toml").exists() && restored.join("somework.db").exists());
    let mut restored_cfg = ServerConfig::load(&restored.join("somework.toml")).unwrap_or_else(|_| restored_config(&restored));
    restored_cfg.domain.listen = "127.0.0.1:0".into();
    let server = runner::start(restored_cfg).await.unwrap();
    let again = Client::assertion(server.url(), (*requester.key).clone(), "agent", "agent/requester", "development");
    assert_eq!(again.get(&format!("/v1/artifacts/{}/{}", aref.artifact_id, aref.version)).await.unwrap()["digest"]["value"], aref.digest.value);
    server.stop().await;
    stack.stop().await;
}
