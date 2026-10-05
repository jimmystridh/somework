//! A real `nats-server` (JetStream) child process with the generated per-domain-account configuration.

use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use somework_nats::{
    NatsConfig,
    conf::{ServerConfSpec, ServerTls, server_conf, write_private},
};
use tempfile::TempDir;

use crate::{
    pki::Ca,
    process::{ChildGuard, free_port, tool, wait_for_port},
};

pub const ADMIN_USER: &str = "somework-domain";
pub const ADMIN_PASSWORD: &str = "admin-secret-for-tests";

pub struct NatsServer {
    dir: TempDir,
    pub port: u16,
    domain_id: String,
    child: Option<ChildGuard>,
    tls: bool,
}

impl NatsServer {
    pub async fn start(domain_id: &str) -> Self {
        Self::start_with(domain_id, None).await
    }

    /// A broker that only speaks TLS, with a certificate for `127.0.0.1` issued by `ca`. The CA certificate is written
    /// to [`NatsServer::ca_file`].
    pub async fn start_tls(domain_id: &str, ca: &Ca) -> Self {
        Self::start_with(domain_id, Some(ca)).await
    }

    async fn start_with(domain_id: &str, ca: Option<&Ca>) -> Self {
        let dir = TempDir::new().expect("tempdir");
        let port = free_port();
        let mut server = Self { dir, port, domain_id: domain_id.into(), child: None, tls: ca.is_some() };
        if let Some(ca) = ca {
            let leaf = ca.leaf("nats");
            write_private(&server.dir.path().join("server.pem"), &leaf.cert_pem).expect("write server cert");
            write_private(&server.dir.path().join("server.key"), &leaf.key_pem).expect("write server key");
            write_private(&server.ca_file(), &ca.cert_pem).expect("write ca");
        }
        // the users file starts with only the admin user; the plane adds agents and reloads
        let users = somework_nats::conf::NatsConfigGenerator::new(somework_nats::conf::CredentialSecret::from_master_key("unused")).users_fragment(
            ADMIN_USER,
            ADMIN_PASSWORD,
            &[],
        );
        write_private(&server.users_file(), &users).expect("write users");
        server.write_conf();
        server.spawn().await;
        server
    }

    pub fn ca_file(&self) -> PathBuf {
        self.dir.path().join("ca.pem")
    }

    pub fn url(&self) -> String {
        format!("nats://127.0.0.1:{}", self.port)
    }

    pub fn dir(&self) -> &Path {
        self.dir.path()
    }

    pub fn store_dir(&self) -> PathBuf {
        self.dir.path().join("jetstream")
    }

    pub fn users_file(&self) -> PathBuf {
        self.dir.path().join("users.conf")
    }

    pub fn pid_file(&self) -> PathBuf {
        self.dir.path().join("nats.pid")
    }

    fn conf_file(&self) -> PathBuf {
        self.dir.path().join("nats-server.conf")
    }

    fn write_conf(&self) {
        let conf = server_conf(&ServerConfSpec {
            server_name: "somework-test".into(),
            host: "127.0.0.1".into(),
            tls: self.tls.then(|| ServerTls { cert_file: self.dir.path().join("server.pem"), key_file: self.dir.path().join("server.key") }),
            max_file_store: None,
            max_memory_store: None,
            port: self.port,
            store_dir: self.store_dir(),
            domain_id: self.domain_id.clone(),
            users_file: self.users_file(),
            pid_file: Some(self.pid_file()),
            system_user: "sys".into(),
            system_password: "sys-secret".into(),
        });
        write_private(&self.conf_file(), &conf).expect("write nats conf");
    }

    async fn spawn(&mut self) {
        let mut cmd = Command::new(tool("nats-server"));
        cmd.arg("-c").arg(self.conf_file());
        self.child = Some(ChildGuard::spawn("nats-server", cmd));
        wait_for_port(self.port, Duration::from_secs(10)).await;
        // JetStream finishes recovering shortly after the port opens
        tokio::time::sleep(Duration::from_millis(300)).await;
    }

    /// Stops the server process; JetStream state stays on disk.
    pub fn stop(&mut self) {
        if let Some(mut c) = self.child.take() {
            c.kill();
        }
    }

    pub async fn restart(&mut self) {
        self.stop();
        self.spawn().await;
    }

    pub fn is_running(&self) -> bool {
        self.child.is_some()
    }

    /// Deletes JetStream state (simulates losing the broker's storage).
    pub fn wipe_store(&self) {
        let _ = std::fs::remove_dir_all(self.store_dir());
    }

    /// Plane configuration that points at this server and reloads it through its pid file.
    pub fn plane_config(&self) -> NatsConfig {
        NatsConfig {
            url: self.url(),
            user: Some(ADMIN_USER.into()),
            password: Some(ADMIN_PASSWORD.into()),
            users_file: Some(self.users_file()),
            reload_command: Some(vec!["sh".into(), "-c".into(), format!("kill -HUP $(cat {})", self.pid_file().display())]),
            reconcile_interval_ms: 200,
            metrics_interval_ms: 500,
            tls_required: self.tls,
            tls_ca_file: self.tls.then(|| self.ca_file()),
            ..Default::default()
        }
    }
}
