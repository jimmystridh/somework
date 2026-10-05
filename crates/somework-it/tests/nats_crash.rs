mod nats_common;

use std::{
    path::PathBuf,
    process::{Command, Stdio},
    time::Duration,
};

use nats_common::*;
use serde_json::json;
use somework_client::Client;
use somework_testkit::{
    nats::NatsServer,
    process::{ChildGuard, eventually, free_port, repo_root, wait_for_port},
};

fn somework_binary() -> PathBuf {
    let status = Command::new("cargo").args(["build", "-q", "-p", "somework-api", "--bin", "somework"]).current_dir(repo_root()).status().expect("cargo build");
    assert!(status.success(), "building the somework binary failed");
    let exe = std::env::current_exe().unwrap();
    exe.parent().unwrap().parent().unwrap().join("somework")
}

fn run_cli(bin: &PathBuf, config: &PathBuf, args: &[&str]) {
    let status = Command::new(bin).arg("admin").arg("--config").arg(config).args(args).stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap();
    assert!(status.success(), "somework admin {args:?} failed");
}

fn client_from_key(base: &str, path: &PathBuf, runtime: Option<&str>) -> Client {
    let kf: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let key = somework_core::jws::signing_key_from_b64(kf["privateKey"].as_str().unwrap()).unwrap();
    let c = Client::assertion(base, key, kf["kind"].as_str().unwrap(), kf["id"].as_str().unwrap(), "development");
    match runtime {
        Some(rt) => c.with_runtime(rt),
        None => c,
    }
}

fn spawn_server(bin: &PathBuf, config: &PathBuf) -> ChildGuard {
    let mut cmd = Command::new(bin);
    cmd.arg("serve").arg("--config").arg(config);
    ChildGuard::spawn("somework", cmd)
}

#[tokio::test]
async fn killing_the_api_after_commit_but_before_publish_still_delivers_eventually() {
    let bin = somework_binary();
    let nats = NatsServer::start("development").await;
    let dir = tempfile::tempdir().unwrap();
    let port = free_port();
    let nc = nats.plane_config();
    let config = dir.path().join("somework.toml");
    std::fs::write(
        &config,
        format!(
            r#"allow_failpoint_admin = true
[domain]
id = "development"
db = "{db}"
listen = "127.0.0.1:{port}"
public_url = "http://127.0.0.1:{port}"
synchronous_full = false
maintenance_interval_ms = 200
[objects]
dir = "{objects}"
[nats]
url = "{url}"
user = "{user}"
password = "{password}"
users_file = "{users}"
reload_command = ["sh", "-c", "kill -HUP $(cat {pid})"]
reconcile_interval_ms = 200
"#,
            db = dir.path().join("somework.db").display(),
            objects = dir.path().join("objects").display(),
            url = nc.url,
            user = nc.user.unwrap(),
            password = nc.password.unwrap(),
            users = nats.users_file().display(),
            pid = nats.pid_file().display(),
        ),
    )
    .unwrap();
    let (root, reviewer_key, author_key) = (dir.path().join("root.json"), dir.path().join("reviewer.json"), dir.path().join("author.json"));
    run_cli(&bin, &config, &["bootstrap", "--key-out", root.to_str().unwrap()]);
    run_cli(&bin, &config, &["enroll-agent", "--id", "agent/reviewer", "--side-effects", "read", "--key-out", reviewer_key.to_str().unwrap()]);
    run_cli(&bin, &config, &["enroll-agent", "--id", "agent/author", "--may-invoke", "code.review", "--key-out", author_key.to_str().unwrap()]);

    let base = format!("http://127.0.0.1:{port}");
    let mut server = spawn_server(&bin, &config);
    wait_for_port(port, Duration::from_secs(20)).await;
    let admin = client_from_key(&base, &root, None);
    let runtime = somework_core::ids::runtime_instance_id();
    let reviewer = client_from_key(&base, &reviewer_key, Some(&runtime));
    let author = client_from_key(&base, &author_key, None);
    eventually("server answers", Duration::from_secs(10), || async { admin.get("/healthz").await.ok() }).await;
    reviewer.register_agent(&somework_testkit::card("agent/reviewer", "development", vec![review_cap()])).await.unwrap();
    admin.post("/v1/agents/agent%2Freviewer/approval", &json!({"status": "approved"})).await.unwrap();
    reviewer.register_runtime(json!({})).await.unwrap();
    // drain catalog/runtime events first so only the task event is in flight when the failpoint fires
    eventually("outbox idle", Duration::from_secs(15), || async {
        let v = admin.get("/v1/admin/outbox").await.ok()?;
        let pending = v["sinks"]
            .as_array()?
            .iter()
            .find(|s| s["sink"] == "nats")
            .map(|s| s["pending"].as_i64().unwrap_or(0) + s["failed"].as_i64().unwrap_or(0))
            .unwrap_or(0);
        (pending == 0).then_some(())
    })
    .await;

    admin.post("/v1/admin/failpoints", &json!({"spec": "outbox.before_publish=exit"})).await.unwrap();
    // the commit happens, then the process dies before publishing (and possibly before answering)
    let first = author.with_retries(0).submit_task(&submit_body(), Some("crash-drill-1")).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while server.child.try_wait().ok().flatten().is_none() {
        assert!(tokio::time::Instant::now() < deadline, "the failpoint did not kill the server");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    drop(first);

    let _second = spawn_server(&bin, &config);
    wait_for_port(port, Duration::from_secs(20)).await;
    let author = client_from_key(&base, &author_key, None);
    let task =
        eventually("idempotent resubmission", Duration::from_secs(20), || async { author.submit_task(&submit_body(), Some("crash-drill-1")).await.ok() }).await;
    let listed = admin.get("/v1/admin/tasks").await.unwrap();
    assert_eq!(listed["tasks"].as_array().unwrap().len(), 1, "the retry returned the committed task; no duplicate exists");

    let reviewer = client_from_key(&base, &reviewer_key, Some(&runtime));
    let info = eventually("connection info", Duration::from_secs(20), || async { reviewer.get("/v1/connection").await.ok() }).await;
    let n = &info["nats"];
    let client = async_nats::ConnectOptions::with_user_and_password(n["user"].as_str().unwrap().into(), n["password"].as_str().unwrap().into())
        .connect(n["url"].as_str().unwrap())
        .await
        .unwrap();
    let stream = async_nats::jetstream::new(client).get_stream(n["workStream"].as_str().unwrap()).await.unwrap();
    let consumer = stream.get_consumer::<async_nats::jetstream::consumer::pull::Config>(n["poolConsumers"][0]["consumer"].as_str().unwrap()).await.unwrap();
    let (msg, payload) = next_message(&consumer, Duration::from_secs(20)).await.expect("the lost publish is replayed from the outbox");
    msg.ack().await.ok();
    assert_eq!(payload["taskId"], task.task_id);
    drop(nats);
}
