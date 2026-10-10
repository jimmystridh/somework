//! Chaos tests against real `somework` server processes sharing one SQLite database (the "replicas" of a
//! single-node SQLite deployment): pods are killed with SIGKILL at precisely chosen points.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::Duration,
};

use serde_json::{Value, json};
use somework_api::cli::KeyFile;
use somework_client::Client;
use tempfile::TempDir;

const BIN: &str = env!("CARGO_BIN_EXE_somework");

struct Server {
    child: Child,
    url: String,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Server {
    fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

struct Deployment {
    dir: TempDir,
    config: PathBuf,
}

impl Deployment {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let config = dir.path().join("somework.toml");
        std::fs::write(
            &config,
            format!(
                "[domain]\nid = \"development\"\ndb = \"{}\"\nlisten = \"127.0.0.1:0\"\npublic_url = \"http://127.0.0.1:0\"\nsynchronous_full = true\nmaintenance_interval_ms = 100\n[objects]\ndir = \"{}\"\n",
                dir.path().join("somework.db").display(),
                dir.path().join("objects").display()
            ),
        )
        .unwrap();
        let d = Self { dir, config };
        d.cli(&["admin", "bootstrap", "--key-out", d.key("admin").to_str().unwrap()]);
        d
    }

    fn key(&self, name: &str) -> PathBuf {
        self.dir.path().join(format!("{name}.key.json"))
    }

    fn cli(&self, args: &[&str]) {
        let status =
            Command::new(BIN).arg("admin").args(["--config", self.config.to_str().unwrap()]).args(&args[1..]).stdout(Stdio::null()).status().expect("run cli");
        assert!(status.success(), "cli {args:?} failed");
    }

    fn start(&self, failpoints: Option<&str>) -> Server {
        let port = free_port();
        let cfg = std::fs::read_to_string(&self.config)
            .unwrap()
            .replace("127.0.0.1:0\"\npublic_url = \"http://127.0.0.1:0", &format!("127.0.0.1:{port}\"\npublic_url = \"http://127.0.0.1:{port}"));
        let path = self.dir.path().join(format!("server-{port}.toml"));
        std::fs::write(&path, cfg).unwrap();
        let mut cmd = Command::new(BIN);
        cmd.args(["serve", "--config", path.to_str().unwrap()]).stdout(Stdio::null()).stderr(Stdio::null());
        if let Some(fp) = failpoints {
            cmd.env("SOMEWORK_FAILPOINTS", fp);
        }
        let child = cmd.spawn().expect("spawn server");
        Server { child, url: format!("http://127.0.0.1:{port}") }
    }

    fn client(&self, name: &str, base: &str, runtime: Option<&str>) -> Client {
        let kf = KeyFile::read(&self.key(name)).unwrap();
        let c = Client::assertion(base, kf.signing_key().unwrap(), &kf.kind, &kf.id, &kf.domain_id).with_retries(0);
        match runtime {
            Some(rt) => c.with_runtime(rt),
            None => c,
        }
    }
}

async fn wait_ready(url: &str) {
    let http = reqwest::Client::new();
    for _ in 0..200 {
        if http.get(format!("{url}/healthz")).send().await.map(|r| r.status().is_success()).unwrap_or(false) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("server at {url} did not become ready");
}

async fn provision(dep: &Deployment) {
    dep.cli(&["admin", "enroll-agent", "--id", "agent/author", "--key-out", dep.key("author").to_str().unwrap()]);
    dep.cli(&["admin", "enroll-agent", "--id", "agent/reviewer", "--key-out", dep.key("reviewer").to_str().unwrap()]);
}

fn message(i: usize) -> Value {
    json!({"recipients": [{"kind": "agent", "id": "agent/reviewer"}], "content": {"mediaType": "text/plain", "data": format!("please review repo-{i}")}})
}

async fn send(client: &Client, i: usize, key: &str) -> somework_client::Result<String> {
    let sent = client.post_idem("/v1/messages", &message(i), key).await?;
    Ok(sent["messageId"].as_str().unwrap().to_string())
}

async fn inbox_ids(reviewer: &Client) -> HashSet<String> {
    let inbox = reviewer.get("/v1/inbox?limit=500").await.unwrap();
    inbox["messages"].as_array().unwrap().iter().map(|m| m["messageId"].as_str().unwrap().to_string()).collect()
}

#[tokio::test]
async fn a_pod_dying_after_commit_but_before_responding_loses_nothing_and_retry_dedupes() {
    let dep = Deployment::new();
    let mut a = dep.start(Some("message.send.after_commit=exit"));
    wait_ready(&a.url).await;
    provision(&dep).await;
    let b = dep.start(None);
    wait_ready(&b.url).await;

    let author_a = dep.client("author", &a.url, None);
    let outcome = send(&author_a, 1, "review-pr-729").await;
    assert!(outcome.is_err(), "replica A died before answering");
    let _ = a.child.wait();

    // the client retries against the surviving replica with the same Idempotency-Key
    let author_b = dep.client("author", &b.url, None);
    let retried = send(&author_b, 1, "review-pr-729").await.expect("retry succeeds");
    let again = send(&author_b, 1, "review-pr-729").await.unwrap();
    assert_eq!(retried, again);
    let reviewer = dep.client("reviewer", &b.url, None);
    assert_eq!(inbox_ids(&reviewer).await, HashSet::from([retried]), "committed exactly once");
}

#[tokio::test]
async fn killing_one_replica_under_load_never_loses_an_acknowledged_message() {
    let dep = Deployment::new();
    let mut a = dep.start(None);
    wait_ready(&a.url).await;
    provision(&dep).await;
    let b = dep.start(None);
    wait_ready(&b.url).await;

    let author_a = dep.client("author", &a.url, None);
    let author_b = dep.client("author", &b.url, None);
    let mut acknowledged: Vec<(usize, String)> = vec![];
    let mut pending_retry: Vec<usize> = vec![];
    for i in 0..120 {
        if i == 60 {
            a.kill();
        }
        let client = if i % 2 == 0 && i < 60 { &author_a } else { &author_b };
        match send(client, i, &format!("load-{i}")).await {
            Ok(id) => acknowledged.push((i, id)),
            Err(_) => pending_retry.push(i),
        }
    }
    // unacknowledged sends are retried with their keys against the survivor
    for i in pending_retry {
        let id = send(&author_b, i, &format!("load-{i}")).await.expect("retry");
        acknowledged.push((i, id));
    }
    let reviewer = dep.client("reviewer", &b.url, None);
    let ids = inbox_ids(&reviewer).await;
    assert_eq!(acknowledged.len(), 120);
    for (i, id) in &acknowledged {
        assert!(ids.contains(id), "acknowledged message {i} ({id}) vanished");
    }
    assert_eq!(ids.len(), 120, "no duplicates were created by retries");
}

#[tokio::test]
async fn a_single_node_restart_after_sigkill_recovers_from_the_wal() {
    let dep = Deployment::new();
    let mut a = dep.start(None);
    wait_ready(&a.url).await;
    provision(&dep).await;
    let author = dep.client("author", &a.url, None);
    let mut ids = vec![];
    for i in 0..25 {
        ids.push(send(&author, i, &format!("k{i}")).await.unwrap());
    }
    a.kill();
    let b = dep.start(None);
    wait_ready(&b.url).await;
    let author = dep.client("author", &b.url, None);
    let reviewer = dep.client("reviewer", &b.url, None);
    let stored = inbox_ids(&reviewer).await;
    for id in &ids {
        assert!(stored.contains(id), "{id} lost across the restart");
    }
    // idempotency keys survive restarts too
    assert_eq!(send(&author, 3, "k3").await.unwrap(), ids[3]);
    let _ = (Path::new("."), &dep.config);
}
