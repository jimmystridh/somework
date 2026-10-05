//! Durable store for the Matrix bridge's end-to-end encryption state (Olm accounts and sessions, Megolm sessions,
//! device-key cache, replay index). Every secret (vodozemac pickles) is sealed with the domain master key before it
//! touches SQLite, so a copy of the database file alone reveals no key material. The same tables are part of every
//! backup (they live in the main database) and can additionally be exported as a passphrase-wrapped recovery bundle.

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit as _},
};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Sha256;
use somework_core::{Error, ErrorCode, jws};
use vodozemac::megolm::{GroupSession, InboundGroupSession, InboundGroupSessionPickle, MegolmMessage, SessionConfig};

use crate::{
    db::{DbResultExt, icol, scol, scol_opt},
    domain::Domain,
};

const SELFTEST_PLAINTEXT: &str = "somework-crypto-selftest-v1";

#[derive(Debug, Clone)]
pub struct AccountRow {
    pub user_id: String,
    pub device_id: String,
    pub generation: i64,
    pub pickle: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct OlmRow {
    pub session_id: String,
    pub user_id: String,
    pub device_id: String,
    pub peer_user: String,
    pub peer_device: String,
    pub peer_curve25519: String,
    pub pickle: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct OutboundRow {
    pub session_id: String,
    pub user_id: String,
    pub device_id: String,
    pub room_id: String,
    pub pickle: Vec<u8>,
    pub message_count: i64,
    /// `user|device` pairs the session key was shared with.
    pub shared_with: Vec<String>,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct InboundRow {
    pub room_id: String,
    pub session_id: String,
    pub user_id: String,
    pub sender_key: String,
    pub sender_user: String,
    pub sender_device: String,
    pub pickle: Vec<u8>,
    pub first_known_index: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceKeyRow {
    pub user_id: String,
    pub device_id: String,
    pub curve25519: String,
    pub ed25519: String,
    pub deleted: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CryptoVerifyReport {
    pub accounts: usize,
    pub olm_sessions: usize,
    pub megolm_outbound: usize,
    pub megolm_inbound: usize,
    /// The stored Megolm test vector decrypted with the recovered key material.
    pub selftest_vector_ok: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CryptoImportReport {
    pub accounts: usize,
    pub olm_sessions: usize,
    pub megolm_outbound: usize,
    pub megolm_inbound: usize,
    pub replay_entries: usize,
    pub device_keys: usize,
}

fn aad(table: &str, key: &str) -> Vec<u8> {
    format!("mxcrypto:{table}:{key}").into_bytes()
}

type HmacSha256 = Hmac<Sha256>;

fn pbkdf2_sha256(password: &[u8], salt: &[u8], iterations: u32) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(password).expect("HMAC accepts any key length");
    mac.update(salt);
    mac.update(&1u32.to_be_bytes());
    let mut u = mac.finalize().into_bytes();
    let mut out: [u8; 32] = u.into();
    for _ in 1..iterations {
        let mut mac = HmacSha256::new_from_slice(password).expect("HMAC accepts any key length");
        mac.update(&u);
        u = mac.finalize().into_bytes();
        for (o, b) in out.iter_mut().zip(u.iter()) {
            *o ^= b;
        }
    }
    out
}

impl Domain {
    fn mx_seal(&self, table: &str, key: &str, plaintext: &[u8]) -> String {
        self.master.seal(plaintext, &aad(table, key))
    }

    fn mx_open(&self, table: &str, key: &str, sealed: &str) -> Result<Vec<u8>, Error> {
        self.master.open(sealed, &aad(table, key))
    }

    // ---- accounts -------------------------------------------------------------------------------------------------

    pub async fn crypto_account_active(&self, user_id: &str) -> Result<Option<AccountRow>, Error> {
        let row = sqlx::query("SELECT * FROM matrix_crypto_accounts WHERE user_id = ? AND status = 'active' ORDER BY generation DESC LIMIT 1")
            .bind(user_id)
            .fetch_optional(self.db.pool())
            .await
            .db()?;
        row.map(|r| {
            let device_id = scol(&r, "device_id");
            let pickle = self.mx_open("account", &format!("{user_id}|{device_id}"), &scol(&r, "sealed_pickle"))?;
            Ok(AccountRow { user_id: scol(&r, "user_id"), device_id, generation: icol(&r, "generation"), pickle })
        })
        .transpose()
    }

    pub async fn crypto_account_put(&self, a: &AccountRow) -> Result<(), Error> {
        let sealed = self.mx_seal("account", &format!("{}|{}", a.user_id, a.device_id), &a.pickle);
        sqlx::query(
            "INSERT INTO matrix_crypto_accounts(user_id, device_id, generation, sealed_pickle, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)
             ON CONFLICT(user_id, device_id) DO UPDATE SET sealed_pickle = excluded.sealed_pickle",
        )
        .bind(&a.user_id)
        .bind(&a.device_id)
        .bind(a.generation)
        .bind(sealed)
        .bind(self.now_ts())
        .execute(self.db.writer())
        .await
        .db()?;
        Ok(())
    }

    pub async fn crypto_account_retire(&self, user_id: &str, device_id: &str) -> Result<(), Error> {
        sqlx::query("UPDATE matrix_crypto_accounts SET status = 'retired', retired_at = ? WHERE user_id = ? AND device_id = ?")
            .bind(self.now_ts())
            .bind(user_id)
            .bind(device_id)
            .execute(self.db.writer())
            .await
            .db()?;
        Ok(())
    }

    // ---- olm sessions ---------------------------------------------------------------------------------------------

    pub async fn crypto_olm_for(&self, user_id: &str, device_id: &str, peer_curve25519: &str) -> Result<Vec<OlmRow>, Error> {
        let rows = sqlx::query("SELECT * FROM matrix_olm_sessions WHERE user_id = ? AND device_id = ? AND peer_curve25519 = ? ORDER BY last_used_at DESC")
            .bind(user_id)
            .bind(device_id)
            .bind(peer_curve25519)
            .fetch_all(self.db.pool())
            .await
            .db()?;
        rows.iter()
            .map(|r| {
                let session_id = scol(r, "session_id");
                Ok(OlmRow {
                    pickle: self.mx_open("olm", &session_id, &scol(r, "sealed_pickle"))?,
                    session_id,
                    user_id: scol(r, "user_id"),
                    device_id: scol(r, "device_id"),
                    peer_user: scol(r, "peer_user"),
                    peer_device: scol(r, "peer_device"),
                    peer_curve25519: scol(r, "peer_curve25519"),
                })
            })
            .collect()
    }

    pub async fn crypto_olm_put(&self, s: &OlmRow) -> Result<(), Error> {
        let now = self.now_ts();
        sqlx::query(
            "INSERT INTO matrix_olm_sessions(session_id, user_id, device_id, peer_user, peer_device, peer_curve25519, sealed_pickle, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET sealed_pickle = excluded.sealed_pickle, last_used_at = excluded.last_used_at",
        )
        .bind(&s.session_id)
        .bind(&s.user_id)
        .bind(&s.device_id)
        .bind(&s.peer_user)
        .bind(&s.peer_device)
        .bind(&s.peer_curve25519)
        .bind(self.mx_seal("olm", &s.session_id, &s.pickle))
        .bind(&now)
        .bind(&now)
        .execute(self.db.writer())
        .await
        .db()?;
        Ok(())
    }

    // ---- megolm ---------------------------------------------------------------------------------------------------

    pub async fn crypto_out_active(&self, user_id: &str, device_id: &str, room_id: &str) -> Result<Option<OutboundRow>, Error> {
        let row = sqlx::query(
            "SELECT * FROM matrix_megolm_outbound WHERE user_id = ? AND device_id = ? AND room_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
        )
        .bind(user_id)
        .bind(device_id)
        .bind(room_id)
        .fetch_optional(self.db.pool())
        .await
        .db()?;
        row.map(|r| self.outbound_from_row(&r)).transpose()
    }

    fn outbound_from_row(&self, r: &sqlx::sqlite::SqliteRow) -> Result<OutboundRow, Error> {
        let session_id = scol(r, "session_id");
        Ok(OutboundRow {
            pickle: self.mx_open("megolm_out", &session_id, &scol(r, "sealed_pickle"))?,
            user_id: scol(r, "user_id"),
            device_id: scol(r, "device_id"),
            room_id: scol(r, "room_id"),
            message_count: icol(r, "message_count"),
            shared_with: serde_json::from_str(&scol(r, "shared_with")).unwrap_or_default(),
            created_at: scol(r, "created_at"),
            session_id,
        })
    }

    pub async fn crypto_out_put(&self, s: &OutboundRow) -> Result<(), Error> {
        sqlx::query(
            "INSERT INTO matrix_megolm_outbound(session_id, user_id, device_id, room_id, sealed_pickle, message_count, shared_with, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
             ON CONFLICT(session_id) DO UPDATE SET sealed_pickle = excluded.sealed_pickle, message_count = excluded.message_count, shared_with = excluded.shared_with",
        )
        .bind(&s.session_id)
        .bind(&s.user_id)
        .bind(&s.device_id)
        .bind(&s.room_id)
        .bind(self.mx_seal("megolm_out", &s.session_id, &s.pickle))
        .bind(s.message_count)
        .bind(serde_json::to_string(&s.shared_with)?)
        .bind(&s.created_at)
        .execute(self.db.writer())
        .await
        .db()?;
        Ok(())
    }

    pub async fn crypto_out_retire(&self, session_id: &str, reason: &str) -> Result<(), Error> {
        sqlx::query("UPDATE matrix_megolm_outbound SET status = 'retired', rotated_reason = ? WHERE session_id = ?")
            .bind(reason)
            .bind(session_id)
            .execute(self.db.writer())
            .await
            .db()?;
        Ok(())
    }

    pub async fn crypto_in_get(&self, room_id: &str, session_id: &str) -> Result<Option<InboundRow>, Error> {
        let row = sqlx::query("SELECT * FROM matrix_megolm_inbound WHERE room_id = ? AND session_id = ?")
            .bind(room_id)
            .bind(session_id)
            .fetch_optional(self.db.pool())
            .await
            .db()?;
        row.map(|r| {
            Ok(InboundRow {
                pickle: self.mx_open("megolm_in", &format!("{room_id}|{session_id}"), &scol(&r, "sealed_pickle"))?,
                room_id: scol(&r, "room_id"),
                session_id: scol(&r, "session_id"),
                user_id: scol(&r, "user_id"),
                sender_key: scol(&r, "sender_key"),
                sender_user: scol(&r, "sender_user"),
                sender_device: scol(&r, "sender_device"),
                first_known_index: icol(&r, "first_known_index"),
            })
        })
        .transpose()
    }

    /// Stores an inbound session unless one already exists for `(room, session)`; returns whether it was new.
    pub async fn crypto_in_put(&self, s: &InboundRow) -> Result<bool, Error> {
        let res = sqlx::query(
            "INSERT OR IGNORE INTO matrix_megolm_inbound(room_id, session_id, user_id, sender_key, sender_user, sender_device, sealed_pickle, first_known_index, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&s.room_id)
        .bind(&s.session_id)
        .bind(&s.user_id)
        .bind(&s.sender_key)
        .bind(&s.sender_user)
        .bind(&s.sender_device)
        .bind(self.mx_seal("megolm_in", &format!("{}|{}", s.room_id, s.session_id), &s.pickle))
        .bind(s.first_known_index)
        .bind(self.now_ts())
        .execute(self.db.writer())
        .await
        .db()?;
        Ok(res.rows_affected() == 1)
    }

    /// Records `(session, message index) -> event id`. `false` means the index was already used by a *different*
    /// event: a replayed or forged ciphertext.
    pub async fn crypto_replay_record(&self, room_id: &str, session_id: &str, index: i64, event_id: &str) -> Result<bool, Error> {
        let res = sqlx::query("INSERT OR IGNORE INTO matrix_megolm_replay(room_id, session_id, message_index, event_id) VALUES (?, ?, ?, ?)")
            .bind(room_id)
            .bind(session_id)
            .bind(index)
            .bind(event_id)
            .execute(self.db.writer())
            .await
            .db()?;
        if res.rows_affected() == 1 {
            return Ok(true);
        }
        let existing: String = sqlx::query_scalar("SELECT event_id FROM matrix_megolm_replay WHERE room_id = ? AND session_id = ? AND message_index = ?")
            .bind(room_id)
            .bind(session_id)
            .bind(index)
            .fetch_one(self.db.pool())
            .await
            .db()?;
        Ok(existing == event_id)
    }

    // ---- device keys ----------------------------------------------------------------------------------------------

    pub async fn crypto_devices_of(&self, user_id: &str) -> Result<Vec<DeviceKeyRow>, Error> {
        let rows = sqlx::query("SELECT * FROM matrix_device_keys WHERE user_id = ? ORDER BY device_id").bind(user_id).fetch_all(self.db.pool()).await.db()?;
        Ok(rows
            .iter()
            .map(|r| DeviceKeyRow {
                user_id: scol(r, "user_id"),
                device_id: scol(r, "device_id"),
                curve25519: scol(r, "curve25519"),
                ed25519: scol(r, "ed25519"),
                deleted: icol(r, "deleted") != 0,
            })
            .collect())
    }

    pub async fn crypto_device_put(&self, d: &DeviceKeyRow) -> Result<(), Error> {
        sqlx::query(
            "INSERT INTO matrix_device_keys(user_id, device_id, curve25519, ed25519, deleted, fetched_at) VALUES (?, ?, ?, ?, 0, ?)
             ON CONFLICT(user_id, device_id) DO UPDATE SET fetched_at = excluded.fetched_at, deleted = 0",
        )
        .bind(&d.user_id)
        .bind(&d.device_id)
        .bind(&d.curve25519)
        .bind(&d.ed25519)
        .bind(self.now_ts())
        .execute(self.db.writer())
        .await
        .db()?;
        Ok(())
    }

    /// Devices of `user_id` that are no longer reported by the homeserver stop receiving keys.
    pub async fn crypto_devices_prune(&self, user_id: &str, keep: &[String]) -> Result<(), Error> {
        for d in self.crypto_devices_of(user_id).await? {
            if !keep.contains(&d.device_id) {
                sqlx::query("UPDATE matrix_device_keys SET deleted = 1 WHERE user_id = ? AND device_id = ?")
                    .bind(user_id)
                    .bind(&d.device_id)
                    .execute(self.db.writer())
                    .await
                    .db()?;
            }
        }
        Ok(())
    }

    // ---- pending events -------------------------------------------------------------------------------------------

    pub async fn crypto_pending_put(&self, event_id: &str, room_id: &str, session_id: &str, event: &Value) -> Result<(), Error> {
        sqlx::query("INSERT OR IGNORE INTO matrix_crypto_pending(event_id, room_id, session_id, event, created_at) VALUES (?, ?, ?, ?, ?)")
            .bind(event_id)
            .bind(room_id)
            .bind(session_id)
            .bind(event.to_string())
            .bind(self.now_ts())
            .execute(self.db.writer())
            .await
            .db()?;
        Ok(())
    }

    pub async fn crypto_pending_take(&self, room_id: &str, session_id: &str) -> Result<Vec<Value>, Error> {
        let rows = sqlx::query("SELECT event_id, event FROM matrix_crypto_pending WHERE room_id = ? AND session_id = ? ORDER BY created_at")
            .bind(room_id)
            .bind(session_id)
            .fetch_all(self.db.pool())
            .await
            .db()?;
        let mut out = vec![];
        for r in &rows {
            out.push(serde_json::from_str(&scol(r, "event"))?);
            sqlx::query("DELETE FROM matrix_crypto_pending WHERE event_id = ?").bind(scol(r, "event_id")).execute(self.db.writer()).await.db()?;
        }
        Ok(out)
    }

    pub async fn crypto_pending_count(&self) -> Result<i64, Error> {
        sqlx::query_scalar("SELECT COUNT(*) FROM matrix_crypto_pending").fetch_one(self.db.pool()).await.db()
    }

    /// Drops all crypto state (loss drill / explicit reset); the bridge then starts a brand-new device.
    pub async fn crypto_wipe(&self) -> Result<(), Error> {
        for table in [
            "matrix_crypto_accounts",
            "matrix_olm_sessions",
            "matrix_megolm_outbound",
            "matrix_megolm_inbound",
            "matrix_megolm_replay",
            "matrix_device_keys",
            "matrix_crypto_pending",
            "matrix_crypto_selftest",
        ] {
            sqlx::query(sqlx::AssertSqlSafe(format!("DELETE FROM {table}"))).execute(self.db.writer()).await.db()?;
        }
        Ok(())
    }

    // ---- self test & verification -----------------------------------------------------------------------------------

    /// Creates the stored Megolm test vector if missing.
    pub async fn ensure_crypto_selftest(&self) -> Result<(), Error> {
        let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM matrix_crypto_selftest WHERE id = 1").fetch_optional(self.db.pool()).await.db()?;
        if exists.is_some() {
            return Ok(());
        }
        let mut outbound = GroupSession::new(SessionConfig::version_1());
        let inbound = InboundGroupSession::new(&outbound.session_key(), SessionConfig::version_1());
        let vector = json!({"inbound": serde_json::to_value(inbound.pickle())?, "ciphertext": outbound.encrypt(SELFTEST_PLAINTEXT).to_base64()});
        sqlx::query("INSERT OR IGNORE INTO matrix_crypto_selftest(id, sealed_vector, created_at) VALUES (1, ?, ?)")
            .bind(self.mx_seal("selftest", "1", vector.to_string().as_bytes()))
            .bind(self.now_ts())
            .execute(self.db.writer())
            .await
            .db()?;
        Ok(())
    }

    /// Opens every sealed secret with the master key (proving the key material is recoverable) and decrypts the stored
    /// Megolm test vector. Used by restore verification and by operators after key rotation.
    pub async fn verify_matrix_crypto(&self) -> Result<CryptoVerifyReport, Error> {
        let mut report = CryptoVerifyReport::default();
        for r in sqlx::query("SELECT user_id, device_id, sealed_pickle FROM matrix_crypto_accounts").fetch_all(self.db.pool()).await.db()? {
            self.mx_open("account", &format!("{}|{}", scol(&r, "user_id"), scol(&r, "device_id")), &scol(&r, "sealed_pickle"))?;
            report.accounts += 1;
        }
        for r in sqlx::query("SELECT session_id, sealed_pickle FROM matrix_olm_sessions").fetch_all(self.db.pool()).await.db()? {
            self.mx_open("olm", &scol(&r, "session_id"), &scol(&r, "sealed_pickle"))?;
            report.olm_sessions += 1;
        }
        for r in sqlx::query("SELECT session_id, sealed_pickle FROM matrix_megolm_outbound").fetch_all(self.db.pool()).await.db()? {
            self.mx_open("megolm_out", &scol(&r, "session_id"), &scol(&r, "sealed_pickle"))?;
            report.megolm_outbound += 1;
        }
        for r in sqlx::query("SELECT room_id, session_id, sealed_pickle FROM matrix_megolm_inbound").fetch_all(self.db.pool()).await.db()? {
            self.mx_open("megolm_in", &format!("{}|{}", scol(&r, "room_id"), scol(&r, "session_id")), &scol(&r, "sealed_pickle"))?;
            report.megolm_inbound += 1;
        }
        let vector: Option<String> =
            sqlx::query_scalar("SELECT sealed_vector FROM matrix_crypto_selftest WHERE id = 1").fetch_optional(self.db.pool()).await.db()?;
        if let Some(sealed) = vector {
            let v: Value = serde_json::from_slice(&self.mx_open("selftest", "1", &sealed)?)?;
            let pickle: InboundGroupSessionPickle = serde_json::from_value(v["inbound"].clone())?;
            let mut inbound = InboundGroupSession::from_pickle(pickle);
            let message = MegolmMessage::from_base64(v["ciphertext"].as_str().unwrap_or_default())
                .map_err(|e| Error::internal(format!("stored test vector is malformed: {e}")))?;
            let decrypted = inbound.decrypt(&message).map_err(|e| Error::internal(format!("stored Megolm test vector no longer decrypts: {e}")))?;
            if decrypted.plaintext != SELFTEST_PLAINTEXT.as_bytes() {
                return Err(Error::internal("stored Megolm test vector decrypted to unexpected plaintext"));
            }
            report.selftest_vector_ok = true;
        }
        Ok(report)
    }

    // ---- recovery bundle ----------------------------------------------------------------------------------------------

    /// Exports every crypto table as one passphrase-wrapped bundle (PBKDF2-HMAC-SHA256 -> AES-256-GCM). The bundle is
    /// independent of the domain master key, so it can restore a bridge onto a fresh deployment.
    pub async fn export_matrix_crypto(&self, passphrase: &str, iterations: u32) -> Result<String, Error> {
        if passphrase.len() < 12 {
            return Err(Error::invalid("the recovery passphrase must be at least 12 characters"));
        }
        let b64 = |b: &[u8]| jws::b64(b);
        let mut accounts = vec![];
        for r in sqlx::query("SELECT * FROM matrix_crypto_accounts").fetch_all(self.db.pool()).await.db()? {
            let (u, d) = (scol(&r, "user_id"), scol(&r, "device_id"));
            let pickle = self.mx_open("account", &format!("{u}|{d}"), &scol(&r, "sealed_pickle"))?;
            accounts.push(json!({"userId": u, "deviceId": d, "generation": icol(&r, "generation"), "status": scol(&r, "status"), "createdAt": scol(&r, "created_at"), "retiredAt": scol_opt(&r, "retired_at"), "pickle": b64(&pickle)}));
        }
        let mut olm = vec![];
        for r in sqlx::query("SELECT * FROM matrix_olm_sessions").fetch_all(self.db.pool()).await.db()? {
            let id = scol(&r, "session_id");
            let pickle = self.mx_open("olm", &id, &scol(&r, "sealed_pickle"))?;
            olm.push(json!({"sessionId": id, "userId": scol(&r, "user_id"), "deviceId": scol(&r, "device_id"), "peerUser": scol(&r, "peer_user"), "peerDevice": scol(&r, "peer_device"), "peerCurve25519": scol(&r, "peer_curve25519"), "pickle": b64(&pickle)}));
        }
        let mut outbound = vec![];
        for r in sqlx::query("SELECT * FROM matrix_megolm_outbound").fetch_all(self.db.pool()).await.db()? {
            let o = self.outbound_from_row(&r)?;
            outbound.push(json!({"sessionId": o.session_id, "userId": o.user_id, "deviceId": o.device_id, "roomId": o.room_id, "pickle": b64(&o.pickle), "messageCount": o.message_count, "sharedWith": o.shared_with, "status": scol(&r, "status"), "createdAt": o.created_at}));
        }
        let mut inbound = vec![];
        for r in sqlx::query("SELECT * FROM matrix_megolm_inbound").fetch_all(self.db.pool()).await.db()? {
            let (room, sid) = (scol(&r, "room_id"), scol(&r, "session_id"));
            let pickle = self.mx_open("megolm_in", &format!("{room}|{sid}"), &scol(&r, "sealed_pickle"))?;
            inbound.push(json!({"roomId": room, "sessionId": sid, "userId": scol(&r, "user_id"), "senderKey": scol(&r, "sender_key"), "senderUser": scol(&r, "sender_user"), "senderDevice": scol(&r, "sender_device"), "firstKnownIndex": icol(&r, "first_known_index"), "pickle": b64(&pickle)}));
        }
        let replay: Vec<Value> = sqlx::query("SELECT * FROM matrix_megolm_replay").fetch_all(self.db.pool()).await.db()?.iter().map(|r| json!({"roomId": scol(r, "room_id"), "sessionId": scol(r, "session_id"), "index": icol(r, "message_index"), "eventId": scol(r, "event_id")})).collect();
        let devices: Vec<Value> = sqlx::query("SELECT * FROM matrix_device_keys").fetch_all(self.db.pool()).await.db()?.iter().map(|r| json!({"userId": scol(r, "user_id"), "deviceId": scol(r, "device_id"), "curve25519": scol(r, "curve25519"), "ed25519": scol(r, "ed25519"), "deleted": icol(r, "deleted")})).collect();
        let payload = json!({"version": 1, "domainId": self.cfg.domain_id, "exportedAt": self.now_ts(), "accounts": accounts, "olmSessions": olm, "megolmOutbound": outbound, "megolmInbound": inbound, "replay": replay, "deviceKeys": devices});

        let salt: [u8; 16] = rand::random();
        let nonce: [u8; 12] = rand::random();
        let key = pbkdf2_sha256(passphrase.as_bytes(), &salt, iterations.max(1));
        let cipher = Aes256Gcm::new((&key).into());
        let ciphertext = cipher
            .encrypt(
                &Nonce::try_from(nonce.as_slice()).expect("12 byte nonce"),
                aes_gcm::aead::Payload { msg: payload.to_string().as_bytes(), aad: b"somework-matrix-crypto-bundle-v1" },
            )
            .map_err(|_| Error::internal("bundle encryption failed"))?;
        Ok(json!({"format": "somework-matrix-crypto-bundle", "v": 1, "kdf": "pbkdf2-hmac-sha256", "iterations": iterations.max(1), "salt": jws::b64(&salt), "nonce": jws::b64(&nonce), "ciphertext": jws::b64(&ciphertext)}).to_string())
    }

    /// Imports a bundle produced by [`Domain::export_matrix_crypto`], replacing the current crypto state, and
    /// re-seals everything with this deployment's master key.
    pub async fn import_matrix_crypto(&self, bundle: &str, passphrase: &str) -> Result<CryptoImportReport, Error> {
        let envelope: Value = serde_json::from_str(bundle).map_err(|_| Error::invalid("the recovery bundle is not valid JSON"))?;
        if envelope["format"] != "somework-matrix-crypto-bundle" || envelope["v"] != 1 {
            return Err(Error::invalid("unrecognized recovery bundle format"));
        }
        let field =
            |name: &str| jws::unb64(envelope[name].as_str().unwrap_or_default()).map_err(|_| Error::invalid(format!("bundle field {name} is malformed")));
        let (salt, nonce, ciphertext) = (field("salt")?, field("nonce")?, field("ciphertext")?);
        let iterations = envelope["iterations"].as_u64().unwrap_or(0) as u32;
        if !(1..=10_000_000).contains(&iterations) || nonce.len() != 12 {
            return Err(Error::invalid("bundle parameters are out of range"));
        }
        let key = pbkdf2_sha256(passphrase.as_bytes(), &salt, iterations);
        let plaintext = Aes256Gcm::new((&key).into())
            .decrypt(
                &Nonce::try_from(nonce.as_slice()).expect("12 byte nonce"),
                aes_gcm::aead::Payload { msg: &ciphertext, aad: b"somework-matrix-crypto-bundle-v1" },
            )
            .map_err(|_| Error::new(ErrorCode::Unauthenticated, "wrong passphrase or corrupted recovery bundle"))?;
        let p: Value = serde_json::from_slice(&plaintext)?;
        let unb = |v: &Value| jws::unb64(v.as_str().unwrap_or_default()).map_err(|_| Error::invalid("bundle contains a malformed secret"));

        self.crypto_wipe().await?;
        let mut report = CryptoImportReport::default();
        for a in p["accounts"].as_array().cloned().unwrap_or_default() {
            let row = AccountRow {
                user_id: a["userId"].as_str().unwrap_or_default().into(),
                device_id: a["deviceId"].as_str().unwrap_or_default().into(),
                generation: a["generation"].as_i64().unwrap_or(1),
                pickle: unb(&a["pickle"])?,
            };
            self.crypto_account_put(&row).await?;
            if a["status"] == "retired" {
                self.crypto_account_retire(&row.user_id, &row.device_id).await?;
            }
            report.accounts += 1;
        }
        for s in p["olmSessions"].as_array().cloned().unwrap_or_default() {
            self.crypto_olm_put(&OlmRow {
                session_id: s["sessionId"].as_str().unwrap_or_default().into(),
                user_id: s["userId"].as_str().unwrap_or_default().into(),
                device_id: s["deviceId"].as_str().unwrap_or_default().into(),
                peer_user: s["peerUser"].as_str().unwrap_or_default().into(),
                peer_device: s["peerDevice"].as_str().unwrap_or_default().into(),
                peer_curve25519: s["peerCurve25519"].as_str().unwrap_or_default().into(),
                pickle: unb(&s["pickle"])?,
            })
            .await?;
            report.olm_sessions += 1;
        }
        for o in p["megolmOutbound"].as_array().cloned().unwrap_or_default() {
            let row = OutboundRow {
                session_id: o["sessionId"].as_str().unwrap_or_default().into(),
                user_id: o["userId"].as_str().unwrap_or_default().into(),
                device_id: o["deviceId"].as_str().unwrap_or_default().into(),
                room_id: o["roomId"].as_str().unwrap_or_default().into(),
                pickle: unb(&o["pickle"])?,
                message_count: o["messageCount"].as_i64().unwrap_or(0),
                shared_with: serde_json::from_value(o["sharedWith"].clone()).unwrap_or_default(),
                created_at: o["createdAt"].as_str().unwrap_or_default().into(),
            };
            self.crypto_out_put(&row).await?;
            if o["status"] == "retired" {
                self.crypto_out_retire(&row.session_id, "imported").await?;
            }
            report.megolm_outbound += 1;
        }
        for i in p["megolmInbound"].as_array().cloned().unwrap_or_default() {
            self.crypto_in_put(&InboundRow {
                room_id: i["roomId"].as_str().unwrap_or_default().into(),
                session_id: i["sessionId"].as_str().unwrap_or_default().into(),
                user_id: i["userId"].as_str().unwrap_or_default().into(),
                sender_key: i["senderKey"].as_str().unwrap_or_default().into(),
                sender_user: i["senderUser"].as_str().unwrap_or_default().into(),
                sender_device: i["senderDevice"].as_str().unwrap_or_default().into(),
                first_known_index: i["firstKnownIndex"].as_i64().unwrap_or(0),
                pickle: unb(&i["pickle"])?,
            })
            .await?;
            report.megolm_inbound += 1;
        }
        for r in p["replay"].as_array().cloned().unwrap_or_default() {
            self.crypto_replay_record(
                r["roomId"].as_str().unwrap_or_default(),
                r["sessionId"].as_str().unwrap_or_default(),
                r["index"].as_i64().unwrap_or(0),
                r["eventId"].as_str().unwrap_or_default(),
            )
            .await?;
            report.replay_entries += 1;
        }
        for d in p["deviceKeys"].as_array().cloned().unwrap_or_default() {
            self.crypto_device_put(&DeviceKeyRow {
                user_id: d["userId"].as_str().unwrap_or_default().into(),
                device_id: d["deviceId"].as_str().unwrap_or_default().into(),
                curve25519: d["curve25519"].as_str().unwrap_or_default().into(),
                ed25519: d["ed25519"].as_str().unwrap_or_default().into(),
                deleted: false,
            })
            .await?;
            report.device_keys += 1;
        }
        self.ensure_crypto_selftest().await?;
        Ok(report)
    }

    pub async fn crypto_table_counts(&self) -> Result<Vec<(String, i64)>, Error> {
        let mut out = vec![];
        for table in
            ["matrix_crypto_accounts", "matrix_olm_sessions", "matrix_megolm_outbound", "matrix_megolm_inbound", "matrix_megolm_replay", "matrix_device_keys"]
        {
            let n: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}"))).fetch_one(self.db.pool()).await.db()?;
            out.push((table.to_string(), n));
        }
        Ok(out)
    }
}
