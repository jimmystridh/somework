//! Real MinIO (`tools/bin/minio`) for S3 integration tests: ephemeral data dir, fixed port across restarts.

use std::process::Command;

use somework_core::clock::system_clock;
use somework_domain::objects_s3::{S3Config, S3ObjectStore};
use tempfile::TempDir;

use crate::{
    process::{ChildGuard, eventually, free_port, tool},
    stack::StackBuilder,
};

pub struct MinioServer {
    guard: Option<ChildGuard>,
    pub port: u16,
    console_port: u16,
    data: TempDir,
    pub access_key: String,
    pub secret_key: String,
    pub bucket: String,
}

impl MinioServer {
    pub async fn start() -> Self {
        let mut server = Self {
            guard: None,
            port: free_port(),
            console_port: free_port(),
            data: TempDir::new().expect("minio data dir"),
            access_key: "somework-access".into(),
            secret_key: "somework-secret-key".into(),
            bucket: "somework-artifacts".into(),
        };
        server.spawn();
        server.ensure_bucket().await;
        server
    }

    fn spawn(&mut self) {
        let mut cmd = Command::new(tool("minio"));
        cmd.arg("server")
            .arg(self.data.path())
            .arg("--address")
            .arg(format!("127.0.0.1:{}", self.port))
            .arg("--console-address")
            .arg(format!("127.0.0.1:{}", self.console_port))
            .env("MINIO_ROOT_USER", &self.access_key)
            .env("MINIO_ROOT_PASSWORD", &self.secret_key)
            .env("MINIO_BROWSER", "off");
        self.guard = Some(ChildGuard::spawn("minio", cmd));
    }

    pub fn endpoint(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn s3_config(&self) -> S3Config {
        S3Config {
            endpoint: self.endpoint(),
            region: "us-east-1".into(),
            bucket: self.bucket.clone(),
            access_key: self.access_key.clone(),
            secret_key: self.secret_key.clone(),
            path_style: true,
            multipart_threshold_bytes: 5 * 1024 * 1024,
            part_size_bytes: 5 * 1024 * 1024,
        }
    }

    pub fn store(&self) -> S3ObjectStore {
        S3ObjectStore::new(self.s3_config(), system_clock()).expect("s3 store")
    }

    async fn ensure_bucket(&self) {
        let store = self.store();
        eventually("minio accepts the bucket creation", std::time::Duration::from_secs(30), || async { store.create_bucket().await.ok() }).await;
    }

    /// Kills the process (simulating an S3 outage); data stays on disk.
    pub fn stop(&mut self) {
        if let Some(mut g) = self.guard.take() {
            g.kill();
        }
    }

    pub async fn restart(&mut self) {
        self.stop();
        self.spawn();
        let store = self.store();
        eventually("minio healthy again", std::time::Duration::from_secs(30), || async {
            use somework_domain::objects::ObjectStore;
            store.healthy().await.then_some(())
        })
        .await;
    }
}

/// Builds a stack whose artifacts live in `minio`; `part_size`/`threshold` tune multipart behaviour.
pub fn s3_stack(minio: &MinioServer, threshold: u64, part_size: u64) -> StackBuilder {
    let mut cfg = minio.s3_config();
    cfg.multipart_threshold_bytes = threshold;
    cfg.part_size_bytes = part_size;
    StackBuilder::new().config(move |c| {
        c.objects.kind = Some("s3".into());
        c.objects.s3 = Some(cfg);
    })
}
