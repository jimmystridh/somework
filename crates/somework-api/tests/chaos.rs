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
use somework_client::{Client, TaskInfo};
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

fn capability() -> Value {
    json!({
        "id": "code.review", "version": "2.1", "name": "Code review", "description": "Review pull requests",
        "inputSchema": {"type": "object", "required": ["repository"], "properties": {"repository": {"type": "string"}}},
        "outputSchema": {"type": "object", "required": ["verdict"], "properties": {"verdict": {"type": "string"}}},
        "sideEffects": "read"
    })
}

async fn provision(dep: &Deployment, base: &str) {
    dep.cli(&["admin", "enroll-agent", "--id", "agent/author", "--may-invoke", "code.review", "--key-out", dep.key("author").to_str().unwrap()]);
    dep.cli(&["admin", "enroll-agent", "--id", "agent/reviewer", "--key-out", dep.key("reviewer").to_str().unwrap()]);
    let reviewer = dep.client("reviewer", base, None);
    let card = json!({"schemaVersion": "1.0", "agentId": "agent/reviewer", "domainId": "development", "displayName": "reviewer", "description": "Reviews code", "owner": {"team": "t"}, "capabilities": [capability()], "interfaces": [{"protocol": "somework"}]});
    reviewer.register_agent(&card).await.unwrap();
    let admin = dep.client("admin", base, None);
    admin.post("/v1/agents/agent%2Freviewer/approval", &json!({"status": "approved"})).await.unwrap();
}

fn submit_body(i: usize) -> Value {
    json!({"capability": {"id": "code.review", "version": "2.1"}, "input": {"repository": format!("repo-{i}")}})
}

#[tokio::test]
async fn a_pod_dying_after_commit_but_before_responding_loses_nothing_and_retry_dedupes() {
    let dep = Deployment::new();
    let mut a = dep.start(Some("task.submit.after_commit=exit"));
    wait_ready(&a.url).await;
    provision(&dep, &a.url).await;
    let b = dep.start(None);
    wait_ready(&b.url).await;

    let author_a = dep.client("author", &a.url, None);
    let outcome = author_a.submit_task(&submit_body(1), Some("review-pr-729")).await;
    assert!(outcome.is_err(), "replica A died before answering");
    let _ = a.child.wait();

    // the client retries against the surviving replica with the same Idempotency-Key
    let author_b = dep.client("author", &b.url, None);
    let retried = author_b.submit_task(&submit_body(1), Some("review-pr-729")).await.expect("retry succeeds");
    let again = author_b.submit_task(&submit_body(1), Some("review-pr-729")).await.unwrap();
    assert_eq!(retried.task_id, again.task_id);
    let all = author_b.get("/v1/tasks").await.unwrap();
    assert_eq!(all["tasks"].as_array().unwrap().len(), 1, "committed exactly once");
    assert_eq!(retried.revision, 2, "the retried response is the committed result: queued at revision 2");
}

#[tokio::test]
async fn killing_one_replica_under_load_never_loses_an_acknowledged_task() {
    let dep = Deployment::new();
    let mut a = dep.start(None);
    wait_ready(&a.url).await;
    provision(&dep, &a.url).await;
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
        let key = format!("load-{i}");
        let client = if i % 2 == 0 && i < 60 { &author_a } else { &author_b };
        match client.submit_task(&submit_body(i), Some(&key)).await {
            Ok(t) => acknowledged.push((i, t.task_id)),
            Err(_) => pending_retry.push(i),
        }
    }
    // unacknowledged submissions are retried with their keys against the survivor
    for i in pending_retry {
        let t = author_b.submit_task(&submit_body(i), Some(&format!("load-{i}"))).await.expect("retry");
        acknowledged.push((i, t.task_id));
    }
    let listed = author_b.get("/v1/tasks?limit=200").await.unwrap();
    let ids: HashSet<String> = listed["tasks"].as_array().unwrap().iter().map(|t| t["taskId"].as_str().unwrap().to_string()).collect();
    assert_eq!(acknowledged.len(), 120);
    for (i, id) in &acknowledged {
        assert!(ids.contains(id), "acknowledged task {i} ({id}) vanished");
    }
    assert_eq!(ids.len(), 120, "no duplicates were created by retries");
    // the survivor still serves workers normally
    let reviewer = dep.client("reviewer", &b.url, Some("rt_survivor"));
    reviewer.register_runtime(json!({})).await.unwrap();
    let next = reviewer.next_tasks(0).await.unwrap();
    assert!(!next.is_empty());
}

#[tokio::test]
async fn a_worker_lost_with_its_lease_is_recovered_by_a_different_replica() {
    let dep = Deployment::new();
    let mut a = dep.start(None);
    wait_ready(&a.url).await;
    provision(&dep, &a.url).await;
    let author = dep.client("author", &a.url, None);
    let t = author.submit_task(&submit_body(1), None).await.unwrap();
    let w1 = dep.client("reviewer", &a.url, Some("rt_one"));
    w1.register_runtime(json!({})).await.unwrap();
    let claim = w1.claim_task(&t.task_id, Some(2)).await.unwrap();
    assert_eq!(claim.fencing_token, 1);
    // the replica that granted the lease dies; the worker is never heard from again
    a.kill();
    let b = dep.start(None);
    wait_ready(&b.url).await;
    let author_b = dep.client("author", &b.url, None);
    let requeued: TaskInfo = {
        let mut out = None;
        for _ in 0..100 {
            let cur = author_b.get_task(&t.task_id).await.unwrap();
            if cur.attempt == 2 {
                out = Some(cur);
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        out.expect("the surviving replica's maintenance re-queued the task after lease expiry")
    };
    assert_eq!(format!("{:?}", requeued.state), "Queued");
    let w2 = dep.client("reviewer", &b.url, Some("rt_two"));
    w2.register_runtime(json!({})).await.unwrap();
    let claim2 = w2.claim_task(&t.task_id, Some(30)).await.unwrap();
    assert_eq!(claim2.fencing_token, 2);
    // the old worker, if it ever returns, is fenced out
    let old_worker_returns = dep.client("reviewer", &b.url, Some("rt_one"));
    let stale = old_worker_returns.complete_task(&t.task_id, 1, &json!({"verdict": "approve"}), &[]).await.unwrap_err();
    assert!(matches!(stale.status, 409 | 401), "{stale:?}");
}

#[tokio::test]
async fn a_single_node_restart_after_sigkill_recovers_from_the_wal() {
    let dep = Deployment::new();
    let mut a = dep.start(None);
    wait_ready(&a.url).await;
    provision(&dep, &a.url).await;
    let author = dep.client("author", &a.url, None);
    let mut ids = vec![];
    for i in 0..25 {
        ids.push(author.submit_task(&submit_body(i), Some(&format!("k{i}"))).await.unwrap().task_id);
    }
    a.kill();
    let b = dep.start(None);
    wait_ready(&b.url).await;
    let author = dep.client("author", &b.url, None);
    for id in &ids {
        assert_eq!(format!("{:?}", author.get_task(id).await.unwrap().state), "Queued");
    }
    // idempotency keys survive restarts too
    let again = author.submit_task(&submit_body(3), Some("k3")).await.unwrap();
    assert_eq!(again.task_id, ids[3]);
    let _ = (Path::new("."), &dep.config);
}
