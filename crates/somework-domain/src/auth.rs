//! Authentication: workload client assertions (self-signed with a registered Ed25519 key), domain-issued grants
//! (task-bound or delegated) and OIDC human tokens (see [`crate::oidc`]). Sender identity is always derived from
//! these credentials, never from request bodies (ID-03).

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use somework_core::{
    Error, ErrorCode,
    clock::{parse_ts, ts},
    contracts::{Action, ActorKind, ActorRef, AuthorizationToken, DelegationClaim, SideEffects},
    ids,
    jws::{self, TYP_ASSERTION, TYP_GRANT},
    schema,
};
use sqlx::SqliteConnection;

use crate::{
    db::{DbResultExt, scol, scol_opt},
    domain::{Actor, Ctx, Domain, kind_str, parse_kind},
    policy::{AuthzRequest, Permissions},
};

#[derive(Debug, Clone, Default)]
pub struct AuthMeta {
    pub transport: String,
    /// SHA-256 of the client certificate presented on an mTLS connection, when there was one.
    pub peer_cert_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrincipalView {
    pub principal_id: String,
    pub kind: ActorKind,
    pub id: String,
    pub display_name: Option<String>,
    pub status: String,
    pub permissions: Permissions,
    pub public_key: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePrincipal {
    pub kind: ActorKind,
    pub id: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub permissions: Option<Permissions>,
    /// Base64url Ed25519 public key for workload assertions.
    #[serde(default)]
    pub public_key: Option<String>,
    #[serde(default)]
    pub matrix_user_id: Option<String>,
    #[serde(default)]
    pub oidc_issuer: Option<String>,
    #[serde(default)]
    pub oidc_subject: Option<String>,
}

pub fn principal_from_row(row: &sqlx::sqlite::SqliteRow) -> PrincipalView {
    PrincipalView {
        principal_id: scol(row, "principal_id"),
        kind: parse_kind(&scol(row, "kind")).unwrap_or(ActorKind::Service),
        id: scol(row, "external_id"),
        display_name: scol_opt(row, "display_name"),
        status: scol(row, "status"),
        permissions: serde_json::from_str(&scol(row, "permissions")).unwrap_or_default(),
        public_key: scol_opt(row, "public_key"),
        created_at: scol(row, "created_at"),
    }
}

impl Domain {
    pub async fn authenticate(&self, bearer: &str, meta: &AuthMeta) -> Result<Actor, Error> {
        let token = jws::parse(bearer)?;
        match token.typ() {
            Some(TYP_ASSERTION) => self.authenticate_assertion(&token, meta).await,
            Some(TYP_GRANT) => self.authenticate_grant(&token, meta).await,
            _ => Err(Error::unauthenticated("unsupported token type")),
        }
    }

    pub async fn principal_by_label(&self, conn: &mut SqliteConnection, kind: ActorKind, external_id: &str) -> Result<Option<PrincipalView>, Error> {
        let row = sqlx::query("SELECT * FROM principals WHERE domain_id = ? AND kind = ? AND external_id = ?")
            .bind(&self.cfg.domain_id)
            .bind(kind_str(kind))
            .bind(external_id)
            .fetch_optional(conn)
            .await
            .db()?;
        Ok(row.as_ref().map(principal_from_row))
    }

    pub async fn principal_by_id(&self, conn: &mut SqliteConnection, principal_id: &str) -> Result<Option<PrincipalView>, Error> {
        let row = sqlx::query("SELECT * FROM principals WHERE principal_id = ?").bind(principal_id).fetch_optional(conn).await.db()?;
        Ok(row.as_ref().map(principal_from_row))
    }

    async fn authenticate_assertion(&self, token: &jws::Unverified, _meta: &AuthMeta) -> Result<Actor, Error> {
        let issuer = token.claims.get("iss").and_then(Value::as_str).ok_or_else(|| Error::unauthenticated("assertion has no issuer"))?;
        let (kind_raw, id) = issuer.split_once(':').ok_or_else(|| Error::unauthenticated("malformed assertion issuer"))?;
        let kind = parse_kind(kind_raw).ok_or_else(|| Error::unauthenticated("unknown principal kind"))?;
        let mut conn = self.db.pool().acquire().await.db()?;
        let principal = self.principal_by_label(&mut conn, kind, id).await?.ok_or_else(|| Error::unauthenticated("unknown principal"))?;
        if principal.status != "active" {
            return Err(Error::unauthenticated("principal is disabled"));
        }
        let public_key = principal.public_key.as_deref().ok_or_else(|| Error::unauthenticated("principal has no registered key"))?;
        token.verify(&jws::verifying_key_from_b64(public_key)?)?;

        let now = self.now();
        let iat = token.claims.get("iat").and_then(Value::as_i64).ok_or_else(|| Error::unauthenticated("assertion has no iat"))?;
        let exp = token.claims.get("exp").and_then(Value::as_i64).ok_or_else(|| Error::unauthenticated("assertion has no exp"))?;
        if exp - iat > self.cfg.assertion_max_age_seconds + jws::LEEWAY_SECONDS {
            return Err(Error::unauthenticated("assertion lifetime exceeds the permitted maximum"));
        }
        let not_before = DateTime::from_timestamp(iat, 0).ok_or_else(|| Error::unauthenticated("bad iat"))?;
        let expires = DateTime::from_timestamp(exp, 0).ok_or_else(|| Error::unauthenticated("bad exp"))?;
        jws::check_time_window(not_before, expires, now)?;
        let audiences: Vec<&str> = token.claims.get("aud").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        if !audiences.contains(&self.service_audience().as_str()) {
            return Err(Error::unauthenticated("assertion audience does not include this domain"));
        }
        if token.claims.get("once").and_then(Value::as_bool).unwrap_or(false) {
            let jti = token.claims.get("jti").and_then(Value::as_str).ok_or_else(|| Error::unauthenticated("single-use assertion needs a jti"))?;
            self.consume_jti(&format!("assertion:{issuer}"), jti, expires).await?;
        }

        let runtime_instance_id = token.claims.get("runtimeInstanceId").and_then(Value::as_str).map(String::from);
        if let (Some(rt), ActorKind::Agent) = (&runtime_instance_id, kind) {
            let row =
                sqlx::query("SELECT agent_id, status FROM runtime_instances WHERE runtime_instance_id = ?").bind(rt).fetch_optional(&mut *conn).await.db()?;
            if let Some(row) = row {
                if scol(&row, "agent_id") != id {
                    return Err(Error::unauthenticated("runtime instance belongs to another agent"));
                }
                if scol(&row, "status") != "active" {
                    return Err(Error::unauthenticated("runtime instance has ended"));
                }
            }
        }
        Ok(Actor {
            principal_id: principal.principal_id,
            kind,
            id: principal.id,
            domain_id: self.cfg.domain_id.clone(),
            display_name: principal.display_name,
            permissions: principal.permissions,
            runtime_instance_id,
            grant_jti: None,
            task_scope: None,
            peer_domain: None,
        })
    }

    async fn authenticate_grant(&self, token: &jws::Unverified, _meta: &AuthMeta) -> Result<Actor, Error> {
        let kid = token.kid().ok_or_else(|| Error::unauthenticated("grant has no key id"))?;
        token.verify(&self.verifying_key(kid).await?)?;
        schema::validate_contract("AuthorizationToken", &token.claims)
            .map_err(|e| Error::unauthenticated(format!("grant violates the contract: {}", e.message)))?;
        let claims: AuthorizationToken = serde_json::from_value(token.claims.clone())?;
        if claims.domain_id != self.cfg.domain_id || !claims.audience.contains(&self.service_audience()) {
            return Err(Error::unauthenticated("grant is not addressed to this domain service"));
        }
        let not_before = parse_ts(&claims.not_before).ok_or_else(|| Error::unauthenticated("bad notBefore"))?;
        let expires = parse_ts(&claims.expires_at).ok_or_else(|| Error::unauthenticated("bad expiresAt"))?;
        jws::check_time_window(not_before, expires, self.now())?;

        let mut conn = self.db.pool().acquire().await.db()?;
        let row = sqlx::query("SELECT revoked_at FROM auth_grants WHERE jti = ?").bind(&claims.jti).fetch_optional(&mut *conn).await.db()?;
        match row {
            None => return Err(Error::unauthenticated("grant is not recognized")),
            Some(r) if scol_opt(&r, "revoked_at").is_some() => return Err(Error::unauthenticated("grant was revoked")),
            _ => {}
        }
        let principal = self
            .principal_by_label(&mut conn, claims.subject.kind, &claims.subject.id)
            .await?
            .ok_or_else(|| Error::unauthenticated("grant subject is unknown"))?;
        if principal.status != "active" {
            return Err(Error::unauthenticated("principal is disabled"));
        }
        let policy = self.active_policy(&mut conn).await?;
        let permissions = principal.permissions.narrowed_by(&claims, &policy.scale());
        Ok(Actor {
            principal_id: principal.principal_id,
            kind: claims.subject.kind,
            id: principal.id,
            domain_id: self.cfg.domain_id.clone(),
            display_name: principal.display_name,
            permissions,
            runtime_instance_id: None,
            grant_jti: Some(claims.jti.clone()),
            task_scope: claims.task_id.clone(),
            peer_domain: None,
        })
    }

    /// Single-use token ids (replay control). Entries expire together with the token.
    pub async fn consume_jti(&self, scope: &str, jti: &str, expires_at: DateTime<Utc>) -> Result<(), Error> {
        let mut tx = self.db.begin_write().await?;
        sqlx::query("DELETE FROM used_jtis WHERE expires_at < ?").bind(self.now_ts()).execute(&mut *tx).await.db()?;
        let inserted = sqlx::query("INSERT OR IGNORE INTO used_jtis(jti, scope, expires_at) VALUES (?, ?, ?)")
            .bind(jti)
            .bind(scope)
            .bind(ts(expires_at + Duration::seconds(jws::LEEWAY_SECONDS)))
            .execute(&mut *tx)
            .await
            .db()?;
        tx.commit().await.db()?;
        if inserted.rows_affected() == 0 {
            return Err(Error::unauthenticated("token replay detected"));
        }
        Ok(())
    }

    /// Signs and records an authorization grant (task-bound, delegated, or administratively issued).
    pub async fn issue_grant(&self, conn: &mut SqliteConnection, claims: AuthorizationToken) -> Result<String, Error> {
        let value = serde_json::to_value(&claims)?;
        schema::validate_contract("AuthorizationToken", &value)?;
        let (kid, key) = self.active_signing_key()?;
        let token = jws::sign(TYP_GRANT, &kid, &key, &value);
        let subject = sqlx::query_scalar::<_, String>("SELECT principal_id FROM principals WHERE domain_id = ? AND kind = ? AND external_id = ?")
            .bind(&self.cfg.domain_id)
            .bind(kind_str(claims.subject.kind))
            .bind(&claims.subject.id)
            .fetch_optional(&mut *conn)
            .await
            .db()?
            .ok_or_else(|| Error::not_found("grant subject"))?;
        sqlx::query(
            "INSERT INTO auth_grants(jti, domain_id, subject_principal_id, task_id, parent_jti, claims, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&claims.jti)
        .bind(&self.cfg.domain_id)
        .bind(subject)
        .bind(&claims.task_id)
        .bind(&claims.parent_jti)
        .bind(value.to_string())
        .bind(&claims.issued_at)
        .bind(&claims.expires_at)
        .execute(conn)
        .await
        .db()?;
        Ok(token)
    }

    pub fn grant_claims(
        &self,
        subject: somework_core::contracts::ActorRef,
        task_id: Option<String>,
        ttl: Duration,
        policy_version: &str,
    ) -> AuthorizationToken {
        let now = self.now();
        AuthorizationToken {
            jti: ids::jti(),
            issuer: format!("domain:{}", self.cfg.domain_id),
            subject,
            audience: vec![self.service_audience()],
            domain_id: self.cfg.domain_id.clone(),
            task_id,
            actions: vec![],
            capabilities: vec![],
            resources: vec![],
            constraints: None,
            classification_max: None,
            delegation: None,
            confirmation: None,
            policy_version: policy_version.to_string(),
            parent_jti: None,
            issued_at: ts(now),
            not_before: ts(now),
            expires_at: ts(now + ttl),
        }
    }

    pub async fn revoke_grant(&self, conn: &mut SqliteConnection, jti: &str) -> Result<(), Error> {
        sqlx::query("UPDATE auth_grants SET revoked_at = ? WHERE jti = ? AND revoked_at IS NULL").bind(self.now_ts()).bind(jti).execute(conn).await.db()?;
        Ok(())
    }

    // ---- administration of principals ---------------------------------------------------------------------------------

    pub async fn create_principal(&self, ctx: &Ctx, req: CreatePrincipal) -> Result<PrincipalView, Error> {
        self.run(ctx, "principal.create", async {
            if req.id.trim().is_empty() || req.id.len() > 256 {
                return Err(Error::invalid("principal id must be 1-256 characters"));
            }
            if let Some(pk) = &req.public_key {
                jws::verifying_key_from_b64(pk).map_err(|_| Error::invalid("publicKey must be a base64url Ed25519 public key"))?;
            }
            let permissions = req.permissions.clone().unwrap_or_else(|| match req.kind {
                ActorKind::Agent => Permissions::default_agent(),
                ActorKind::Human => Permissions::default_human(),
                _ => Permissions::default(),
            });
            let this = self.clone();
            let ctx2 = ctx.clone();
            self.write(move |tx| {
                Box::pin(async move {
                    let decision = this.enforce(tx, &ctx2, AuthzRequest::new("principal.manage")).await?;
                    let principal_id = ids::principal_id();
                    sqlx::query("INSERT INTO principals(principal_id, domain_id, kind, external_id, display_name, status, permissions, public_key, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)")
                        .bind(&principal_id)
                        .bind(&this.cfg.domain_id)
                        .bind(kind_str(req.kind))
                        .bind(&req.id)
                        .bind(&req.display_name)
                        .bind(serde_json::to_string(&permissions)?)
                        .bind(&req.public_key)
                        .bind(this.now_ts())
                        .execute(&mut **tx)
                        .await
                        .map_err(|e| match crate::db::db_error(e) {
                            err if err.code == ErrorCode::Conflict => Error::conflict(format!("principal {}:{} already exists", kind_str(req.kind), req.id)),
                            err => err,
                        })?;
                    if req.kind == ActorKind::Human && (req.matrix_user_id.is_some() || req.oidc_subject.is_some()) {
                        sqlx::query("INSERT INTO human_identities(principal_id, oidc_issuer, oidc_subject, matrix_user_id) VALUES (?, ?, ?, ?)")
                            .bind(&principal_id)
                            .bind(&req.oidc_issuer)
                            .bind(&req.oidc_subject)
                            .bind(&req.matrix_user_id)
                            .execute(&mut **tx)
                            .await
                            .db()?;
                    }
                    this.audit(
                        tx,
                        &ctx2,
                        crate::audit::AuditRecord::new("principal.create", Some(format!("principal://{}:{}", kind_str(req.kind), req.id)), "success")
                            .decision(&decision)
                            .detail(json!({"kind": kind_str(req.kind), "id": req.id})),
                    )
                    .await?;
                    let row = sqlx::query("SELECT * FROM principals WHERE principal_id = ?").bind(&principal_id).fetch_one(&mut **tx).await.db()?;
                    Ok(principal_from_row(&row))
                })
            })
            .await
        })
        .await
    }

    pub async fn update_principal(
        &self,
        ctx: &Ctx,
        kind: ActorKind,
        id: &str,
        permissions: Option<Permissions>,
        status: Option<String>,
        public_key: Option<String>,
    ) -> Result<PrincipalView, Error> {
        self.run(ctx, "principal.update", async {
            let this = self.clone();
            let ctx2 = ctx.clone();
            let id = id.to_string();
            self.write(move |tx| {
                Box::pin(async move {
                    let decision = this.enforce(tx, &ctx2, AuthzRequest::new("principal.manage")).await?;
                    let existing = this.principal_by_label(tx, kind, &id).await?.ok_or_else(|| Error::not_found("principal"))?;
                    if let Some(p) = &permissions {
                        sqlx::query("UPDATE principals SET permissions = ? WHERE principal_id = ?")
                            .bind(serde_json::to_string(p)?)
                            .bind(&existing.principal_id)
                            .execute(&mut **tx)
                            .await
                            .db()?;
                    }
                    if let Some(s) = &status {
                        if !matches!(s.as_str(), "active" | "disabled") {
                            return Err(Error::invalid("status must be active or disabled"));
                        }
                        sqlx::query("UPDATE principals SET status = ? WHERE principal_id = ?")
                            .bind(s)
                            .bind(&existing.principal_id)
                            .execute(&mut **tx)
                            .await
                            .db()?;
                    }
                    if let Some(k) = &public_key {
                        jws::verifying_key_from_b64(k)?;
                        sqlx::query("UPDATE principals SET public_key = ? WHERE principal_id = ?")
                            .bind(k)
                            .bind(&existing.principal_id)
                            .execute(&mut **tx)
                            .await
                            .db()?;
                    }
                    this.audit(
                        tx,
                        &ctx2,
                        crate::audit::AuditRecord::new("principal.update", Some(format!("principal://{}:{}", kind_str(kind), id)), "success")
                            .decision(&decision),
                    )
                    .await?;
                    let row = sqlx::query("SELECT * FROM principals WHERE principal_id = ?").bind(&existing.principal_id).fetch_one(&mut **tx).await.db()?;
                    Ok(principal_from_row(&row))
                })
            })
            .await
        })
        .await
    }

    pub async fn list_principals(&self, ctx: &Ctx) -> Result<Vec<PrincipalView>, Error> {
        self.enforce_read(ctx, AuthzRequest::new("principal.manage")).await?;
        let rows =
            sqlx::query("SELECT * FROM principals WHERE domain_id = ? ORDER BY created_at").bind(&self.cfg.domain_id).fetch_all(self.db.pool()).await.db()?;
        Ok(rows.iter().map(principal_from_row).collect())
    }

    /// Operator bootstrap (no caller yet): creates or returns an admin service principal. Access to the database file
    /// is the trust anchor, exactly like `psql` access to a PostgreSQL deployment would have been.
    pub async fn bootstrap_admin(&self, name: &str, public_key: &str) -> Result<PrincipalView, Error> {
        jws::verifying_key_from_b64(public_key)?;
        let mut tx = self.db.begin_write().await?;
        if let Some(existing) = self.principal_by_label(&mut tx, ActorKind::Service, name).await? {
            sqlx::query("UPDATE principals SET public_key = ?, permissions = ?, status = 'active' WHERE principal_id = ?")
                .bind(public_key)
                .bind(serde_json::to_string(&Permissions::admin())?)
                .bind(&existing.principal_id)
                .execute(&mut *tx)
                .await
                .db()?;
        } else {
            sqlx::query("INSERT INTO principals(principal_id, domain_id, kind, external_id, display_name, status, permissions, public_key, created_at) VALUES (?, ?, 'service', ?, ?, 'active', ?, ?, ?)")
                .bind(ids::principal_id())
                .bind(&self.cfg.domain_id)
                .bind(name)
                .bind(name)
                .bind(serde_json::to_string(&Permissions::admin())?)
                .bind(public_key)
                .bind(self.now_ts())
                .execute(&mut *tx)
                .await
                .db()?;
        }
        let row = sqlx::query("SELECT * FROM principals WHERE domain_id = ? AND kind = 'service' AND external_id = ?")
            .bind(&self.cfg.domain_id)
            .bind(name)
            .fetch_one(&mut *tx)
            .await
            .db()?;
        tx.commit().await.db()?;
        Ok(principal_from_row(&row))
    }

    /// Maps a Matrix user id to its explicit human principal (ID-04). Display names are never consulted.
    pub async fn principal_for_matrix_user(&self, matrix_user_id: &str) -> Result<Option<PrincipalView>, Error> {
        let row = sqlx::query(
            "SELECT p.* FROM principals p JOIN human_identities h ON h.principal_id = p.principal_id WHERE h.matrix_user_id = ? AND p.status = 'active'",
        )
        .bind(matrix_user_id)
        .fetch_optional(self.db.pool())
        .await
        .db()?;
        Ok(row.as_ref().map(principal_from_row))
    }

    pub async fn actor_for_principal(&self, principal: &PrincipalView, peer_domain: Option<String>) -> Actor {
        Actor {
            principal_id: principal.principal_id.clone(),
            kind: principal.kind,
            id: principal.id.clone(),
            domain_id: self.cfg.domain_id.clone(),
            display_name: principal.display_name.clone(),
            permissions: principal.permissions.clone(),
            runtime_instance_id: None,
            grant_jti: None,
            task_scope: None,
            peer_domain,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DelegateGrant {
    pub subject: Option<crate::messages::MemberRef>,
    pub actions: Vec<String>,
    pub capabilities: Vec<String>,
    pub resources: Vec<String>,
    pub constraints: Option<Value>,
    pub classification_max: Option<String>,
    pub ttl_seconds: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegatedGrant {
    pub token: String,
    pub jti: String,
    pub parent_jti: String,
    pub expires_at: String,
    pub remaining_depth: u32,
}

impl Domain {
    /// `POST /v1/authorizations/delegate`: mint a child grant that can only narrow the caller's own grant.
    pub async fn delegate_grant(&self, ctx: &Ctx, req: DelegateGrant) -> Result<DelegatedGrant, Error> {
        self.run(ctx, "authorization.delegate", async {
            let parent_jti = ctx.actor.grant_jti.clone().ok_or_else(|| Error::denied("delegation requires a grant-bound credential"))?;
            let subject = req.subject.clone().ok_or_else(|| Error::invalid("subject is required"))?;
            let this = self.clone();
            let ctx = ctx.clone();
            self.write(move |tx| {
                Box::pin(async move {
                    let conn = &mut **tx;
                    let decision = this.enforce(conn, &ctx, AuthzRequest::new("task.delegate")).await?;
                    let row = sqlx::query("SELECT claims, revoked_at, expires_at FROM auth_grants WHERE jti = ?")
                        .bind(&parent_jti)
                        .fetch_optional(&mut *conn)
                        .await
                        .db()?
                        .ok_or_else(|| Error::denied("parent grant is unknown"))?;
                    if scol_opt(&row, "revoked_at").is_some() {
                        return Err(Error::denied("parent grant was revoked"));
                    }
                    let parent: AuthorizationToken = serde_json::from_str(&scol(&row, "claims"))?;
                    let delegation = parent
                        .delegation
                        .clone()
                        .filter(|d| d.allowed && d.remaining_depth > 0)
                        .ok_or_else(|| Error::denied("the parent grant does not permit further delegation"))?;
                    let target = this
                        .principal_by_label(conn, subject.kind, &subject.id)
                        .await?
                        .filter(|p| p.status == "active")
                        .ok_or_else(|| Error::invalid("unknown subject"))?;
                    // a child can only narrow: every requested value must already be covered by the parent
                    let parent_actions: Vec<&str> = parent.actions.iter().map(|a| a.as_str()).collect();
                    let mut actions = vec![];
                    for a in &req.actions {
                        if !parent_actions.contains(&a.as_str()) {
                            return Err(Error::denied(format!("action {a} is not covered by the parent grant")));
                        }
                        actions.push(Action::parse(a).ok_or_else(|| Error::invalid(format!("unknown action {a}")))?);
                    }
                    if actions.is_empty() {
                        return Err(Error::invalid("at least one action is required"));
                    }
                    for c in &req.capabilities {
                        if !parent.capabilities.is_empty() && !somework_core::classification::any_glob(&parent.capabilities, c) {
                            return Err(Error::denied(format!("capability {c} is not covered by the parent grant")));
                        }
                    }
                    for r in &req.resources {
                        if !parent.resources.is_empty() && !somework_core::classification::any_glob(&parent.resources, r) {
                            return Err(Error::denied(format!("resource {r} is not covered by the parent grant")));
                        }
                    }
                    let policy = this.active_policy(conn).await?;
                    let scale = policy.scale();
                    let classification = match (&req.classification_max, &parent.classification_max) {
                        (Some(c), Some(p)) => {
                            if !scale.permits(p, c) {
                                return Err(Error::denied("classificationMax exceeds the parent grant"));
                            }
                            Some(c.clone())
                        }
                        (None, p) => p.clone(),
                        (Some(c), None) => Some(c.clone()),
                    };
                    let ttl = Duration::seconds(req.ttl_seconds.unwrap_or(300).clamp(1, this.cfg.grant_ttl_seconds));
                    let parent_exp = parse_ts(&parent.expires_at).ok_or_else(|| Error::internal("parent grant has a bad expiry"))?;
                    let mut claims = this.grant_claims(
                        ActorRef { kind: target.kind, id: target.id.clone(), domain_id: this.cfg.domain_id.clone(), display_name: None },
                        parent.task_id.clone(),
                        ttl,
                        &policy.version,
                    );
                    if parse_ts(&claims.expires_at).is_some_and(|e| e > parent_exp) {
                        claims.expires_at = parent.expires_at.clone();
                    }
                    claims.actions = actions;
                    claims.capabilities = if req.capabilities.is_empty() { parent.capabilities.clone() } else { req.capabilities.clone() };
                    claims.resources = if req.resources.is_empty() { parent.resources.clone() } else { req.resources.clone() };
                    let mut constraints = parent.constraints.clone().unwrap_or_else(|| json!({}));
                    if let Some(c) = &req.constraints {
                        if let (Some(requested), Some(allowed)) = (
                            c.get("sideEffectsAtMost").and_then(Value::as_str).and_then(SideEffects::parse),
                            constraints.get("sideEffectsAtMost").and_then(Value::as_str).and_then(SideEffects::parse),
                        ) && requested > allowed
                        {
                            return Err(Error::denied("sideEffectsAtMost exceeds the parent grant"));
                        }
                        if let Some(obj) = c.as_object() {
                            for (k, v) in obj {
                                constraints[k] = v.clone();
                            }
                        }
                    }
                    claims.constraints = Some(constraints);
                    claims.classification_max = classification;
                    let remaining = delegation.remaining_depth - 1;
                    claims.delegation = Some(DelegationClaim { allowed: remaining > 0, remaining_depth: remaining });
                    claims.parent_jti = Some(parent_jti.clone());
                    let jti = claims.jti.clone();
                    let expires_at = claims.expires_at.clone();
                    let token = this.issue_grant(conn, claims).await?;
                    this.audit(
                        conn,
                        &ctx,
                        crate::audit::AuditRecord::new("authorization.delegate", Some(format!("grant://{jti}")), "success")
                            .decision(&decision)
                            .detail(json!({"parentJti": parent_jti, "subject": target.id})),
                    )
                    .await?;
                    Ok(DelegatedGrant { token, jti, parent_jti, expires_at, remaining_depth: remaining })
                })
            })
            .await
        })
        .await
    }
}

impl Domain {
    /// Maps a verified OIDC identity to its explicitly provisioned human principal (ID-04).
    pub async fn actor_for_oidc(&self, issuer: &str, subject: &str) -> Result<Actor, Error> {
        let row = sqlx::query("SELECT p.* FROM principals p JOIN human_identities h ON h.principal_id = p.principal_id WHERE h.oidc_issuer = ? AND h.oidc_subject = ? AND p.status = 'active'")
            .bind(issuer)
            .bind(subject)
            .fetch_optional(self.db.pool())
            .await
            .db()?;
        let principal = row.as_ref().map(principal_from_row).ok_or_else(|| Error::unauthenticated("this identity is not mapped to a SomeWork principal"))?;
        Ok(self.actor_for_principal(&principal, None).await)
    }
}
