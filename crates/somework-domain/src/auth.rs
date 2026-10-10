//! Authentication: workload client assertions (self-signed with a registered Ed25519 key) and OIDC human tokens (see [`crate::oidc`]). Sender identity is always derived from
//! these credentials, never from request bodies (ID-03).

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use somework_core::{
    Error, ErrorCode,
    clock::ts,
    contracts::ActorKind,
    ids,
    jws::{self, TYP_ASSERTION},
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

    pub async fn actor_for_principal(&self, principal: &PrincipalView) -> Actor {
        Actor {
            principal_id: principal.principal_id.clone(),
            kind: principal.kind,
            id: principal.id.clone(),
            domain_id: self.cfg.domain_id.clone(),
            display_name: principal.display_name.clone(),
            permissions: principal.permissions.clone(),
            runtime_instance_id: None,
        }
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
        Ok(self.actor_for_principal(&principal).await)
    }
}
