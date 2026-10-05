//! Request-level idempotency (MSG-04, TASK-01, failure-mode table). The stored response commits in the same
//! transaction as the effect, so a retry after a crash either finds the full result or nothing at all.

use chrono::Duration;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use somework_core::{Error, ErrorCode, canonical::digest_json, clock::ts};
use sqlx::SqliteConnection;

use crate::{
    db::{DbResultExt, scol},
    domain::{Ctx, Domain},
};

pub struct IdemSlot {
    key: String,
    operation: String,
    request_digest: String,
}

pub enum Idem<T> {
    Replay(T),
    Fresh(Option<IdemSlot>),
}

impl Domain {
    pub async fn idem_begin<T: DeserializeOwned>(&self, conn: &mut SqliteConnection, ctx: &Ctx, operation: &str, request: &Value) -> Result<Idem<T>, Error> {
        let Some(key) = ctx.idempotency_key.clone() else { return Ok(Idem::Fresh(None)) };
        let digest = digest_json(request);
        let row = sqlx::query(
            "SELECT operation, request_digest, response FROM idempotency_keys WHERE domain_id = ? AND principal_id = ? AND idem_key = ? AND expires_at > ?",
        )
        .bind(&self.cfg.domain_id)
        .bind(&ctx.actor.principal_id)
        .bind(&key)
        .bind(self.now_ts())
        .fetch_optional(&mut *conn)
        .await
        .db()?;
        if let Some(row) = row {
            if scol(&row, "operation") != operation || scol(&row, "request_digest") != digest {
                return Err(Error::new(ErrorCode::IdempotencyConflict, "this Idempotency-Key was already used with a different request"));
            }
            let stored: T = serde_json::from_str(&scol(&row, "response"))?;
            return Ok(Idem::Replay(stored));
        }
        Ok(Idem::Fresh(Some(IdemSlot { key, operation: operation.to_string(), request_digest: digest })))
    }

    pub async fn idem_finish<T: Serialize>(&self, conn: &mut SqliteConnection, ctx: &Ctx, slot: Option<IdemSlot>, response: &T) -> Result<(), Error> {
        let Some(slot) = slot else { return Ok(()) };
        let now = self.now();
        sqlx::query("INSERT INTO idempotency_keys(domain_id, principal_id, idem_key, operation, request_digest, response, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(&self.cfg.domain_id)
            .bind(&ctx.actor.principal_id)
            .bind(&slot.key)
            .bind(&slot.operation)
            .bind(&slot.request_digest)
            .bind(serde_json::to_string(response)?)
            .bind(ts(now))
            .bind(ts(now + Duration::hours(self.cfg.idempotency_ttl_hours)))
            .execute(conn)
            .await
            .db()?;
        Ok(())
    }

    pub async fn purge_expired_idempotency(&self) -> Result<u64, Error> {
        let res = sqlx::query("DELETE FROM idempotency_keys WHERE expires_at < ?").bind(self.now_ts()).execute(self.db.writer()).await.db()?;
        Ok(res.rows_affected())
    }
}
