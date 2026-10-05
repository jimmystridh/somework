//! Child processes for real infrastructure (nats-server, minio): started on free ports, killed on drop.

use std::{
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::Duration,
};

pub fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port").local_addr().expect("local addr").port()
}

/// Repository root (two levels above this crate).
pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().expect("repo root")
}

pub fn tool(name: &str) -> PathBuf {
    let path = repo_root().join("tools/bin").join(name);
    assert!(path.exists(), "{} is missing; run scripts/fetch-tools.sh", path.display());
    path
}

pub struct ChildGuard {
    pub child: Child,
    pub name: String,
}

impl ChildGuard {
    pub fn spawn(name: &str, mut cmd: Command) -> Self {
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
        let child = cmd.spawn().unwrap_or_else(|e| panic!("spawn {name}: {e}"));
        Self { child, name: name.to_string() }
    }

    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    pub fn id(&self) -> u32 {
        self.child.id()
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        self.kill();
    }
}

pub async fn wait_for_port(port: u16, timeout: Duration) {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return;
        }
        assert!(tokio::time::Instant::now() < deadline, "port {port} did not open in {timeout:?}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Polls `check` until it returns `Some`, panicking with `what` after `timeout`.
pub async fn eventually<T, F, Fut>(what: &str, timeout: Duration, mut check: F) -> T
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if let Some(v) = check().await {
            return v;
        }
        assert!(tokio::time::Instant::now() < deadline, "timed out waiting for: {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
