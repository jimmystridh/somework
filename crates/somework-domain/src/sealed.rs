//! Sealed secrets (optional extension): opaque envelopes encrypted by the sender for one recipient, readable once,
//! with a short TTL. They are deliberately separate from messages, artifacts and ContextPacks.

use serde::{Deserialize, Serialize};
use serde_json::json;
use somework_core::{
    Error, ErrorCode,
    canonical::sha256_hex,
    clock::ts,
    contracts::{Action, ActorKind},
    ids,
};

use crate::{
    audit::AuditRecord,
    db::{DbResultExt, scol, scol_opt},
    domain::{Ctx, Domain, kind_str},
    messages::MemberRef,
    policy::AuthzRequest,
};

pub const MAX_SEALED_TTL_SECONDS: i64 = 3600;
pub const MAX_ENVELOPE_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SealRequest {
    pub to: Option<MemberRef>,
    /// Opaque ciphertext produced by the sender; the server never interprets it.
    pub envelope: Option<String>,
    pub label: Option<String>,
    pub ttl_seconds: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedReceipt {
    pub secret_id: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedSecret {
    pub secret_id: String,
    pub from: String,
    pub label: Option<String>,
    pub envelope: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedPending {
    pub secret_id: String,
    pub from: String,
    pub label: Option<String>,
    pub expires_at: String,
}

impl Domain {
    pub async fn seal_secret(&self, ctx: &Ctx, req: SealRequest) -> Result<SealedReceipt, Error> {
        self.run(ctx, "sealed.seal", async {
            let to = req.to.clone().ok_or_else(|| Error::invalid("`to` is required"))?;
            let envelope = req.envelope.clone().filter(|e| !e.is_empty()).ok_or_else(|| Error::invalid("envelope is required"))?;
            if envelope.len() > MAX_ENVELOPE_BYTES {
                return Err(Error::new(ErrorCode::PayloadTooLarge, format!("sealed envelopes are limited to {MAX_ENVELOPE_BYTES} bytes")));
            }
            let ttl = req.ttl_seconds.unwrap_or(300).clamp(1, MAX_SEALED_TTL_SECONDS);
            let this = self.clone();
            let ctx = ctx.clone();
            self.write(move |tx| {
                Box::pin(async move {
                    let conn = &mut **tx;
                    let decision = this.enforce(conn, &ctx, AuthzRequest::action(Action::MessageSend).resource("sealed://new")).await?;
                    let recipient = this.principal_by_label(conn, to.kind, &to.id).await?.filter(|p| p.status == "active").ok_or_else(|| Error::invalid("unknown recipient"))?;
                    let secret_id = ids::new_id("sec");
                    let now = this.now();
                    let expires = ts(now + chrono::Duration::seconds(ttl));
                    sqlx::query("INSERT INTO sealed_secrets(secret_id, domain_id, sender_principal_id, recipient_principal_id, label, envelope, envelope_digest, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
                        .bind(&secret_id)
                        .bind(&this.cfg.domain_id)
                        .bind(&ctx.actor.principal_id)
                        .bind(&recipient.principal_id)
                        .bind(&req.label)
                        .bind(&envelope)
                        .bind(sha256_hex(envelope.as_bytes()))
                        .bind(ts(now))
                        .bind(&expires)
                        .execute(&mut *conn)
                        .await
                        .db()?;
                    this.audit(conn, &ctx, AuditRecord::new("sealed.seal", Some(format!("sealed://{secret_id}")), "success").decision(&decision).detail(json!({"recipient": recipient.id, "ttlSeconds": ttl}))).await?;
                    Ok(SealedReceipt { secret_id, expires_at: expires })
                })
            })
            .await
        })
        .await
    }

    /// One-time read: the envelope is deleted in the same transaction that returns it.
    pub async fn unseal_secret(&self, ctx: &Ctx, secret_id: &str) -> Result<SealedSecret, Error> {
        self.run(ctx, "sealed.unseal", async {
            let this = self.clone();
            let ctx = ctx.clone();
            let secret_id = secret_id.to_string();
            self.write(move |tx| {
                Box::pin(async move {
                    let conn = &mut **tx;
                    let row = sqlx::query("SELECT * FROM sealed_secrets WHERE secret_id = ? AND recipient_principal_id = ?")
                        .bind(&secret_id)
                        .bind(&ctx.actor.principal_id)
                        .fetch_optional(&mut *conn)
                        .await
                        .db()?
                        .ok_or_else(|| Error::not_found("sealed secret"))?;
                    if scol_opt(&row, "read_at").is_some() {
                        return Err(Error::new(ErrorCode::Expired, "the sealed secret was already read"));
                    }
                    if scol(&row, "expires_at") <= this.now_ts() {
                        sqlx::query("UPDATE sealed_secrets SET envelope = NULL WHERE secret_id = ?").bind(&secret_id).execute(&mut *conn).await.db()?;
                        return Err(Error::new(ErrorCode::Expired, "the sealed secret has expired"));
                    }
                    let envelope = scol(&row, "envelope");
                    sqlx::query("UPDATE sealed_secrets SET envelope = NULL, read_at = ? WHERE secret_id = ?")
                        .bind(this.now_ts())
                        .bind(&secret_id)
                        .execute(&mut *conn)
                        .await
                        .db()?;
                    let sender = this.principal_by_id(conn, &scol(&row, "sender_principal_id")).await?;
                    let from = sender.map(|p| format!("{}:{}", kind_str(p.kind), p.id)).unwrap_or_default();
                    this.audit(conn, &ctx, AuditRecord::new("sealed.unseal", Some(format!("sealed://{secret_id}")), "success")).await?;
                    Ok(SealedSecret { secret_id, from, label: scol_opt(&row, "label"), envelope, expires_at: scol(&row, "expires_at") })
                })
            })
            .await
        })
        .await
    }

    pub async fn list_sealed_pending(&self, ctx: &Ctx) -> Result<Vec<SealedPending>, Error> {
        let rows = sqlx::query("SELECT s.secret_id, s.label, s.expires_at, p.kind, p.external_id FROM sealed_secrets s JOIN principals p ON p.principal_id = s.sender_principal_id WHERE s.recipient_principal_id = ? AND s.read_at IS NULL AND s.envelope IS NOT NULL AND s.expires_at > ? ORDER BY s.created_at")
            .bind(&ctx.actor.principal_id)
            .bind(self.now_ts())
            .fetch_all(self.db.pool())
            .await
            .db()?;
        Ok(rows
            .iter()
            .map(|r| SealedPending {
                secret_id: scol(r, "secret_id"),
                from: format!("{}:{}", scol(r, "kind"), scol(r, "external_id")),
                label: scol_opt(r, "label"),
                expires_at: scol(r, "expires_at"),
            })
            .collect())
    }

    /// Public key of a principal, for sealing envelopes to it. Public keys are not secret.
    pub async fn principal_public_key(&self, ctx: &Ctx, kind: ActorKind, id: &str) -> Result<String, Error> {
        self.enforce_read(ctx, AuthzRequest::action(Action::MessageSend)).await?;
        let mut conn = self.db.pool().acquire().await.db()?;
        let p = self.principal_by_label(&mut conn, kind, id).await?.filter(|p| p.status == "active").ok_or_else(|| Error::not_found("principal"))?;
        p.public_key.ok_or_else(|| Error::not_found("public key"))
    }

    /// Removes expired envelopes (maintenance).
    pub async fn purge_expired_sealed(&self) -> Result<u64, Error> {
        let res = sqlx::query("UPDATE sealed_secrets SET envelope = NULL WHERE envelope IS NOT NULL AND expires_at <= ?")
            .bind(self.now_ts())
            .execute(self.db.writer())
            .await
            .db()?;
        Ok(res.rows_affected())
    }
}
