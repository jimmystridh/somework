//! Disaster-recovery drills: backups taken under write load must recreate everything the domain acknowledged.

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
use somework_core::ErrorCode;
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

fn agent_client(url: &str, agent: &Agent) -> Client {
    Client::assertion(url, (*agent.key).clone(), "agent", &agent.id, &agent.domain_id)
}

fn message_to(recipient: &str, text: &str) -> Value {
    json!({"recipients": [{"kind": "agent", "id": recipient}], "content": {"mediaType": "text/plain", "data": text}})
}

struct World {
    stack: Stack,
    receiver: Agent,
    sender: Agent,
    unread_message: String,
    unread_key: String,
    artifact_ids: Vec<(String, u64, String)>,
    denials_before: i64,
}

async fn build_world(stack: Stack) -> World {
    let receiver = stack.worker("agent/receiver", vec![capability("code.review", "2.1", "read", "Review code")], Permissions::default_agent()).await;
    let sender = stack.requester("agent/sender").await;

    let mut artifact_ids = vec![];
    let mut refs = vec![];
    for i in 0..3 {
        let bytes = format!("evidence file {i}").repeat(100).into_bytes();
        let aref = sender.client.upload_artifact(&format!("e{i}.txt"), "text/plain", "internal", &bytes).await.unwrap();
        artifact_ids.push((aref.artifact_id.clone(), aref.version, aref.digest.value.clone()));
        refs.push(serde_json::to_value(&aref).unwrap());
    }

    // an unread message with attachments and an idempotency key
    let unread_key = "dr-unread-1".to_string();
    let mut body = message_to("agent/receiver", "please review the invoice import regression");
    body["artifacts"] = json!(refs);
    let sent = sender.client.post_idem("/v1/messages", &body, &unread_key).await.unwrap();

    // a policy denial and audit history
    let mut limited = Permissions::default_agent();
    limited.actions = vec!["catalog.read".into()];
    let outsider_key = stack.create_principal(somework_core::contracts::ActorKind::Agent, "agent/outsider", limited).await;
    let outsider = Client::assertion(&stack.url, (*outsider_key).clone(), "agent", "agent/outsider", &stack.domain_id);
    assert!(outsider.send_message(&message_to("agent/receiver", "hi")).await.is_err());
    let pool = pool_of(stack.domain());
    let denials_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM policy_decisions WHERE decision = 'deny'").fetch_one(&pool).await.unwrap();
    World { stack, receiver, sender, unread_message: sent["messageId"].as_str().unwrap().to_string(), unread_key, artifact_ids, denials_before }
}

async fn start_restored(dir: &Path) -> runner::Runtime {
    runner::start(restored_config(dir)).await.expect("start restored server")
}

#[tokio::test]
async fn backup_under_write_load_recreates_everything_acknowledged() {
    let world = build_world(StackBuilder::new().start().await).await;
    let backups = TempDir::new().unwrap();
    let backup_dir = backups.path().join("snapshot");

    // sustained writes while the snapshot is taken
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let acked: Arc<Mutex<Vec<(String, DateTime<Utc>)>>> = Arc::new(Mutex::new(vec![]));
    let load = {
        let (client, stop, acked) = (world.sender.client.clone(), stop.clone(), acked.clone());
        tokio::spawn(async move {
            let mut n = 0;
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                n += 1;
                if let Ok(sent) = client.post_idem("/v1/messages", &message_to("agent/receiver", &format!("load-{n}")), &format!("load-{n}")).await {
                    acked.lock().unwrap().push((sent["messageId"].as_str().unwrap().to_string(), Utc::now()));
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
    assert!(manifest.total_messages >= 2);
    assert!(manifest.master_key_included && manifest.files.iter().any(|f| f.path.starts_with("objects/")));

    // disaster: the server and every byte of its data directory are gone
    let (receiver, sender) = (world.receiver.clone(), world.sender.clone());
    let admin_key = world.stack.admin_key.clone();
    let (unread_message, unread_key, artifact_ids, denials_before) =
        (world.unread_message.clone(), world.unread_key.clone(), world.artifact_ids.clone(), world.denials_before);
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
    for (message_id, at) in &before_snapshot {
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE message_id = ?").bind(message_id).fetch_one(&pool).await.unwrap();
        assert_eq!(n, 1, "message {message_id} acknowledged at {at} before the snapshot is missing after restore");
    }

    // principals, policy and audit chain survived
    let admin = Client::assertion(&url, (*admin_key).clone(), "service", "root", "development");
    assert_eq!(admin.get("/v1/admin/audit/verify").await.unwrap()["intact"], true);
    assert!(admin.get("/v1/admin/policy").await.unwrap()["version"].is_string());
    let principals = admin.get("/v1/admin/principals").await.unwrap();
    assert!(principals["principals"].as_array().unwrap().iter().any(|p| p["id"] == "agent/receiver"));
    let denials: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM policy_decisions WHERE decision = 'deny'").fetch_one(&pool).await.unwrap();
    assert!(denials >= denials_before);

    // the unread message is still unread, can be read with its attachments, and acknowledged
    let receiver2 = agent_client(&url, &receiver);
    let inbox = receiver2.get("/v1/inbox?unread=true&limit=500").await.unwrap();
    assert!(inbox["messages"].as_array().unwrap().iter().any(|m| m["messageId"] == unread_message.as_str()), "{inbox:?}");
    receiver2.post("/v1/messages/read", &json!({"messageIds": [unread_message]})).await.unwrap();
    let inbox = receiver2.get("/v1/inbox?unread=true&limit=500").await.unwrap();
    assert!(!inbox["messages"].as_array().unwrap().iter().any(|m| m["messageId"] == unread_message.as_str()));

    // idempotency keys survive the restore
    let sender2 = agent_client(&url, &sender);
    let mut replay_body = message_to("agent/receiver", "please review the invoice import regression");
    replay_body["artifacts"] = json!(sender2.get(&format!("/v1/messages/{unread_message}")).await.unwrap()["artifacts"]);
    let replay = sender2.post_idem("/v1/messages", &replay_body, &unread_key).await.unwrap();
    assert_eq!(replay["messageId"], unread_message.as_str(), "idempotency keys survive the restore");

    // artifacts verify through fresh grants for the receiver
    for (id, version, digest) in &artifact_ids {
        let bytes = receiver2.download_artifact(id, *version).await.unwrap();
        assert_eq!(&sha(&bytes), digest);
    }
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
    let _receiver = stack.worker("agent/receiver", vec![capability("code.review", "2.1", "read", "Review code")], Permissions::default_agent()).await;
    let sender = stack.requester("agent/sender").await;

    let mut acked: Vec<(String, DateTime<Utc>)> = vec![];
    let run_until = Instant::now() + Duration::from_secs(7);
    let mut n = 0;
    while Instant::now() < run_until {
        n += 1;
        let sent = sender.client.post_idem("/v1/messages", &message_to("agent/receiver", &format!("load-{n}")), &format!("rpo-{n}")).await.unwrap();
        acked.push((sent["messageId"].as_str().unwrap().to_string(), Utc::now()));
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
    let restored: Vec<String> = sqlx::query_scalar("SELECT message_id FROM messages").fetch_all(&pool).await.unwrap();
    let survivors: Vec<&(String, DateTime<Utc>)> = acked.iter().filter(|(id, _)| restored.contains(id)).collect();
    assert!(!survivors.is_empty(), "the latest backup contains acknowledged work");
    let last_survivor = survivors.iter().map(|(_, at)| *at).max().unwrap();
    let rpo = (crash_at - last_survivor).to_std().unwrap();
    println!(
        "DR schedule: interval {interval}s, measured data-loss window (RPO) {:.2}s, restore+start (RTO) {:.2}s, {} of {} messages survived",
        rpo.as_secs_f64(),
        rto.as_secs_f64(),
        survivors.len(),
        acked.len()
    );
    assert!(rpo <= Duration::from_secs(interval) + Duration::from_millis(2500), "RPO {rpo:?} exceeds the backup interval");
    assert!(rto < Duration::from_secs(60));
    assert_eq!(report.manifest.total_messages as usize, restored.len());
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
    let requester = stack.requester("agent/requester").await;
    requester.client.upload_artifact("a.txt", "text/plain", "internal", b"original bytes").await.unwrap();
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
async fn outbox_rows_survive_restore() {
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
    let _receiver = stack.worker("agent/receiver", vec![capability("code.review", "2.1", "read", "Review code")], Permissions::default_agent()).await;
    let sender = stack.requester("agent/sender").await;
    let sent = sender.client.send_message(&message_to("agent/receiver", "hello")).await.unwrap();

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
    assert!(
        sink.0
            .lock()
            .unwrap()
            .iter()
            .any(|(subject, payload)| *subject == somework_core::subjects::inbox("agent/receiver") && payload["messageId"] == sent["messageId"])
    );
}

#[tokio::test]
async fn cli_backup_and_restore_roundtrip() {
    let stack = StackBuilder::new().start().await;
    let requester = stack.requester("agent/requester").await;
    let aref = requester.client.upload_artifact("a.txt", "text/plain", "internal", b"cli bytes").await.unwrap();
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
