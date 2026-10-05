//! What a containerised pilot relies on: graceful termination on SIGTERM, executors that cannot see the sidecar's
//! environment, and a key lifecycle where the private key is generated on the worker host and never travels.

use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

use serde_json::{Value, json};
use somework_client::Client;
use somework_core::{contracts::SideEffects, fsm::TaskState};
use somework_domain::policy::Permissions;
use somework_testkit::{
    Stack, capability,
    process::{ChildGuard, eventually, free_port, repo_root, wait_for_port},
    sidecar::{agent_key_file, sidecar_binary, write_script},
};

fn read_perms() -> Permissions {
    let mut p = Permissions::default_agent();
    p.side_effects_at_most = Some(SideEffects::Read);
    p
}

fn review_input() -> Value {
    json!({"capability": {"id": "code.review", "version": "2.1"}, "input": {"repository": "billing/import-service", "commit": "61a8d52"}})
}

async fn reviewer_stack() -> (Stack, somework_testkit::Agent, somework_testkit::Agent) {
    let stack = Stack::start().await;
    let worker = stack.worker("agent/reviewer", vec![capability("code.review", "2.1", "read", "Review pull requests")], read_perms()).await;
    let author = stack.requester("agent/author", &["code.review"], SideEffects::Read).await;
    (stack, worker, author)
}

fn worker_command(base_url: &str, key_file: &Path, script: &Path) -> Command {
    let mut cmd = Command::new(sidecar_binary());
    cmd.args(["run", "--mode", "worker", "--wake", "poll", "--domain-url", base_url, "--key-file"]).arg(key_file).arg("--exec").arg(script);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    cmd
}

async fn active_runtimes(stack: &Stack, agent: &str) -> usize {
    let runtimes = stack.admin.get("/v1/runtimes").await.unwrap();
    runtimes["runtimes"].as_array().unwrap().iter().filter(|r| r["agentId"] == agent && r["status"] == "active").count()
}

#[tokio::test]
async fn sigterm_stops_the_worker_gracefully_and_ends_its_runtime() {
    let (stack, worker, _author) = reviewer_stack().await;
    let script = write_script(stack.dir.path(), "idle.sh", "cat >/dev/null; echo '{\"type\":\"result\",\"result\":{\"verdict\":\"approve\"}}'");
    let baseline = active_runtimes(&stack, "agent/reviewer").await;
    let mut child =
        tokio::process::Command::from(worker_command(&stack.url, &agent_key_file(stack.dir.path(), &worker), &script)).kill_on_drop(true).spawn().unwrap();
    eventually("the sidecar registers its own runtime", Duration::from_secs(20), || async {
        (active_runtimes(&stack, "agent/reviewer").await == baseline + 1).then_some(())
    })
    .await;

    // what `docker stop` sends
    Command::new("kill").arg("-TERM").arg(child.id().unwrap().to_string()).status().unwrap();
    let status = tokio::time::timeout(Duration::from_secs(15), child.wait()).await.expect("the sidecar exits on SIGTERM").unwrap();
    assert!(status.success(), "a clean exit, not death by signal: {status:?}");
    assert_eq!(active_runtimes(&stack, "agent/reviewer").await, baseline, "the sidecar's runtime is ended on the way out");
    stack.stop().await;
}

#[tokio::test]
async fn executors_do_not_inherit_the_sidecars_environment() {
    let (stack, worker, author) = reviewer_stack().await;
    let script = write_script(
        stack.dir.path(),
        "env.sh",
        r#"cat >/dev/null
printf '{"type":"result","result":{"verdict":"approve","leaked":"%s","keyFile":"%s","path":"%s"}}\n' "$PILOT_SECRET" "$SOMEWORK_KEY_FILE" "$PATH""#,
    );
    let key_file = agent_key_file(stack.dir.path(), &worker);
    let mut cmd = worker_command(&stack.url, &key_file, &script);
    cmd.env("PILOT_SECRET", "hunter2").env("SOMEWORK_KEY_FILE", &key_file);
    let _child = ChildGuard::spawn("sidecar", cmd);

    let task = author.client.submit_task(&review_input(), None).await.unwrap();
    let done = eventually("the task to succeed", Duration::from_secs(30), || async {
        let t = author.client.get_task(&task.task_id).await.ok()?;
        (t.state == TaskState::Succeeded).then_some(t)
    })
    .await;
    let result = done.result.unwrap();
    assert_eq!(result["leaked"], "", "a variable set on the sidecar must not reach the executor: {result}");
    assert_eq!(result["keyFile"], "", "the key file location must not reach the executor: {result}");
    assert!(!result["path"].as_str().unwrap().is_empty(), "PATH is on the default allowlist");
    stack.stop().await;
}

fn somework_binary() -> PathBuf {
    let status =
        Command::new(env!("CARGO")).args(["build", "-q", "-p", "somework-api", "--bin", "somework"]).current_dir(repo_root()).status().expect("cargo build");
    assert!(status.success(), "building the somework binary failed");
    let target = std::env::var_os("CARGO_TARGET_DIR").map(PathBuf::from).unwrap_or_else(|| repo_root().join("target"));
    target.join("debug/somework")
}

fn admin(bin: &Path, config: &Path, args: &[&str]) -> std::process::Output {
    Command::new(bin).arg("admin").arg("--config").arg(config).args(args).output().unwrap()
}

fn keygen(id: &str, out: &Path) -> Value {
    let output = Command::new(sidecar_binary()).args(["keygen", "--id", id, "--key-out"]).arg(out).output().unwrap();
    assert!(output.status.success(), "keygen failed: {}", String::from_utf8_lossy(&output.stderr));
    serde_json::from_slice(&output.stdout).unwrap()
}

fn client_for(base: &str, key_file: &Path) -> Client {
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(key_file).unwrap()).unwrap();
    let key = somework_core::jws::signing_key_from_b64(doc["privateKey"].as_str().unwrap()).unwrap();
    Client::assertion(base, key, "agent", doc["id"].as_str().unwrap(), "development").with_retries(0)
}

#[tokio::test]
async fn the_private_key_is_generated_on_the_worker_host_and_registered_by_public_key_only() {
    let bin = somework_binary();
    let dir = tempfile::tempdir().unwrap();
    let port = free_port();
    let config = dir.path().join("somework.toml");
    std::fs::write(
        &config,
        format!(
            "[domain]\nid = \"development\"\ndb = \"{}\"\nlisten = \"127.0.0.1:{port}\"\npublic_url = \"http://127.0.0.1:{port}\"\nsynchronous_full = false\n[objects]\ndir = \"{}\"\n",
            dir.path().join("somework.db").display(),
            dir.path().join("objects").display()
        ),
    )
    .unwrap();
    assert!(admin(&bin, &config, &["bootstrap", "--key-out", dir.path().join("root.key.json").to_str().unwrap()]).status.success());
    let mut serve = Command::new(&bin);
    serve.arg("serve").arg("--config").arg(&config);
    let _server = ChildGuard::spawn("somework", serve);
    wait_for_port(port, Duration::from_secs(20)).await;
    let base = format!("http://127.0.0.1:{port}");

    // the worker host generates its own key, in a private directory, and hands over only the public half
    let first_key = dir.path().join("worker-keys").join("pilot.key.json");
    let generated = keygen("agent/pilot", &first_key);
    let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!((mode(&first_key), mode(first_key.parent().unwrap())), (0o600, 0o700));
    assert!(
        !generated.to_string().contains(&std::fs::read_to_string(&first_key).unwrap().split("privateKey\": \"").nth(1).unwrap()[..16]),
        "keygen output carries no private key"
    );
    assert!(!keygen_overwrite_allowed(&first_key), "keygen must not overwrite an existing key");

    let pk = generated["publicKey"].as_str().unwrap();
    let enrolled = admin(&bin, &config, &["enroll-agent", "--id", "agent/pilot", "--public-key", pk]);
    assert!(enrolled.status.success(), "{}", String::from_utf8_lossy(&enrolled.stderr));
    let both = admin(&bin, &config, &["enroll-agent", "--id", "agent/x", "--public-key", pk, "--key-out", dir.path().join("x.json").to_str().unwrap()]);
    assert!(!both.status.success(), "--key-out and --public-key are mutually exclusive");

    let who = client_for(&base, &first_key).get("/v1/admin/whoami").await.expect("the registered public key authenticates the worker");
    assert_eq!(who["actor"]["id"], "agent/pilot");

    // rotation: stop, replace the registered public key, start with the new key; the old key stops working at once
    let second_key = dir.path().join("worker-keys").join("pilot-2.key.json");
    let rotated_pk = keygen("agent/pilot", &second_key)["publicKey"].as_str().unwrap().to_string();
    assert!(admin(&bin, &config, &["rotate-agent-key", "--id", "agent/pilot", "--public-key", &rotated_pk]).status.success());
    assert!(client_for(&base, &first_key).get("/v1/admin/whoami").await.is_err(), "the replaced key is dead");
    assert!(client_for(&base, &second_key).get("/v1/admin/whoami").await.is_ok());

    // widening an enrolled agent's permissions does not require a new key
    assert!(admin(&bin, &config, &["set-agent-permissions", "--id", "agent/pilot", "--may-invoke", "code.*"]).status.success());
    assert!(client_for(&base, &second_key).get("/v1/admin/whoami").await.is_ok(), "the same key keeps working after a permission change");
    assert!(
        !admin(&bin, &config, &["set-agent-permissions", "--id", "agent/nobody", "--may-invoke", "code.*"]).status.success(),
        "an unknown agent is an error"
    );

    // kill switch
    assert!(admin(&bin, &config, &["set-agent-status", "--id", "agent/pilot", "--status", "disabled"]).status.success());
    assert!(client_for(&base, &second_key).get("/v1/admin/whoami").await.is_err(), "a disabled agent cannot authenticate");
    assert!(admin(&bin, &config, &["set-agent-status", "--id", "agent/pilot", "--status", "active"]).status.success());
    assert!(client_for(&base, &second_key).get("/v1/admin/whoami").await.is_ok());
}

fn keygen_overwrite_allowed(existing: &Path) -> bool {
    Command::new(sidecar_binary()).args(["keygen", "--id", "agent/pilot", "--key-out"]).arg(existing).output().unwrap().status.success()
}
