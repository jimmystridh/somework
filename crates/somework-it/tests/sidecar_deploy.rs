//! What a containerised pilot relies on: a key lifecycle where the private key is generated on the agent host and never travels.

use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use serde_json::Value;
use somework_client::Client;
use somework_testkit::{
    process::{ChildGuard, free_port, repo_root, wait_for_port},
    sidecar::sidecar_binary,
};

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
async fn the_private_key_is_generated_on_the_agent_host_and_registered_by_public_key_only() {
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
    assert!(admin(&bin, &config, &["set-agent-permissions", "--id", "agent/pilot", "--classification", "confidential"]).status.success());
    assert!(client_for(&base, &second_key).get("/v1/admin/whoami").await.is_ok(), "the same key keeps working after a permission change");
    assert!(
        !admin(&bin, &config, &["set-agent-permissions", "--id", "agent/nobody", "--classification", "confidential"]).status.success(),
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
