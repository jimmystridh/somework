//! `somework backup` / `somework restore` and the scheduled-backup task (BAK-01).

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result};
use serde_json::json;
use somework_domain::{
    Domain,
    backup::{BackupOptions, restore_backup},
};
use tokio_util::sync::CancellationToken;

use crate::config::ServerConfig;

pub const BACKUP_PREFIX: &str = "backup-";

fn objects_dir(cfg: &ServerConfig) -> Option<PathBuf> {
    match cfg.objects.kind.as_deref().unwrap_or("fs") {
        "fs" => Some(cfg.objects.dir.clone().unwrap_or_else(|| cfg.domain.db.with_extension("objects"))),
        _ => None,
    }
}

pub fn backup_options(cfg: &ServerConfig, include_master_key: bool) -> BackupOptions {
    let object_store = match (&cfg.objects.s3, cfg.objects.kind.as_deref()) {
        (Some(s3), Some("s3")) => {
            json!({"kind": "s3", "endpoint": s3.endpoint, "bucket": s3.bucket, "note": "object bytes are not copied; protect the bucket with versioning, replication or object lock"})
        }
        _ => json!({"kind": "fs"}),
    };
    BackupOptions { objects_dir: objects_dir(cfg), include_master_key, object_store }
}

pub async fn backup(config: &Path, to: &Path) -> Result<()> {
    let cfg = ServerConfig::load(config)?;
    let domain = Domain::open(cfg.domain_config()).await?;
    let manifest = domain.backup_to(to, &backup_options(&cfg, true)).await?;
    println!("{}", serde_json::to_string_pretty(&manifest)?);
    eprintln!("WARNING: the backup contains the master key; store it separately from the data in production.");
    Ok(())
}

/// Restores into `to` and writes a ready-to-serve `somework.toml` beside the data.
pub async fn restore(from: &Path, to: &Path) -> Result<()> {
    let report = restore_backup(from, to, None).await?;
    let manifest = &report.manifest;
    let config = format!(
        "[domain]\nid = \"{}\"\ndb = \"{}\"\n\n[objects]\nkind = \"fs\"\ndir = \"{}\"\n",
        manifest.domain_id,
        to.join(somework_domain::backup::DB_FILE).display(),
        to.join(somework_domain::backup::OBJECTS_DIR).display()
    );
    std::fs::write(to.join("somework.toml"), config).context("write restored config")?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    if !manifest.object_store.is_null() && manifest.object_store["kind"] == "s3" {
        eprintln!("NOTE: artifact bytes live in S3 and were not part of the backup; point [objects.s3] at the bucket.");
    }
    Ok(())
}

pub fn list_backups(dir: &Path) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.is_dir()
                        && p.file_name().is_some_and(|n| n.to_string_lossy().starts_with(BACKUP_PREFIX))
                        && p.join(somework_domain::backup::MANIFEST_FILE).exists()
                })
                .collect()
        })
        .unwrap_or_default();
    found.sort();
    found
}

pub fn latest_backup(dir: &Path) -> Option<PathBuf> {
    list_backups(dir).pop()
}

async fn run_once(domain: &Domain, cfg: &ServerConfig, dir: &Path) -> Result<()> {
    let name = format!("{BACKUP_PREFIX}{}", domain.now().format("%Y%m%dT%H%M%S%3fZ"));
    let target = dir.join(&name);
    let partial = dir.join(format!(".{name}.partial"));
    domain.backup_to(&partial, &backup_options(cfg, cfg.domain.backup_include_master_key)).await?;
    std::fs::rename(&partial, &target).context("publish backup")?;
    let all = list_backups(dir);
    if all.len() > cfg.domain.backup_keep.max(1) {
        for old in &all[..all.len() - cfg.domain.backup_keep.max(1)] {
            let _ = std::fs::remove_dir_all(old);
        }
    }
    Ok(())
}

/// Periodic backups with retention; the directory only ever contains complete backups (write to `.partial`, rename).
pub fn spawn_scheduled(domain: &Domain, cfg: &ServerConfig, shutdown: CancellationToken) -> Option<tokio::task::JoinHandle<()>> {
    let interval = cfg.domain.backup_interval_seconds;
    let dir = cfg.domain.backup_dir.clone()?;
    if interval == 0 {
        return None;
    }
    let (domain, cfg) = (domain.clone(), cfg.clone());
    Some(tokio::spawn(async move {
        if std::fs::create_dir_all(&dir).is_err() {
            tracing::error!(dir = %dir.display(), "cannot create backup directory");
            return;
        }
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_secs(interval)) => {}
            }
            if let Err(err) = run_once(&domain, &cfg, &dir).await {
                tracing::error!(error = %err, "scheduled backup failed");
            }
        }
    }))
}
