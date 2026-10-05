//! Immutable, versioned artifacts (ART-01..03): begin upload -> direct upload with a short-lived grant ->
//! complete (digest verification) -> metadata/download grants. Metadata commits only after verification.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use somework_core::{Error, ErrorCode, contracts::*, ids};
use sqlx::{Row, SqliteConnection};

use crate::{
    audit::AuditRecord,
    db::{DbResultExt, icol, icol_opt, jcol, scol, scol_opt},
    domain::{Ctx, Domain},
    events::EventSpec,
    objects::{CompletedPart, PutPlan, storage_key},
    policy::AuthzRequest,
    tasks::TaskRow,
};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct BeginUpload {
    /// Existing artifact to add a new version to; omitted for a new artifact.
    pub artifact_id: Option<String>,
    pub filename: Option<String>,
    pub media_type: Option<String>,
    pub size_bytes: Option<u64>,
    /// Hex SHA-256 the uploaded bytes must hash to.
    pub sha256: Option<String>,
    pub classification: Option<String>,
    pub source_task_id: Option<String>,
    pub provenance: Option<Value>,
    pub expires_at: Option<String>,
    pub conversation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadGrant {
    pub artifact_id: String,
    pub version: u64,
    pub uri: String,
    pub expires_at: String,
    #[serde(flatten)]
    pub plan: PutPlan,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CompleteUpload {
    pub version: Option<u64>,
    pub parts: Vec<CompletedPart>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadGrant {
    pub artifact: ArtifactRef,
    pub url: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DownloadRequest {
    /// Read the artifact as part of this task (authority = effective task authority).
    pub task_id: Option<String>,
    pub fencing_token: Option<u64>,
}

fn is_hex_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn artifact_ref_from_row(r: &sqlx::sqlite::SqliteRow) -> Result<ArtifactRef, Error> {
    let domain = scol(r, "domain_id");
    let created_by: ActorRef = serde_json::from_value(jcol(r, "created_by")).map_err(|e| Error::internal(format!("stored artifact actor is invalid: {e}")))?;
    let id = scol(r, "artifact_id");
    let version = icol(r, "version") as u64;
    Ok(ArtifactRef {
        uri: artifact_uri(&domain, &id, version),
        artifact_id: id,
        version,
        filename: scol_opt(r, "filename"),
        media_type: scol(r, "media_type"),
        size_bytes: icol_opt(r, "size_bytes").unwrap_or(0) as u64,
        digest: Digest::sha256(scol_opt(r, "actual_digest").unwrap_or_else(|| scol(r, "declared_digest"))),
        classification: scol(r, "classification"),
        created_by,
        created_at: scol(r, "created_at"),
        expires_at: scol_opt(r, "expires_at"),
        source_task_id: scol_opt(r, "source_task_id"),
        provenance: Some(jcol(r, "provenance")).filter(|v| v.as_object().is_some_and(|o| !o.is_empty())),
        encryption: Some(jcol(r, "encryption")).filter(|v| v.as_object().is_some_and(|o| !o.is_empty())),
    })
}

impl Domain {
    pub async fn begin_artifact_upload(&self, ctx: &Ctx, req: BeginUpload) -> Result<UploadGrant, Error> {
        self.run(ctx, "artifact.begin_upload", async {
            let size = req.size_bytes.ok_or_else(|| Error::invalid("sizeBytes is required"))?;
            let sha = req.sha256.clone().ok_or_else(|| Error::invalid("sha256 is required"))?;
            if !is_hex_sha256(&sha) {
                return Err(Error::invalid("sha256 must be 64 hex characters"));
            }
            let media_type = req.media_type.clone().ok_or_else(|| Error::invalid("mediaType is required"))?;
            if size > self.cfg.max_artifact_bytes {
                return Err(Error::new(ErrorCode::PayloadTooLarge, format!("artifact exceeds the {} byte limit", self.cfg.max_artifact_bytes)));
            }
            let store = self.object_store()?;
            let this = self.clone();
            let ctx = ctx.clone();
            self.write(move |tx| {
                Box::pin(async move {
                    let conn: &mut SqliteConnection = tx;
                    let policy = this.active_policy(conn).await?;
                    let classification = req.classification.clone().unwrap_or_else(|| "internal".into());
                    if !policy.scale().is_known(&classification) {
                        return Err(Error::invalid(format!("unknown classification {classification}")));
                    }
                    let mut authz = AuthzRequest::action(Action::ArtifactWrite).classification(&classification);
                    let mut effective = ctx.actor.clone();
                    if let Some(task_id) = &req.source_task_id {
                        let row = this.require_task_participant(conn, &ctx, task_id).await?;
                        if row.assignee_principal_id.as_deref() == Some(&ctx.actor.principal_id)
                            && let Some(auth) = &row.effective_authority {
                                effective.permissions = auth.as_permissions();
                                effective.permissions.resources = vec![];
                            }
                        authz = authz.task(task_id).resource(format!("task://{task_id}"));
                    }
                    let mut task_ctx = ctx.clone();
                    task_ctx.actor = effective;
                    this.enforce(conn, &task_ctx, authz).await?;

                    let used: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(COALESCE(size_bytes, declared_size)), 0) FROM artifacts WHERE domain_id = ? AND status IN ('pending','complete')").bind(&this.cfg.domain_id).fetch_one(&mut *conn).await.db()?;
                    if used as u64 + size > this.cfg.artifact_quota_bytes {
                        return Err(Error::new(ErrorCode::QuotaExceeded, "the domain's artifact storage quota is exhausted"));
                    }
                    let artifact_id = req.artifact_id.clone().unwrap_or_else(ids::artifact_id);
                    let version: i64 = if req.artifact_id.is_some() {
                        let owner: Option<String> = sqlx::query_scalar("SELECT created_by_principal_id FROM artifacts WHERE artifact_id = ? LIMIT 1").bind(&artifact_id).fetch_optional(&mut *conn).await.db()?;
                        match owner {
                            Some(o) if o == ctx.actor.principal_id || ctx.actor.is_admin() => {}
                            Some(_) => return Err(Error::not_found("artifact")),
                            None => return Err(Error::not_found("artifact")),
                        }
                        sqlx::query_scalar::<_, i64>("SELECT COALESCE(MAX(version), 0) + 1 FROM artifacts WHERE artifact_id = ?").bind(&artifact_id).fetch_one(&mut *conn).await.db()?
                    } else {
                        1
                    };
                    let key = storage_key(&this.cfg.domain_id, &artifact_id, version as u64);
                    let ttl = Duration::from_secs(this.cfg.upload_grant_ttl_seconds as u64);
                    let plan = store.plan_upload(&key, size, &media_type, ttl).await?;
                    let now = this.now_ts();
                    sqlx::query(
                        "INSERT INTO artifacts(artifact_id, version, domain_id, status, filename, media_type, declared_size, declared_digest, classification, created_by, created_by_principal_id, source_task_id, provenance, storage_key, upload, created_at, expires_at)
                         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    )
                    .bind(&artifact_id)
                    .bind(version)
                    .bind(&this.cfg.domain_id)
                    .bind(&req.filename)
                    .bind(&media_type)
                    .bind(size as i64)
                    .bind(sha.to_lowercase())
                    .bind(&classification)
                    .bind(serde_json::to_string(&ctx.actor.actor_ref())?)
                    .bind(&ctx.actor.principal_id)
                    .bind(&req.source_task_id)
                    .bind(req.provenance.clone().unwrap_or_else(|| json!({})).to_string())
                    .bind(&key)
                    .bind(json!({"store": store.kind(), "state": plan.state, "conversationId": req.conversation_id}).to_string())
                    .bind(&now)
                    .bind(&req.expires_at)
                    .execute(&mut *conn)
                    .await
                    .db()?;
                    this.audit(conn, &ctx, AuditRecord::new("artifact.begin_upload", Some(artifact_uri(&this.cfg.domain_id, &artifact_id, version as u64)), "success").detail(json!({"sizeBytes": size, "classification": classification}))).await?;
                    Ok(UploadGrant {
                        uri: artifact_uri(&this.cfg.domain_id, &artifact_id, version as u64),
                        artifact_id,
                        version: version as u64,
                        expires_at: somework_core::clock::ts(this.now() + chrono::Duration::seconds(this.cfg.upload_grant_ttl_seconds)),
                        plan,
                    })
                })
            })
            .await
        })
        .await
    }

    /// Verifies the uploaded object (size and SHA-256) and only then marks the artifact complete.
    pub async fn complete_artifact_upload(&self, ctx: &Ctx, artifact_id: &str, req: CompleteUpload) -> Result<ArtifactRef, Error> {
        self.run(ctx, "artifact.complete_upload", async {
            let store = self.object_store()?;
            let row = {
                let version_filter = req.version;
                sqlx::query("SELECT * FROM artifacts WHERE artifact_id = ? AND (? IS NULL OR version = ?) ORDER BY version DESC LIMIT 1")
                    .bind(artifact_id)
                    .bind(version_filter.map(|v| v as i64))
                    .bind(version_filter.map(|v| v as i64))
                    .fetch_optional(self.db.pool())
                    .await
                    .db()?
                    .ok_or_else(|| Error::not_found("artifact"))?
            };
            if scol(&row, "created_by_principal_id") != ctx.actor.principal_id && !ctx.actor.is_admin() {
                return Err(Error::not_found("artifact"));
            }
            let version = icol(&row, "version");
            match scol(&row, "status").as_str() {
                "complete" => return artifact_ref_from_row(&row),
                "failed" | "expired" => return Err(Error::new(ErrorCode::IntegrityFailure, "this upload already failed verification; begin a new upload")),
                _ => {}
            }
            let key = scol(&row, "storage_key");
            let state = jcol(&row, "upload")["state"].clone();
            store.finish_upload(&key, &state, &req.parts).await?;
            let observed = store.digest(&key).await?;
            let declared_size = icol(&row, "declared_size") as u64;
            let declared_digest = scol(&row, "declared_digest");
            let this = self.clone();
            let ctx2 = ctx.clone();
            let artifact_id = artifact_id.to_string();
            let failure = match &observed {
                None => Some("no object was uploaded".to_string()),
                Some(o) if o.size != declared_size => Some(format!("uploaded size {} differs from the declared {declared_size}", o.size)),
                Some(o) if o.sha256_hex != declared_digest => Some("SHA-256 digest of the uploaded bytes differs from the declared digest".to_string()),
                _ => None,
            };
            let result = self
                .write(move |tx| {
                    Box::pin(async move {
                        let conn: &mut SqliteConnection = tx;
                        if let Some(reason) = &failure {
                            sqlx::query("UPDATE artifacts SET status = 'failed', actual_digest = ?, size_bytes = ? WHERE artifact_id = ? AND version = ?")
                                .bind(observed.as_ref().map(|o| o.sha256_hex.clone()))
                                .bind(observed.as_ref().map(|o| o.size as i64))
                                .bind(&artifact_id)
                                .bind(version)
                                .execute(&mut *conn)
                                .await
                                .db()?;
                            this.audit(conn, &ctx2, AuditRecord::new("artifact.complete_upload", Some(artifact_uri(&this.cfg.domain_id, &artifact_id, version as u64)), "failed").detail(json!({"reason": reason}))).await?;
                            return Ok(Err(reason.clone()));
                        }
                        let o = observed.clone().expect("verified above");
                        sqlx::query("UPDATE artifacts SET status = 'complete', actual_digest = ?, size_bytes = ?, completed_at = ? WHERE artifact_id = ? AND version = ?")
                            .bind(&o.sha256_hex)
                            .bind(o.size as i64)
                            .bind(this.now_ts())
                            .bind(&artifact_id)
                            .bind(version)
                            .execute(&mut *conn)
                            .await
                            .db()?;
                        let r = sqlx::query("SELECT * FROM artifacts WHERE artifact_id = ? AND version = ?").bind(&artifact_id).bind(version).fetch_one(&mut *conn).await.db()?;
                        let aref = artifact_ref_from_row(&r)?;
                        let payload = json!({"artifactId": artifact_id, "version": version, "uri": aref.uri, "sizeBytes": aref.size_bytes, "classification": aref.classification});
                        let mut spec = EventSpec::new("artifact.published", payload).matrix().recipient(ctx2.actor.principal_id.clone(), false);
                        if let Some(task_id) = aref.source_task_id.clone()
                            && let Ok(t) = this.load_task(conn, &task_id).await {
                                spec = spec.task(&t.task_id, t.revision).conversation(t.conversation_id.clone());
                            }
                        this.emit(conn, &ctx2, spec).await?;
                        this.audit(conn, &ctx2, AuditRecord::new("artifact.complete_upload", Some(aref.uri.clone()), "success").detail(json!({"sizeBytes": aref.size_bytes, "sha256": aref.digest.value}))).await?;
                        this.metrics.artifact_upload_bytes.inc_by(aref.size_bytes);
                        Ok(Ok(aref))
                    })
                })
                .await?;
            match result {
                Ok(aref) => Ok(aref),
                Err(reason) => {
                    self.metrics.artifact_integrity_failures.inc();
                    let _ = store.delete(&key).await;
                    Err(Error::new(ErrorCode::IntegrityFailure, reason))
                }
            }
        })
        .await
    }

    async fn artifact_row(&self, conn: &mut SqliteConnection, artifact_id: &str, version: u64) -> Result<sqlx::sqlite::SqliteRow, Error> {
        sqlx::query("SELECT * FROM artifacts WHERE artifact_id = ? AND version = ?")
            .bind(artifact_id)
            .bind(version as i64)
            .fetch_optional(conn)
            .await
            .db()?
            .ok_or_else(|| Error::not_found("artifact"))
    }

    /// Whether `ctx` may read the artifact, optionally while acting under `task` (effective task authority).
    async fn authorize_artifact_read(
        &self,
        conn: &mut SqliteConnection,
        ctx: &Ctx,
        row: &sqlx::sqlite::SqliteRow,
        task: Option<&TaskRow>,
    ) -> Result<(), Error> {
        let policy = self.active_policy(conn).await?;
        let scale = policy.scale();
        let classification = scol(row, "classification");
        let uri = artifact_uri(&scol(row, "domain_id"), &scol(row, "artifact_id"), icol(row, "version") as u64);
        let mut actor_ctx = ctx.clone();
        if let Some(t) = task {
            let authority = t.effective_authority.as_ref().ok_or_else(|| Error::denied("task has no authority"))?;
            if !authority.permits_classification(&scale, &classification) {
                let denied = crate::policy::Decision {
                    decision_id: ids::decision_id(),
                    allow: false,
                    reasons: vec![format!("task authority ({}) does not cover {classification} artifacts", authority.classification_max)],
                    obligations: vec![],
                    policy_version: policy.version,
                };
                let mut err = Error::denied(denied.reasons.join("; "));
                err.details = Some(json!({"decision": denied, "action": "artifact.read", "resource": uri, "taskId": t.task_id}));
                return Err(err);
            }
            actor_ctx.actor.permissions = authority.as_permissions();
            actor_ctx.actor.permissions.actions.retain(|a| a == "artifact.read");
            if !self.artifact_in_task_scope(conn, t, row).await? {
                return Err(Error::not_found("artifact"));
            }
        } else {
            let owner = scol(row, "created_by_principal_id") == ctx.actor.principal_id;
            if !owner && !ctx.actor.permissions.allows_action("artifact.read") {
                return Err(Error::denied("artifact.read is not granted"));
            }
            if !owner && !ctx.actor.permissions.resource_allowed(&uri) {
                return Err(Error::not_found("artifact"));
            }
            if !scale.permits(ctx.actor.permissions.classification_limit(), &classification) && !owner {
                let denied = crate::policy::Decision {
                    decision_id: ids::decision_id(),
                    allow: false,
                    reasons: vec![format!("classification {classification} exceeds the caller's clearance")],
                    obligations: vec![],
                    policy_version: policy.version,
                };
                let mut err = Error::denied(denied.reasons.join("; "));
                err.details = Some(json!({"decision": denied, "action": "artifact.read", "resource": uri}));
                return Err(err);
            }
        }
        let req = AuthzRequest::action(Action::ArtifactRead).classification(classification).resource(uri);
        self.enforce(conn, &actor_ctx, req).await?;
        Ok(())
    }

    /// Artifacts a task may touch: referenced by its input/context, produced within its lineage, or its own results.
    async fn artifact_in_task_scope(&self, conn: &mut SqliteConnection, task: &TaskRow, row: &sqlx::sqlite::SqliteRow) -> Result<bool, Error> {
        let uri = artifact_uri(&scol(row, "domain_id"), &scol(row, "artifact_id"), icol(row, "version") as u64);
        if task.input.to_string().contains(&uri) {
            return Ok(true);
        }
        if let Some(src) = scol_opt(row, "source_task_id") {
            let mut current = Some(task.task_id.clone());
            let mut depth = 0;
            while let Some(id) = current {
                if id == src {
                    return Ok(true);
                }
                depth += 1;
                if depth > 16 {
                    break;
                }
                current = sqlx::query_scalar::<_, Option<String>>("SELECT parent_task_id FROM tasks WHERE task_id = ?")
                    .bind(&id)
                    .fetch_optional(&mut *conn)
                    .await
                    .db()?
                    .flatten();
            }
        }
        for cref in &task.context_refs {
            let manifest: Option<String> = sqlx::query_scalar("SELECT manifest FROM context_packs WHERE context_pack_id = ? AND version = ?")
                .bind(&cref.context_pack_id)
                .bind(cref.version as i64)
                .fetch_optional(&mut *conn)
                .await
                .db()?;
            if manifest.is_some_and(|m| m.contains(&uri)) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub async fn get_artifact(&self, ctx: &Ctx, artifact_id: &str, version: u64, task_id: Option<&str>) -> Result<ArtifactRef, Error> {
        let mut conn = self.db.pool().acquire().await.db()?;
        let row = self.artifact_row(&mut conn, artifact_id, version).await.map_err(|_| Error::not_found("artifact"))?;
        let task = match task_id {
            Some(id) => Some(self.require_task_participant(&mut conn, ctx, id).await?),
            None => None,
        };
        self.authorize_artifact_read(&mut conn, ctx, &row, task.as_ref()).await?;
        if scol(&row, "status") != "complete" && scol(&row, "created_by_principal_id") != ctx.actor.principal_id {
            return Err(Error::not_found("artifact"));
        }
        artifact_ref_from_row(&row)
    }

    pub async fn artifact_download_grant(&self, ctx: &Ctx, artifact_id: &str, version: u64, req: DownloadRequest) -> Result<DownloadGrant, Error> {
        self.run(ctx, "artifact.download_grant", async {
            let store = self.object_store()?;
            let this = self.clone();
            let ctx2 = ctx.clone();
            let artifact_id = artifact_id.to_string();
            let (aref, key) = self
                .write(move |tx| {
                    Box::pin(async move {
                        let conn: &mut SqliteConnection = tx;
                        let row = this.artifact_row(conn, &artifact_id, version).await.map_err(|_| Error::not_found("artifact"))?;
                        let task = match &req.task_id {
                            Some(id) => {
                                let t = this.require_task_participant(conn, &ctx2, id).await?;
                                if t.assignee_principal_id.as_deref() == Some(&ctx2.actor.principal_id) {
                                    this.verify_lease(&t, &ctx2, req.fencing_token)?;
                                }
                                Some(t)
                            }
                            None => None,
                        };
                        this.authorize_artifact_read(conn, &ctx2, &row, task.as_ref()).await?;
                        if scol(&row, "status") != "complete" {
                            return Err(Error::new(ErrorCode::ArtifactNotReady, "the artifact upload has not completed verification"));
                        }
                        let aref = artifact_ref_from_row(&row)?;
                        this.audit(conn, &ctx2, AuditRecord::new("artifact.download_grant", Some(aref.uri.clone()), "success").task(req.task_id.clone()))
                            .await?;
                        this.metrics.artifact_download_bytes.inc_by(aref.size_bytes);
                        Ok((aref, scol(&row, "storage_key")))
                    })
                })
                .await?;
            let ttl = Duration::from_secs(self.cfg.download_grant_ttl_seconds as u64);
            let url = store.presign_get(&key, ttl, aref.filename.as_deref()).await?;
            Ok(DownloadGrant {
                artifact: aref,
                url,
                expires_at: somework_core::clock::ts(self.now() + chrono::Duration::seconds(self.cfg.download_grant_ttl_seconds)),
            })
        })
        .await
    }

    /// Failure mode "S3 unavailable": artifact-dependent completions wait (retryable) instead of failing the task.
    pub(crate) async fn require_object_store_healthy(&self) -> Result<(), Error> {
        let store = self.object_store()?;
        if store.healthy().await {
            Ok(())
        } else {
            Err(Error::unavailable("the object store is unavailable; the task stays running until its artifacts can be verified"))
        }
    }

    /// ART-03: result artifacts must be complete, digest-verified and within the task's authority.
    pub(crate) async fn verify_result_artifacts(
        &self,
        conn: &mut SqliteConnection,
        ctx: &Ctx,
        task: &TaskRow,
        refs: &[ArtifactRef],
    ) -> Result<Vec<ArtifactRef>, Error> {
        let policy = self.active_policy(conn).await?;
        let scale = policy.scale();
        let mut out = Vec::new();
        for r in refs {
            let row = self
                .artifact_row(conn, &r.artifact_id, r.version)
                .await
                .map_err(|_| Error::new(ErrorCode::ArtifactNotReady, format!("artifact {} v{} does not exist", r.artifact_id, r.version)))?;
            if scol(&row, "status") != "complete" {
                return Err(Error::new(
                    ErrorCode::ArtifactNotReady,
                    format!("artifact {} v{} has not completed integrity verification", r.artifact_id, r.version),
                ));
            }
            let stored = artifact_ref_from_row(&row)?;
            if stored.digest.value != r.digest.value {
                return Err(Error::new(
                    ErrorCode::IntegrityFailure,
                    format!("artifact {} v{}: the referenced digest differs from the verified digest", r.artifact_id, r.version),
                ));
            }
            if scol(&row, "created_by_principal_id") != ctx.actor.principal_id && !self.artifact_in_task_scope(conn, task, &row).await? {
                return Err(Error::new(ErrorCode::ArtifactNotReady, format!("artifact {} v{} was not produced for this task", r.artifact_id, r.version)));
            }
            if let Some(authority) = &task.effective_authority
                && !authority.permits_classification(&scale, &stored.classification)
            {
                return Err(Error::denied(format!("task authority does not cover {} artifacts", stored.classification)));
            }
            out.push(stored);
        }
        Ok(out)
    }

    /// Marks artifacts whose upload never completed as expired and removes their objects.
    pub async fn expire_stale_uploads(&self) -> Result<u64, Error> {
        let cutoff = somework_core::clock::ts(self.now() - chrono::Duration::seconds(self.cfg.upload_grant_ttl_seconds * 2));
        let rows = sqlx::query("SELECT artifact_id, version, storage_key FROM artifacts WHERE status = 'pending' AND created_at < ?")
            .bind(&cutoff)
            .fetch_all(self.db.pool())
            .await
            .db()?;
        let store = self.object_store().ok();
        for r in &rows {
            sqlx::query("UPDATE artifacts SET status = 'expired' WHERE artifact_id = ? AND version = ? AND status = 'pending'")
                .bind(scol(r, "artifact_id"))
                .bind(r.get::<i64, _>("version"))
                .execute(self.db.writer())
                .await
                .db()?;
            if let Some(s) = &store {
                let _ = s.delete(&scol(r, "storage_key")).await;
            }
        }
        Ok(rows.len() as u64)
    }
}
