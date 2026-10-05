//! ContextPack lifecycle (CTX-01..05): immutable versioned handover manifests, policy-filtered section access,
//! offers, and acceptance — with ownership moving only when the receiver atomically accepts.

use chrono::Duration;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use somework_core::{Error, ErrorCode, canonical::digest_json, clock::ts, contracts::*, fsm::TaskState, ids, schema};
use sqlx::SqliteConnection;

use crate::{
    audit::AuditRecord,
    db::{DbResultExt, icol, jcol, scol, scol_opt},
    domain::{Ctx, Domain},
    events::EventSpec,
    messages::{MemberRef, SystemMessage},
    policy::{AuthzRequest, Decision},
    tasks::{TaskRow, TaskView, TransitionData},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextPackRecord {
    pub context_pack_id: String,
    pub version: u64,
    pub digest: String,
    pub classification: String,
    pub size_bytes: u64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextView {
    pub context_pack_id: String,
    pub version: u64,
    pub digest: String,
    pub classification: String,
    pub disclosed_sections: Vec<String>,
    pub withheld_sections: Vec<String>,
    /// Per-section presence and size, so a receiver can decide what to request without seeing the content.
    pub section_index: Value,
    pub pack: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct OfferRequest {
    pub to: Option<MemberRef>,
    pub mode: Option<String>,
    pub task_id: Option<String>,
    pub sections: Option<Vec<String>>,
    pub expires_in_seconds: Option<i64>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfferView {
    pub offer_id: String,
    pub context_pack_id: String,
    pub version: u64,
    pub from: String,
    pub to: String,
    pub mode: String,
    pub task_id: Option<String>,
    pub sections: Vec<String>,
    pub status: String,
    pub expires_at: Option<String>,
    pub created_at: String,
    pub decided_at: Option<String>,
    pub result: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AcceptRequest {
    pub offer_id: String,
    pub lease_seconds: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptResponse {
    pub offer: OfferView,
    pub task: Option<TaskView>,
    /// Present for ownership transfers: the receiver's new lease, fencing token and task grant.
    pub lease: Option<Lease>,
    pub fencing_token: Option<u64>,
    pub authorization_token: Option<String>,
}

fn offer_from_row(r: &sqlx::sqlite::SqliteRow) -> OfferView {
    OfferView {
        offer_id: scol(r, "offer_id"),
        context_pack_id: scol(r, "context_pack_id"),
        version: icol(r, "version") as u64,
        from: scol(r, "from_principal_id"),
        to: scol(r, "to_principal_id"),
        mode: scol(r, "mode"),
        task_id: scol_opt(r, "task_id"),
        sections: serde_json::from_value(jcol(r, "sections")).unwrap_or_default(),
        status: scol(r, "status"),
        expires_at: scol_opt(r, "expires_at"),
        created_at: scol(r, "created_at"),
        decided_at: scol_opt(r, "decided_at"),
        result: crate::db::jcol_opt(r, "result"),
    }
}

fn sections_present(pack: &Value) -> Vec<&'static str> {
    CONTEXT_SECTIONS
        .iter()
        .copied()
        .filter(|s| {
            context_section_keys(s).iter().any(|k| pack.get(*k).is_some_and(|v| !(v.is_null() || v.is_array() && v.as_array().is_some_and(Vec::is_empty))))
        })
        .collect()
}

fn section_size(pack: &Value, section: &str) -> usize {
    context_section_keys(section).iter().filter_map(|k| pack.get(*k)).map(|v| v.to_string().len()).sum()
}

impl Domain {
    pub async fn create_context_pack(&self, ctx: &Ctx, mut pack: Value) -> Result<ContextPackRecord, Error> {
        self.run(ctx, "context.create", async {
            let obj = pack.as_object_mut().ok_or_else(|| Error::invalid("a ContextPack must be a JSON object"))?;
            obj.entry("schemaVersion").or_insert(json!(SCHEMA_VERSION));
            obj.entry("createdAt").or_insert(json!(self.now_ts()));
            let context_pack_id = match obj.get("contextPackId").and_then(Value::as_str) {
                Some(id) => id.to_string(),
                None => {
                    let id = ids::context_pack_id();
                    obj.insert("contextPackId".into(), json!(id));
                    id
                }
            };
            // CTX-05: imported context is data, never instructions; the platform pins this regardless of the author
            if let Some(security) = obj.get_mut("security").and_then(Value::as_object_mut) {
                security.entry("instructionsTrusted").or_insert(json!(false));
            }
            let provenance = obj.entry("provenance").or_insert_with(|| json!({}));
            if let Some(p) = provenance.as_object_mut() {
                match p.get("createdBy") {
                    None => {
                        p.insert("createdBy".into(), serde_json::to_value(ctx.actor.actor_ref())?);
                    }
                    Some(by) => {
                        let by: ActorRef = serde_json::from_value(by.clone()).map_err(|_| Error::invalid("provenance.createdBy is malformed"))?;
                        if by.id != ctx.actor.id || by.kind != ctx.actor.kind {
                            return Err(Error::new(ErrorCode::SenderMismatch, "provenance.createdBy must be the authenticated caller"));
                        }
                    }
                }
            }
            let supplied_digest = obj.remove("digest").and_then(|d| d.as_str().map(String::from));
            let this = self.clone();
            let ctx = ctx.clone();
            self.write(move |tx| {
                Box::pin(async move {
                    let conn: &mut SqliteConnection = tx;
                    let mut pack = pack;
                    let version = match pack.get("version").and_then(Value::as_u64) {
                        Some(v) => v,
                        None => {
                            let max: Option<i64> = sqlx::query_scalar("SELECT MAX(version) FROM context_packs WHERE context_pack_id = ?").bind(&context_pack_id).fetch_one(&mut *conn).await.db()?;
                            let v = max.map(|m| m as u64 + 1).unwrap_or(1);
                            pack["version"] = json!(v);
                            v
                        }
                    };
                    if pack.get("base").is_none() && version > 1 {
                        pack["base"] = json!({"contextPackId": context_pack_id, "version": version - 1});
                    }
                    // digest over the pack without its digest field; a supplied digest must agree (integrity of the handover)
                    let mut for_digest = pack.clone();
                    for_digest.as_object_mut().map(|o| o.remove("digest"));
                    let digest = digest_json(&for_digest);
                    if let Some(supplied) = supplied_digest
                        && !supplied.eq_ignore_ascii_case(&digest) {
                            return Err(Error::invalid("digest does not match the canonical digest of the ContextPack"));
                        }
                    pack["digest"] = json!(digest);
                    schema::validate_contract("ContextPack", &pack)?;
                    let size = this.check_inline_size(&pack, "ContextPack manifest")?;
                    let classification = pack["security"]["classification"].as_str().unwrap_or("internal").to_string();
                    let policy = this.active_policy(conn).await?;
                    if !policy.scale().is_known(&classification) {
                        return Err(Error::invalid(format!("unknown classification {classification}")));
                    }
                    let source_task = pack["provenance"]["sourceTaskId"].as_str().map(String::from);
                    let mut authz = AuthzRequest::action(Action::ContextWrite).classification(&classification).resource(format!("context://{context_pack_id}/{version}"));
                    if let Some(t) = &source_task {
                        authz = authz.task(t);
                    }
                    let decision = this.enforce(conn, &ctx, authz).await?;
                    if let Some(base) = pack.get("base").filter(|b| !b.is_null()) {
                        let (bid, bver) = (base["contextPackId"].as_str().unwrap_or_default(), base["version"].as_i64().unwrap_or(0));
                        let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM context_packs WHERE context_pack_id = ? AND version = ?").bind(bid).bind(bver).fetch_optional(&mut *conn).await.db()?;
                        if exists.is_none() {
                            return Err(Error::invalid("base references a ContextPack version that does not exist"));
                        }
                    }
                    if let Some(prev) = sqlx::query_scalar::<_, String>("SELECT created_by FROM context_packs WHERE context_pack_id = ? LIMIT 1").bind(&context_pack_id).fetch_optional(&mut *conn).await.db()?
                        && prev != ctx.actor.principal_id && !ctx.actor.is_admin() {
                            return Err(Error::denied("only the creator may add versions to a ContextPack"));
                        }
                    // CTX-03: large evidence travels as artifact references; every reference must be verified and readable
                    let artifacts: Vec<ArtifactRef> = serde_json::from_value(pack.get("artifacts").cloned().unwrap_or(json!([])))?;
                    for a in &artifacts {
                        let aref = this.get_artifact_in_tx(conn, &ctx, &a.artifact_id, a.version).await.map_err(|_| Error::new(ErrorCode::ArtifactNotReady, format!("artifact {} v{} is not available", a.artifact_id, a.version)))?;
                        if aref.digest.value != a.digest.value {
                            return Err(Error::new(ErrorCode::IntegrityFailure, format!("artifact {} v{}: digest differs from the verified digest", a.artifact_id, a.version)));
                        }
                        if !policy.scale().permits(&classification, &aref.classification) {
                            return Err(Error::invalid(format!("artifact {} is classified {} which exceeds the pack classification {classification}", a.artifact_id, aref.classification)));
                        }
                    }
                    sqlx::query("INSERT INTO context_packs(context_pack_id, version, domain_id, manifest, digest, classification, created_by, source_task_id, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
                        .bind(&context_pack_id)
                        .bind(version as i64)
                        .bind(&this.cfg.domain_id)
                        .bind(pack.to_string())
                        .bind(&digest)
                        .bind(&classification)
                        .bind(&ctx.actor.principal_id)
                        .bind(&source_task)
                        .bind(size as i64)
                        .bind(this.now_ts())
                        .execute(&mut *conn)
                        .await
                        .map_err(|e| match crate::db::db_error(e) {
                            err if err.code == ErrorCode::Conflict => Error::conflict(format!("ContextPack {context_pack_id} version {version} already exists; versions are immutable")),
                            err => err,
                        })?;
                    this.metrics.context_pack_size.observe(size as f64);
                    this.metrics.context_pack_artifact_count.observe(artifacts.len() as f64);
                    this.audit(conn, &ctx, AuditRecord::new("context.create", Some(format!("context://{context_pack_id}/{version}")), "success").decision(&decision).detail(json!({"digest": digest, "sizeBytes": size, "classification": classification}))).await?;
                    Ok(ContextPackRecord { context_pack_id, version, digest, classification, size_bytes: size as u64, created_at: this.now_ts() })
                })
            })
            .await
        })
        .await
    }

    async fn get_artifact_in_tx(&self, conn: &mut SqliteConnection, ctx: &Ctx, artifact_id: &str, version: u64) -> Result<ArtifactRef, Error> {
        let row = sqlx::query("SELECT * FROM artifacts WHERE artifact_id = ? AND version = ? AND status = 'complete'")
            .bind(artifact_id)
            .bind(version as i64)
            .fetch_optional(&mut *conn)
            .await
            .db()?
            .ok_or_else(|| Error::not_found("artifact"))?;
        let owner = scol(&row, "created_by_principal_id") == ctx.actor.principal_id;
        if !owner && !ctx.actor.permissions.allows_action("artifact.read") {
            return Err(Error::not_found("artifact"));
        }
        crate::artifacts::artifact_ref_from_row(&row)
    }

    async fn pack_row(&self, conn: &mut SqliteConnection, id: &str, version: u64) -> Result<sqlx::sqlite::SqliteRow, Error> {
        sqlx::query("SELECT * FROM context_packs WHERE context_pack_id = ? AND version = ?")
            .bind(id)
            .bind(version as i64)
            .fetch_optional(conn)
            .await
            .db()?
            .ok_or_else(|| Error::not_found("context pack"))
    }

    /// Sections of a pack the caller may see, with the reason when none apply.
    async fn disclosed_sections(
        &self,
        conn: &mut SqliteConnection,
        ctx: &Ctx,
        row: &sqlx::sqlite::SqliteRow,
        task: Option<&TaskRow>,
    ) -> Result<Option<Vec<String>>, Error> {
        let id = scol(row, "context_pack_id");
        let version = icol(row, "version");
        let all: Vec<String> = CONTEXT_SECTIONS.iter().map(|s| s.to_string()).collect();
        if scol(row, "created_by") == ctx.actor.principal_id || ctx.actor.is_admin() {
            return Ok(Some(all));
        }
        let mut sections: Option<Vec<String>> = None;
        let offers = sqlx::query("SELECT sections, status FROM context_offers WHERE context_pack_id = ? AND version = ? AND to_principal_id = ? AND status IN ('pending','accepted')").bind(&id).bind(version).bind(&ctx.actor.principal_id).fetch_all(&mut *conn).await.db()?;
        for o in offers {
            let s: Vec<String> = serde_json::from_value(jcol(&o, "sections")).unwrap_or_default();
            sections.get_or_insert_with(Vec::new).extend(s);
        }
        if let Some(t) = task
            && (t.assignee_principal_id.as_deref() == Some(&ctx.actor.principal_id) || t.requester_principal_id == ctx.actor.principal_id)
        {
            for cref in t.context_refs.iter().filter(|c| c.context_pack_id == id && c.version as i64 == version) {
                sections.get_or_insert_with(Vec::new).extend(cref.sections.clone().unwrap_or_else(|| all.clone()));
            }
        }
        Ok(sections.map(|mut s| {
            s.extend(CONTEXT_MANIFEST_SECTIONS.iter().map(|m| m.to_string()));
            s.sort();
            s.dedup();
            s
        }))
    }

    /// Returns the manifest view by default, or the requested sections, filtered by disclosure, classification,
    /// allowed domains and artifact permissions (POL-01).
    pub async fn get_context_pack(
        &self,
        ctx: &Ctx,
        id: &str,
        version: u64,
        sections: Option<Vec<String>>,
        task_id: Option<&str>,
    ) -> Result<ContextView, Error> {
        let mut conn = self.db.pool().acquire().await.db()?;
        let row = self.pack_row(&mut conn, id, version).await.map_err(|_| Error::not_found("context pack"))?;
        let task = match task_id {
            Some(t) => Some(self.require_task_participant(&mut conn, ctx, t).await?),
            None => None,
        };
        let policy = self.active_policy(&mut conn).await?;
        let scale = policy.scale();
        let classification = scol(&row, "classification");
        let pack = jcol(&row, "manifest");
        let mut actor_ctx = ctx.clone();
        if let Some(t) = &task
            && let (Some(a), true) = (&t.effective_authority, t.assignee_principal_id.as_deref() == Some(&ctx.actor.principal_id))
        {
            actor_ctx.actor.permissions = a.as_permissions();
        }
        let disclosed = self.disclosed_sections(&mut conn, &actor_ctx, &row, task.as_ref()).await?.ok_or_else(|| Error::not_found("context pack"))?;
        // allowed domains (CTX/DOM): the reader's domain must be named by the pack
        let allowed_domains: Vec<String> =
            pack["security"]["allowedDomains"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
        let reader_domain = actor_ctx.actor.peer_domain.clone().unwrap_or_else(|| self.cfg.domain_id.clone());
        let deny = |reason: String| -> Error {
            let denied = Decision {
                decision_id: ids::decision_id(),
                allow: false,
                reasons: vec![reason.clone()],
                obligations: vec![],
                policy_version: policy.version.clone(),
            };
            let mut err = Error::denied(reason);
            err.details = Some(json!({"decision": denied, "action": "context.read", "resource": format!("context://{id}/{version}"), "taskId": task_id}));
            err
        };
        if !allowed_domains.iter().any(|d| d == &reader_domain) {
            return Err(deny(format!("domain {reader_domain} is not permitted to read this ContextPack")));
        }
        if !scale.permits(actor_ctx.actor.permissions.classification_limit(), &classification) && scol(&row, "created_by") != ctx.actor.principal_id {
            return Err(deny(format!("classification {classification} exceeds the caller's clearance")));
        }
        if scol(&row, "created_by") != ctx.actor.principal_id && !actor_ctx.actor.permissions.allows_action("context.read") {
            return Err(deny("context.read is not granted".into()));
        }

        let requested: Vec<String> = match &sections {
            Some(s) => s.clone(),
            None => CONTEXT_MANIFEST_SECTIONS.iter().map(|s| s.to_string()).collect(),
        };
        for s in &requested {
            if !CONTEXT_SECTIONS.contains(&s.as_str()) {
                return Err(Error::invalid(format!("unknown ContextPack section {s}")));
            }
        }
        let mut view = Map::new();
        let mut withheld = Vec::new();
        let mut shown = Vec::new();
        for s in &requested {
            if disclosed.contains(s) {
                for key in context_section_keys(s) {
                    if let Some(v) = pack.get(*key) {
                        view.insert(key.to_string(), v.clone());
                    }
                }
                shown.push(s.clone());
            } else {
                withheld.push(s.clone());
            }
        }
        if sections.is_none()
            && let Some(summary) = pack.pointer("/currentState/summary")
        {
            view.insert("currentState".into(), json!({"summary": summary}));
        }
        // artifacts the reader cannot read are removed from the filtered pack
        let mut redactions: Vec<String> =
            pack["security"]["redactionsApplied"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
        if let Some(list) = view.get("artifacts").and_then(Value::as_array).cloned() {
            let mut kept = Vec::new();
            for a in list {
                let class = a["classification"].as_str().unwrap_or("internal");
                if scale.permits(actor_ctx.actor.permissions.classification_limit(), class) && actor_ctx.actor.permissions.allows_action("artifact.read") {
                    kept.push(a);
                } else {
                    redactions.push(format!("artifact {} withheld by policy", a["artifactId"].as_str().unwrap_or("?")));
                }
            }
            view.insert("artifacts".into(), Value::Array(kept));
        }
        if let Some(sec) = view.get_mut("security").and_then(Value::as_object_mut) {
            sec.insert("redactionsApplied".into(), json!(redactions));
        }
        let mut index = Map::new();
        for s in CONTEXT_SECTIONS {
            let present = sections_present(&pack).contains(&s);
            index.insert(
                s.to_string(),
                json!({"present": present, "bytes": if present { section_size(&pack, s) } else { 0 }, "disclosed": disclosed.iter().any(|d| d == s)}),
            );
        }
        view.insert("contextPackId".into(), json!(id));
        view.insert("version".into(), json!(version));
        view.insert("schemaVersion".into(), json!(SCHEMA_VERSION));
        Ok(ContextView {
            context_pack_id: id.to_string(),
            version,
            digest: scol(&row, "digest"),
            classification,
            disclosed_sections: shown,
            withheld_sections: withheld,
            section_index: Value::Object(index),
            pack: Value::Object(view),
        })
    }

    /// Requester-side validation that attaching a pack to a task discloses nothing the requester cannot already read.
    pub(crate) async fn check_context_refs(&self, conn: &mut SqliteConnection, ctx: &Ctx, refs: &[ContextRef]) -> Result<(), Error> {
        for r in refs {
            let row = self.pack_row(conn, &r.context_pack_id, r.version).await.map_err(|_| Error::not_found("context pack"))?;
            let allowed = self.disclosed_sections(conn, ctx, &row, None).await?;
            let Some(allowed) = allowed else { return Err(Error::not_found("context pack")) };
            if let Some(sections) = &r.sections {
                for s in sections {
                    if !CONTEXT_SECTIONS.contains(&s.as_str()) {
                        return Err(Error::invalid(format!("unknown ContextPack section {s}")));
                    }
                    if !allowed.contains(s) {
                        return Err(Error::denied(format!("section {s} may not be disclosed by the caller")));
                    }
                }
            }
        }
        Ok(())
    }

    pub async fn offer_context(&self, ctx: &Ctx, id: &str, version: u64, req: OfferRequest) -> Result<OfferView, Error> {
        self.run(ctx, "context.offer", async {
            let this = self.clone();
            let ctx = ctx.clone();
            let id = id.to_string();
            self.write(move |tx| {
                Box::pin(async move {
                    let conn: &mut SqliteConnection = tx;
                    let row = this.pack_row(conn, &id, version).await.map_err(|_| Error::not_found("context pack"))?;
                    let pack = jcol(&row, "manifest");
                    let classification = scol(&row, "classification");
                    let decision = this.enforce(conn, &ctx, AuthzRequest::action(Action::ContextWrite).classification(&classification).resource(format!("context://{id}/{version}"))).await?;
                    let owner = scol(&row, "created_by") == ctx.actor.principal_id;
                    let mut task = None;
                    if let Some(t) = &req.task_id {
                        task = Some(this.require_task_participant(conn, &ctx, t).await?);
                    }
                    if !owner && !ctx.actor.is_admin() {
                        // a worker may re-offer context it holds under a task it owns
                        let holds = match &task {
                            Some(t) => t.assignee_principal_id.as_deref() == Some(&ctx.actor.principal_id) && t.context_refs.iter().any(|c| c.context_pack_id == id && c.version == version),
                            None => false,
                        };
                        if !holds {
                            return Err(Error::not_found("context pack"));
                        }
                    }
                    let to = req.to.clone().ok_or_else(|| Error::invalid("`to` is required"))?;
                    let recipient = this.principal_by_label(conn, to.kind, &to.id).await?.filter(|p| p.status == "active").ok_or_else(|| Error::invalid("unknown recipient"))?;
                    let policy = this.active_policy(conn).await?;
                    if !policy.scale().permits(recipient.permissions.classification_limit(), &classification) {
                        return Err(Error::denied(format!("recipient is not cleared for {classification} context")));
                    }
                    let allowed_domains: Vec<String> = pack["security"]["allowedDomains"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
                    if !allowed_domains.iter().any(|d| d == &this.cfg.domain_id) {
                        return Err(Error::denied("the pack's security.allowedDomains excludes this domain"));
                    }
                    let mode = req.mode.clone().unwrap_or_else(|| pack["requestedContinuation"]["mode"].as_str().unwrap_or("consultation").to_string());
                    if !matches!(mode.as_str(), "subtask" | "ownership_transfer" | "consultation") {
                        return Err(Error::invalid("mode must be subtask, ownership_transfer or consultation"));
                    }
                    if mode == "ownership_transfer" {
                        let t = task.as_ref().ok_or_else(|| Error::invalid("taskId is required for an ownership transfer"))?;
                        if t.assignee_principal_id.as_deref() != Some(&ctx.actor.principal_id) || !t.state.is_leased() {
                            return Err(Error::denied("only the current assignee of an active task may offer its ownership"));
                        }
                        if recipient.kind != ActorKind::Agent {
                            return Err(Error::invalid("ownership can only be transferred to an agent"));
                        }
                    }
                    let sections = match &req.sections {
                        Some(s) => {
                            for sec in s {
                                if !CONTEXT_SECTIONS.contains(&sec.as_str()) {
                                    return Err(Error::invalid(format!("unknown ContextPack section {sec}")));
                                }
                            }
                            s.clone()
                        }
                        None => CONTEXT_MANIFEST_SECTIONS.iter().map(|s| s.to_string()).collect(),
                    };
                    // the offerer can only disclose what the offerer may read
                    let own = this.disclosed_sections(conn, &ctx, &row, task.as_ref()).await?.unwrap_or_default();
                    for s in &sections {
                        if !own.contains(s) {
                            return Err(Error::denied(format!("section {s} may not be disclosed by the caller")));
                        }
                    }
                    let offer_id = ids::offer_id();
                    let expires = ts(this.now() + Duration::seconds(req.expires_in_seconds.unwrap_or(3600).clamp(30, 7 * 86400)));
                    sqlx::query("INSERT INTO context_offers(offer_id, domain_id, context_pack_id, version, from_principal_id, to_principal_id, to_agent_id, mode, task_id, sections, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)")
                        .bind(&offer_id)
                        .bind(&this.cfg.domain_id)
                        .bind(&id)
                        .bind(version as i64)
                        .bind(&ctx.actor.principal_id)
                        .bind(&recipient.principal_id)
                        .bind(if recipient.kind == ActorKind::Agent { Some(recipient.id.clone()) } else { None })
                        .bind(&mode)
                        .bind(&req.task_id)
                        .bind(serde_json::to_string(&sections)?)
                        .bind(&expires)
                        .bind(this.now_ts())
                        .execute(&mut *conn)
                        .await
                        .db()?;
                    // the offer message carries the compact manifest only; details are fetched section by section
                    let conversation_id = this.dm_between(conn, &ctx, &recipient).await?;
                    let mut index = Map::new();
                    for s in CONTEXT_SECTIONS {
                        index.insert(s.to_string(), json!({"present": sections_present(&pack).contains(&s), "bytes": section_size(&pack, s)}));
                    }
                    let mut msg = SystemMessage::new(
                        MessageType::ContextOffer,
                        json!({"offerId": offer_id, "contextPackId": id, "version": version, "mode": mode, "taskId": req.task_id, "objective": pack["objective"], "requestedContinuation": pack["requestedContinuation"], "sectionIndex": index, "note": req.note, "digest": scol(&row, "digest")}),
                    );
                    msg.conversation_id = Some(conversation_id);
                    msg.task_id = req.task_id.clone();
                    msg.trigger = Some(TriggerMode::Directed);
                    msg.recipients = vec![(ActorRef { kind: recipient.kind, id: recipient.id.clone(), domain_id: this.cfg.domain_id.clone(), display_name: None }, "receiver".into())];
                    msg.context_refs = vec![ContextRef { context_pack_id: id.clone(), version, sections: Some(sections.clone()) }];
                    this.post_system_message(conn, &ctx, msg).await?;
                    let payload = json!({"offerId": offer_id, "contextPackId": id, "version": version, "mode": mode});
                    let spec = EventSpec::new("context.offered", payload).matrix().recipient(recipient.principal_id.clone(), true).recipient(ctx.actor.principal_id.clone(), false);
                    this.emit(conn, &ctx, spec).await?;
                    this.audit(conn, &ctx, AuditRecord::new("context.offer", Some(format!("context://{id}/{version}")), "success").decision(&decision).detail(json!({"offerId": offer_id, "to": recipient.id, "mode": mode, "sections": sections}))).await?;
                    let r = sqlx::query("SELECT * FROM context_offers WHERE offer_id = ?").bind(&offer_id).fetch_one(&mut *conn).await.db()?;
                    Ok(offer_from_row(&r))
                })
            })
            .await
        })
        .await
    }

    async fn dm_between(&self, conn: &mut SqliteConnection, ctx: &Ctx, other: &crate::auth::PrincipalView) -> Result<String, Error> {
        self.dm_conversation_pub(conn, ctx, other).await
    }

    pub async fn get_offer(&self, ctx: &Ctx, offer_id: &str) -> Result<OfferView, Error> {
        let r = sqlx::query("SELECT * FROM context_offers WHERE offer_id = ? AND (from_principal_id = ? OR to_principal_id = ?)")
            .bind(offer_id)
            .bind(&ctx.actor.principal_id)
            .bind(&ctx.actor.principal_id)
            .fetch_optional(self.db.pool())
            .await
            .db()?
            .ok_or_else(|| Error::not_found("offer"))?;
        Ok(offer_from_row(&r))
    }

    pub async fn decline_offer(&self, ctx: &Ctx, offer_id: &str) -> Result<OfferView, Error> {
        let now = self.now_ts();
        let res =
            sqlx::query("UPDATE context_offers SET status = 'declined', decided_at = ? WHERE offer_id = ? AND to_principal_id = ? AND status = 'pending'")
                .bind(&now)
                .bind(offer_id)
                .bind(&ctx.actor.principal_id)
                .execute(self.db.writer())
                .await
                .db()?;
        if res.rows_affected() == 0 {
            return Err(Error::not_found("pending offer"));
        }
        self.get_offer(ctx, offer_id).await
    }

    pub async fn accept_context(&self, ctx: &Ctx, id: &str, version: u64, req: AcceptRequest) -> Result<AcceptResponse, Error> {
        self.run(ctx, "context.accept", async {
            let this = self.clone();
            let ctx = ctx.clone();
            let id = id.to_string();
            self.write(move |tx| {
                Box::pin(async move {
                    let conn: &mut SqliteConnection = tx;
                    let o = sqlx::query("SELECT * FROM context_offers WHERE offer_id = ? AND context_pack_id = ? AND version = ? AND to_principal_id = ?")
                        .bind(&req.offer_id)
                        .bind(&id)
                        .bind(version as i64)
                        .bind(&ctx.actor.principal_id)
                        .fetch_optional(&mut *conn)
                        .await
                        .db()?
                        .ok_or_else(|| Error::not_found("offer"))?;
                    let offer = offer_from_row(&o);
                    if offer.status != "pending" {
                        return Err(Error::new(ErrorCode::InvalidTransition, format!("offer is already {}", offer.status)));
                    }
                    if offer.expires_at.as_deref().is_some_and(|e| e <= this.now_ts().as_str()) {
                        sqlx::query("UPDATE context_offers SET status = 'expired', decided_at = ? WHERE offer_id = ?")
                            .bind(this.now_ts())
                            .bind(&offer.offer_id)
                            .execute(&mut *conn)
                            .await
                            .db()?;
                        return Err(Error::new(ErrorCode::Expired, "the offer has expired"));
                    }
                    let decision = this.enforce(conn, &ctx, AuthzRequest::action(Action::ContextRead).resource(format!("context://{id}/{version}"))).await?;
                    let sender = this.principal_by_id(conn, &offer.from).await?.ok_or_else(|| Error::internal("offer sender vanished"))?;
                    let mut response = AcceptResponse { offer: offer.clone(), task: None, lease: None, fencing_token: None, authorization_token: None };
                    let mut result = json!({"mode": offer.mode});
                    match offer.mode.as_str() {
                        "ownership_transfer" => {
                            let transfer = this.transfer_ownership_tx(conn, &ctx, &sender, &offer, req.lease_seconds, &decision).await?;
                            result = json!({"mode": offer.mode, "taskId": offer.task_id, "fencingToken": transfer.fencing_token});
                            response.task = Some(transfer.task);
                            response.lease = Some(transfer.lease);
                            response.fencing_token = Some(transfer.fencing_token);
                            response.authorization_token = Some(transfer.token);
                        }
                        "subtask" => {
                            let child = this.create_subtask_for_offer(conn, &ctx, &sender, &offer).await?;
                            result = json!({"mode": offer.mode, "childTaskId": child.task.task_id});
                            response.task = Some(child);
                        }
                        _ => {}
                    }
                    sqlx::query("UPDATE context_offers SET status = 'accepted', decided_at = ?, result = ? WHERE offer_id = ?")
                        .bind(this.now_ts())
                        .bind(result.to_string())
                        .bind(&offer.offer_id)
                        .execute(&mut *conn)
                        .await
                        .db()?;
                    // receiver acknowledgement (non-triggering) back to the offerer
                    let sender_ref = ActorRef { kind: sender.kind, id: sender.id.clone(), domain_id: this.cfg.domain_id.clone(), display_name: None };
                    let conversation_id = this.dm_between(conn, &ctx, &sender).await?;
                    let mut msg = SystemMessage::new(
                        MessageType::ContextAccepted,
                        json!({"offerId": offer.offer_id, "contextPackId": id, "version": version, "result": result}),
                    );
                    msg.conversation_id = Some(conversation_id);
                    msg.task_id = offer.task_id.clone();
                    msg.trigger = Some(TriggerMode::Never);
                    msg.recipients = vec![(sender_ref, "offerer".into())];
                    this.post_system_message(conn, &ctx, msg).await?;
                    let spec =
                        EventSpec::new("context.accepted", json!({"offerId": offer.offer_id, "contextPackId": id, "version": version, "mode": offer.mode}))
                            .matrix()
                            .recipient(sender.principal_id.clone(), false)
                            .recipient(ctx.actor.principal_id.clone(), false);
                    this.emit(conn, &ctx, spec).await?;
                    this.audit(
                        conn,
                        &ctx,
                        AuditRecord::new("context.accept", Some(format!("context://{id}/{version}")), "success")
                            .decision(&decision)
                            .task(offer.task_id.clone())
                            .detail(result),
                    )
                    .await?;
                    let r = sqlx::query("SELECT * FROM context_offers WHERE offer_id = ?").bind(&offer.offer_id).fetch_one(&mut *conn).await.db()?;
                    response.offer = offer_from_row(&r);
                    Ok(response)
                })
            })
            .await
        })
        .await
    }

    /// Ownership moves in a single transaction: the old lease is invalidated and the receiver's lease/fence/grant
    /// created together, so the task is never owned by both or by neither (CTX-04).
    async fn transfer_ownership_tx(
        &self,
        conn: &mut SqliteConnection,
        ctx: &Ctx,
        sender: &crate::auth::PrincipalView,
        offer: &OfferView,
        lease_seconds: Option<i64>,
        decision: &Decision,
    ) -> Result<TransferOutcome, Error> {
        let task_id = offer.task_id.clone().ok_or_else(|| Error::invalid("the offer is not bound to a task"))?;
        let runtime = self.require_runtime(conn, ctx).await?;
        let mut row = self.load_task(conn, &task_id).await?;
        if row.assignee_principal_id.as_deref() != Some(&sender.principal_id) || !row.state.is_leased() || row.lease_expired(&self.now_ts()) {
            return Err(Error::new(ErrorCode::Conflict, "the offering agent no longer owns this task; the transfer cannot complete"));
        }
        if row.state == TaskState::CancelRequested {
            return Err(Error::new(ErrorCode::InvalidTransition, "a task with a pending cancellation cannot change owner"));
        }
        // the receiver must be eligible exactly as for a normal claim
        let offered: Option<i64> = sqlx::query_scalar("SELECT 1 FROM agent_capabilities ac JOIN catalog_entries c ON c.agent_id = ac.agent_id WHERE ac.agent_id = ? AND ac.capability_id = ? AND ac.capability_version = ? AND c.approval_status = 'approved'")
            .bind(&ctx.actor.id)
            .bind(&row.capability_id)
            .bind(&row.capability_version)
            .fetch_optional(&mut *conn)
            .await
            .db()?;
        if offered.is_none() {
            return Err(Error::denied("the receiving agent does not offer the task's capability"));
        }
        self.enforce(
            conn,
            ctx,
            AuthzRequest::action(Action::TaskClaim)
                .capability(&row.capability_id, row.side_effects)
                .resource(format!("task://{}", row.task_id))
                .task(&row.task_id),
        )
        .await?;
        let authority = self.compute_authority(conn, &row, &ctx.actor.permissions).await?;
        if !authority.permits_side_effects(row.side_effects) {
            return Err(Error::denied("the receiving agent's authority does not cover the capability"));
        }
        if let Some(old) = row.authorization_token_id.clone() {
            self.revoke_grant(conn, &old).await?;
        }
        let seconds = lease_seconds.unwrap_or(self.cfg.default_lease_seconds).clamp(1, self.cfg.max_lease_seconds);
        row.fencing_counter += 1;
        row.lease_id = Some(ids::lease_id());
        row.lease_runtime_instance_id = Some(runtime);
        row.lease_expires_at = Some(ts(self.now() + Duration::seconds(seconds)));
        row.assignee_agent_id = Some(ctx.actor.id.clone());
        row.assignee_principal_id = Some(ctx.actor.principal_id.clone());
        row.effective_authority = Some(authority.clone());
        row.policy_decision_id = Some(decision.decision_id.clone());
        let mut claims =
            self.grant_claims(ctx.actor.actor_ref(), Some(row.task_id.clone()), Duration::seconds(self.cfg.max_lease_seconds), &authority.policy_version);
        claims.actions = authority.actions.iter().filter_map(|a| Action::parse(a)).collect();
        claims.capabilities = vec![row.capability_id.clone()];
        claims.resources = vec![format!("task://{}", row.task_id)];
        claims.constraints = Some(json!({"sideEffectsAtMost": authority.side_effects_at_most.as_str()}));
        claims.classification_max = Some(authority.classification_max.clone());
        claims.delegation = Some(DelegationClaim { allowed: authority.delegation_allowed, remaining_depth: authority.delegation_remaining });
        let token = self.issue_grant(conn, claims).await?;
        row.authorization_token_id = Some(self.authorization_jti(&token));
        if !row.context_refs.iter().any(|c| c.context_pack_id == offer.context_pack_id && c.version == offer.version) {
            row.context_refs.push(ContextRef {
                context_pack_id: offer.context_pack_id.clone(),
                version: offer.version,
                sections: Some(offer.sections.clone()),
            });
        }
        if let Some(conv) = &row.conversation_id {
            self.add_member(conn, conv, &ctx.actor.principal_id, "member").await?;
        }
        let previous = sender.id.clone();
        let fence = row.fencing_counter;
        self.commit_update(
            conn,
            ctx,
            &mut row,
            "ownership_transferred",
            TransitionData {
                data: json!({"from": previous, "to": ctx.actor.id, "fencingToken": fence, "offerId": offer.offer_id}),
                wake_assignee: false,
                post_status_message: Some(format!("Ownership transferred from {previous} to {}", ctx.actor.id)),
                ..Default::default()
            },
        )
        .await?;
        let task = self.task_view(conn, &row).await?;
        Ok(TransferOutcome { lease: row.lease().ok_or_else(|| Error::internal("lease missing"))?, fencing_token: row.fencing_counter as u64, token, task })
    }

    /// `subtask`: a child task created on behalf of the offerer and targeted at the receiver.
    async fn create_subtask_for_offer(
        &self,
        conn: &mut SqliteConnection,
        ctx: &Ctx,
        sender: &crate::auth::PrincipalView,
        offer: &OfferView,
    ) -> Result<TaskView, Error> {
        let row = self.pack_row(conn, &offer.context_pack_id, offer.version).await?;
        let pack = jcol(&row, "manifest");
        let capability_id = pack["requestedContinuation"]["expectedOutputCapability"]
            .as_str()
            .ok_or_else(|| Error::invalid("the pack names no expectedOutputCapability for a subtask"))?
            .to_string();
        let version: Option<String> = sqlx::query_scalar(
            "SELECT capability_version FROM agent_capabilities WHERE agent_id = ? AND capability_id = ? ORDER BY capability_version DESC LIMIT 1",
        )
        .bind(&ctx.actor.id)
        .bind(&capability_id)
        .fetch_optional(&mut *conn)
        .await
        .db()?;
        let version = version.ok_or_else(|| Error::denied("the receiving agent does not offer the requested capability"))?;
        let capability: Capability = serde_json::from_str(
            &sqlx::query_scalar::<_, String>("SELECT definition FROM capabilities WHERE domain_id = ? AND capability_id = ? AND version = ?")
                .bind(&self.cfg.domain_id)
                .bind(&capability_id)
                .bind(&version)
                .fetch_one(&mut *conn)
                .await
                .db()?,
        )?;
        let sender_actor = self.actor_for_principal(sender, None).await;
        let mut sender_ctx = Ctx::new(sender_actor).with_trace(ctx.trace.clone()).with_transport("context");
        sender_ctx.transport_event_id = Some(offer.offer_id.clone());
        let input =
            json!({"instruction": pack["requestedContinuation"]["instruction"], "contextPackId": offer.context_pack_id, "contextPackVersion": offer.version});
        let input = if schema::validate_against(&capability.input_schema, &input, "task input").is_ok() { input } else { json!({}) };
        let req = crate::tasks::SubmitTask {
            capability: Some(CapabilityRef { id: capability_id, version }),
            target_agent_id: Some(ctx.actor.id.clone()),
            conversation_id: None,
            parent_task_id: None,
            parent_fencing_token: None,
            input: Some(input),
            context_refs: vec![ContextRef { context_pack_id: offer.context_pack_id.clone(), version: offer.version, sections: Some(offer.sections.clone()) }],
            deadline_at: None,
            idempotency_key: None,
            constraints: None,
        };
        let resp = self.submit_task_in_tx(conn, &sender_ctx, req).await?;
        Ok(resp.task)
    }
}

pub(crate) struct TransferOutcome {
    pub lease: Lease,
    pub fencing_token: u64,
    pub token: String,
    pub task: TaskView,
}
