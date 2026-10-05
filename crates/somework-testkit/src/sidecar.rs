//! Helpers for driving the real `somework-sidecar` binary: key files, a stdio MCP client and worker processes.

use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::OnceLock,
};

use ed25519_dalek::SigningKey;
use serde_json::{Value, json};
use somework_core::jws;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};

use crate::{Agent, process::repo_root};

/// Builds (once) and returns the path of the sidecar binary.
pub fn sidecar_binary() -> PathBuf {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let status = std::process::Command::new(env!("CARGO"))
            .args(["build", "-q", "-p", "somework-sidecar"])
            .current_dir(repo_root())
            .status()
            .expect("cargo build sidecar");
        assert!(status.success(), "building somework-sidecar failed");
        let target = std::env::var_os("CARGO_TARGET_DIR").map(PathBuf::from).unwrap_or_else(|| repo_root().join("target"));
        let path = target.join("debug/somework-sidecar");
        assert!(path.exists(), "{} not found", path.display());
        path
    })
    .clone()
}

pub fn write_key_file(dir: &Path, kind: &str, id: &str, domain_id: &str, key: &SigningKey) -> PathBuf {
    let path = dir.join(format!("{}.key.json", id.replace('/', "_")));
    let doc = json!({"kind": kind, "id": id, "domainId": domain_id, "privateKey": jws::signing_key_to_b64(key), "publicKey": jws::verifying_key_to_b64(&key.verifying_key())});
    std::fs::write(&path, serde_json::to_string_pretty(&doc).unwrap()).unwrap();
    path
}

pub fn agent_key_file(dir: &Path, agent: &Agent) -> PathBuf {
    write_key_file(dir, "agent", &agent.id, &agent.domain_id, &agent.key)
}

/// Writes an executable adapter script and returns its path.
pub fn write_script(dir: &Path, name: &str, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

pub struct McpProcess {
    pub child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    /// Everything the server ever printed (for "no secrets in output" assertions).
    pub transcript: String,
}

impl McpProcess {
    pub async fn spawn(base_url: &str, key_file: &Path, extra_args: &[&str]) -> Self {
        let mut cmd = Command::new(sidecar_binary());
        cmd.args(["run", "--mode", "mcp", "--domain-url", base_url, "--key-file"]).arg(key_file).args(extra_args);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        let mut child = cmd.spawn().expect("spawn sidecar");
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let mut p = Self { child, stdin, stdout, next_id: 1, transcript: String::new() };
        let init = p.request("initialize", json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}})).await;
        assert_eq!(init["result"]["protocolVersion"], "2025-06-18", "{init}");
        p.notify("notifications/initialized", json!({})).await;
        p
    }

    pub async fn notify(&mut self, method: &str, params: Value) {
        let line = json!({"jsonrpc": "2.0", "method": method, "params": params}).to_string();
        self.stdin.write_all(line.as_bytes()).await.unwrap();
        self.stdin.write_all(b"\n").await.unwrap();
        self.stdin.flush().await.unwrap();
    }

    pub async fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let line = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string();
        self.stdin.write_all(line.as_bytes()).await.unwrap();
        self.stdin.write_all(b"\n").await.unwrap();
        self.stdin.flush().await.unwrap();
        loop {
            let mut buf = String::new();
            let n = self.stdout.read_line(&mut buf).await.unwrap();
            assert!(n > 0, "sidecar closed stdout");
            self.transcript.push_str(&buf);
            let v: Value = serde_json::from_str(buf.trim()).expect("server emits JSON per line");
            if v["id"] == json!(id) {
                return v;
            }
        }
    }

    /// Calls a tool; returns `(is_error, structuredContent)`.
    pub async fn tool(&mut self, name: &str, args: Value) -> (bool, Value) {
        let r = self.request("tools/call", json!({"name": name, "arguments": args})).await;
        let result = &r["result"];
        assert!(result.is_object(), "tools/call must return a result: {r}");
        (result["isError"].as_bool().unwrap_or(false), result["structuredContent"].clone())
    }

    pub async fn ok(&mut self, name: &str, args: Value) -> Value {
        let (is_err, v) = self.tool(name, args).await;
        assert!(!is_err, "tool {name} failed: {v}");
        v
    }
}

/// A sidecar in worker mode (separate process) with an exec adapter.
pub struct WorkerProcess {
    pub child: Child,
}

impl WorkerProcess {
    pub fn spawn(base_url: &str, key_file: &Path, adapter: &Path, lease_seconds: u64) -> Self {
        let mut cmd = Command::new(sidecar_binary());
        cmd.args(["run", "--mode", "worker", "--wake", "poll", "--domain-url", base_url, "--key-file"])
            .arg(key_file)
            .args(["--lease-seconds", &lease_seconds.to_string(), "--exec"])
            .arg(adapter);
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
        Self { child: cmd.spawn().expect("spawn worker sidecar") }
    }

    pub fn pid(&self) -> u32 {
        self.child.id().expect("pid")
    }

    pub async fn kill9(&mut self) {
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
    }

    pub fn signal(&self, sig: &str) {
        let _ = std::process::Command::new("kill").arg(format!("-{sig}")).arg(self.pid().to_string()).status();
    }
}
