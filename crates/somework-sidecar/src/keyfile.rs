use std::path::Path;

use anyhow::{Context, Result};
use ed25519_dalek::SigningKey;
use serde::{Deserialize, Serialize};
use somework_core::jws;

/// Workload key file written by `somework admin enroll-agent`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyFile {
    pub kind: String,
    pub id: String,
    pub domain_id: String,
    pub private_key: String,
    pub public_key: String,
}

impl KeyFile {
    /// A fresh identity. The private key is created here and never needs to leave the machine that runs the worker:
    /// only [`KeyFile::public_key`] is registered with the domain.
    pub fn generate(kind: &str, id: &str, domain_id: &str) -> Self {
        let key = jws::new_signing_key();
        Self {
            kind: kind.into(),
            id: id.into(),
            domain_id: domain_id.into(),
            private_key: jws::signing_key_to_b64(&key),
            public_key: jws::verifying_key_to_b64(&key.verifying_key()),
        }
    }

    /// Creates the file with mode 0600 from the first byte (inside a 0700 directory if the directory is new) and refuses
    /// to overwrite an existing key.
    pub fn create_new(&self, path: &Path) -> Result<()> {
        use std::io::Write;
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty() && !d.exists()) {
            let mut builder = std::fs::DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder.create(dir).with_context(|| format!("create {}", dir.display()))?;
        }
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(path).with_context(|| format!("create {} (it must not exist yet)", path.display()))?;
        file.write_all(serde_json::to_string_pretty(self)?.as_bytes())?;
        Ok(())
    }

    pub fn read(path: &Path) -> Result<Self> {
        serde_json::from_str(&std::fs::read_to_string(path).with_context(|| format!("read key file {}", path.display()))?).context("parse key file")
    }

    pub fn signing_key(&self) -> Result<SigningKey> {
        Ok(jws::signing_key_from_b64(&self.private_key)?)
    }

    pub fn client(&self, base_url: &str, runtime_instance_id: &str) -> Result<somework_client::Client> {
        Ok(somework_client::Client::assertion(base_url, self.signing_key()?, &self.kind, &self.id, &self.domain_id).with_runtime(runtime_instance_id))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    #[test]
    fn new_keys_are_private_from_creation_and_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("keys").join("worker.key.json");
        let key = KeyFile::generate("agent", "agent/worker", "development");
        key.create_new(&path).unwrap();

        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(path.parent().unwrap()), 0o700, "a directory created for the key is private");
        assert_eq!(KeyFile::read(&path).unwrap().public_key, key.public_key);
        assert!(key.create_new(&path).is_err(), "an existing key must never be replaced silently");
    }

    #[test]
    fn generated_keys_are_distinct_and_the_public_key_matches() {
        let a = KeyFile::generate("agent", "agent/a", "development");
        let b = KeyFile::generate("agent", "agent/a", "development");
        assert_ne!(a.private_key, b.private_key);
        assert_eq!(a.public_key, jws::verifying_key_to_b64(&a.signing_key().unwrap().verifying_key()));
    }
}
