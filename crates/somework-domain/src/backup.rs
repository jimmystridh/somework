//! Consistent online backups and verified restores (BAK-01, BAK-02).
//!
//! A backup is a directory: `somework.db` (a `VACUUM INTO` snapshot, consistent while writers are active),
//! optionally `somework.masterkey`, `objects/` for the filesystem artifact store, and `manifest.json` listing
//! the SHA-256 of every file. JetStream state is deliberately absent: accepted work and outbox rows live in the
//! database and are re-published after a restore.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use somework_core::Error;
use sqlx::{ConnectOptions, Connection, Row, sqlite::SqliteConnectOptions};

use crate::{config::DomainConfig, domain::Domain};

pub const MANIFEST_FILE: &str = "manifest.json";
pub const DB_FILE: &str = "somework.db";
pub const MASTER_KEY_FILE: &str = "somework.masterkey";
pub const OBJECTS_DIR: &str = "objects";
const SAMPLE_ARTIFACTS: i64 = 25;

#[derive(Debug, Clone, Default)]
pub struct BackupOptions {
    /// Root of the filesystem artifact store; `None` for S3 (rely on bucket versioning/replication).
    pub objects_dir: Option<PathBuf>,
    /// Copy the master key file into the backup. Production deployments keep key material elsewhere.
    pub include_master_key: bool,
    /// Free-form description of the artifact store recorded in the manifest (bucket, prefix...).
    pub object_store: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFile {
    pub path: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    pub format: u32,
    pub domain_id: String,
    pub created_at: String,
    pub schema_version: i64,
    pub audit_head: Option<Value>,
    pub queued_tasks: i64,
    pub active_tasks: i64,
    pub total_tasks: i64,
    pub complete_artifacts: i64,
    pub master_key_included: bool,
    pub object_store: Value,
    pub files: Vec<ManifestFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub restore_seconds: f64,
    pub queued_tasks: i64,
    pub audit_intact: bool,
    pub artifacts_verified: usize,
    pub files_verified: usize,
    pub manifest: BackupManifest,
}

fn io_err(what: &str, e: impl std::fmt::Display) -> Error {
    Error::internal(format!("{what}: {e}"))
}

pub fn sha256_file(path: &Path) -> Result<(String, u64), Error> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|e| io_err(&format!("open {}", path.display()), e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut size = 0u64;
    loop {
        let n = file.read(&mut buf).map_err(|e| io_err("read", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        size += n as u64;
    }
    Ok((hex::encode(hasher.finalize()), size))
}

fn walk(root: &Path) -> Vec<PathBuf> {
    let mut out = vec![];
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

/// Immutable objects make hard links safe; fall back to a copy across filesystems.
fn link_or_copy(from: &Path, to: &Path) -> Result<(), Error> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| io_err("create dir", e))?;
    }
    if std::fs::hard_link(from, to).is_err() {
        std::fs::copy(from, to).map_err(|e| io_err("copy object", e))?;
    }
    Ok(())
}

async fn open_snapshot(path: &Path) -> Result<sqlx::SqliteConnection, Error> {
    SqliteConnectOptions::new().filename(path).read_only(true).connect().await.map_err(|e| io_err("open snapshot", e))
}

async fn snapshot_facts(path: &Path) -> Result<(i64, Option<Value>, i64, i64, i64, i64), Error> {
    let mut conn = open_snapshot(path).await?;
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check").fetch_one(&mut conn).await.map_err(|e| io_err("integrity_check", e))?;
    if integrity != "ok" {
        return Err(Error::internal(format!("snapshot failed integrity_check: {integrity}")));
    }
    let schema: Option<i64> =
        sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations").fetch_one(&mut conn).await.map_err(|e| io_err("schema version", e))?;
    let head = sqlx::query("SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1")
        .fetch_optional(&mut conn)
        .await
        .map_err(|e| io_err("audit head", e))?
        .map(|r| json!({"seq": r.get::<i64, _>("seq"), "hash": r.get::<String, _>("hash")}));
    let queued: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tasks WHERE state = 'queued'").fetch_one(&mut conn).await.map_err(|e| io_err("count", e))?;
    let active: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tasks WHERE state IN ('claimed','running','input_required','blocked','cancel_requested')")
        .fetch_one(&mut conn)
        .await
        .map_err(|e| io_err("count", e))?;
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tasks").fetch_one(&mut conn).await.map_err(|e| io_err("count", e))?;
    let artifacts: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM artifacts WHERE status = 'complete'").fetch_one(&mut conn).await.map_err(|e| io_err("count", e))?;
    let _ = conn.close().await;
    Ok((schema.unwrap_or(0), head, queued, active, total, artifacts))
}

impl Domain {
    /// Writes a consistent snapshot into `dir` and returns its manifest.
    pub async fn backup_to(&self, dir: &Path, opts: &BackupOptions) -> Result<BackupManifest, Error> {
        std::fs::create_dir_all(dir).map_err(|e| io_err("create backup dir", e))?;
        let db_path = dir.join(DB_FILE);
        if db_path.exists() {
            return Err(Error::conflict(format!("{} already contains a backup", dir.display())));
        }
        let created_at = self.now_ts();
        sqlx::query("VACUUM INTO ?").bind(db_path.to_string_lossy().to_string()).execute(self.db.writer()).await.map_err(|e| io_err("VACUUM INTO", e))?;
        let (schema_version, audit_head, queued, active, total, artifacts) = snapshot_facts(&db_path).await?;

        let mut files = vec![];
        let mut master_key_included = false;
        if opts.include_master_key {
            let key_path = self.cfg.database_path.with_extension("masterkey");
            if key_path.exists() {
                std::fs::copy(&key_path, dir.join(MASTER_KEY_FILE)).map_err(|e| io_err("copy master key", e))?;
                master_key_included = true;
            }
        }
        // objects are copied after the snapshot: the snapshot can only reference objects that already existed
        if let Some(objects) = &opts.objects_dir {
            for path in walk(objects) {
                if path.to_string_lossy().contains(".part-") {
                    continue;
                }
                let rel = path.strip_prefix(objects).map_err(|e| io_err("relative path", e))?;
                link_or_copy(&path, &dir.join(OBJECTS_DIR).join(rel))?;
            }
        }
        for path in walk(dir) {
            if path.file_name().is_some_and(|n| n == MANIFEST_FILE) {
                continue;
            }
            let (sha256, size) = sha256_file(&path)?;
            files.push(ManifestFile { path: path.strip_prefix(dir).map_err(|e| io_err("relative path", e))?.to_string_lossy().to_string(), sha256, size });
        }
        let manifest = BackupManifest {
            format: 1,
            domain_id: self.cfg.domain_id.clone(),
            created_at,
            schema_version,
            audit_head,
            queued_tasks: queued,
            active_tasks: active,
            total_tasks: total,
            complete_artifacts: artifacts,
            master_key_included,
            object_store: opts.object_store.clone(),
            files,
        };
        std::fs::write(dir.join(MANIFEST_FILE), serde_json::to_vec_pretty(&manifest)?).map_err(|e| io_err("write manifest", e))?;
        Ok(manifest)
    }
}

pub fn read_manifest(dir: &Path) -> Result<BackupManifest, Error> {
    let raw = std::fs::read(dir.join(MANIFEST_FILE)).map_err(|e| io_err(&format!("read {}/{MANIFEST_FILE}", dir.display()), e))?;
    Ok(serde_json::from_slice(&raw)?)
}

/// Verifies every file of a backup against its manifest.
pub fn verify_backup_files(dir: &Path, manifest: &BackupManifest) -> Result<usize, Error> {
    for f in &manifest.files {
        let (sha, size) = sha256_file(&dir.join(&f.path)).map_err(|_| Error::invalid(format!("backup file {} is missing", f.path)))?;
        if sha != f.sha256 || size != f.size {
            return Err(Error::invalid(format!("backup file {} does not match its manifest digest", f.path)));
        }
    }
    Ok(manifest.files.len())
}

/// Restores `from` into the empty directory `to`, then proves the result is usable. `master_key` supplies the key
/// when the backup does not carry one (it is then never written to disk).
pub async fn restore_backup(from: &Path, to: &Path, master_key: Option<String>) -> Result<RestoreReport, Error> {
    let started = std::time::Instant::now();
    let manifest = read_manifest(from)?;
    let files_verified = verify_backup_files(from, &manifest)?;
    let key = master_key.or_else(|| std::env::var("SOMEWORK_MASTER_KEY").ok());
    if !manifest.master_key_included && key.is_none() {
        return Err(Error::invalid(
            "this backup does not contain the master key; set SOMEWORK_MASTER_KEY (or pass the key) to restore it. Without the key the signing keys cannot be decrypted",
        ));
    }
    std::fs::create_dir_all(to).map_err(|e| io_err("create restore dir", e))?;
    if to.join(DB_FILE).exists() {
        return Err(Error::conflict(format!("{} already contains a database; restore only into a clean directory", to.display())));
    }
    for f in &manifest.files {
        let target = to.join(&f.path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| io_err("create dir", e))?;
        }
        std::fs::copy(from.join(&f.path), &target).map_err(|e| io_err(&format!("restore {}", f.path), e))?;
    }
    let mut cfg = DomainConfig::new(manifest.domain_id.clone(), to.join(DB_FILE));
    cfg.db_synchronous_full = false;
    if !manifest.master_key_included {
        cfg.master_key = key;
    }
    let domain = Domain::open(cfg).await.map_err(|e| Error::new(e.code, format!("the restored database could not be opened: {}", e.message)))?;
    let broken = domain.verify_audit_chain().await?;
    if let Some(seq) = broken {
        return Err(Error::internal(format!("restored audit chain is broken at sequence {seq}")));
    }
    let (_, _, queued, _, _, _) = snapshot_facts(&to.join(DB_FILE)).await?;
    if queued != manifest.queued_tasks {
        return Err(Error::internal(format!("restored database has {queued} queued tasks but the manifest recorded {}", manifest.queued_tasks)));
    }
    // Matrix E2EE state travels inside the database snapshot: prove it is still recoverable with the master key and
    // that the stored Megolm test vector decrypts.
    domain.verify_matrix_crypto().await.map_err(|e| Error::internal(format!("restored Matrix crypto state is unusable: {}", e.message)))?;
    let mut artifacts_verified = 0usize;
    let objects = to.join(OBJECTS_DIR);
    if objects.exists() {
        let rows = sqlx::query("SELECT storage_key, actual_digest FROM artifacts WHERE status = 'complete' ORDER BY RANDOM() LIMIT ?")
            .bind(SAMPLE_ARTIFACTS)
            .fetch_all(domain.db.pool())
            .await
            .map_err(|e| io_err("sample artifacts", e))?;
        for r in rows {
            let key: String = r.get("storage_key");
            let expected: String = r.get("actual_digest");
            let (sha, _) = sha256_file(&objects.join(&key)).map_err(|_| Error::internal(format!("artifact object {key} is missing from the backup")))?;
            if sha != expected {
                return Err(Error::internal(format!("artifact object {key} does not match its verified digest")));
            }
            artifacts_verified += 1;
        }
    }
    domain.db.close().await;
    Ok(RestoreReport {
        restore_seconds: started.elapsed().as_secs_f64(),
        queued_tasks: queued,
        audit_intact: true,
        artifacts_verified,
        files_verified,
        manifest,
    })
}
