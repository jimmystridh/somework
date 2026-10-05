//! End-to-end encryption for the `encrypted_with_observer` profile: the bridge owns real Matrix devices
//! (Olm accounts), shares Megolm room keys to the devices of room members, encrypts its projections and — because
//! the observer device is a member of the room — decrypts the human messages that were shared with it.
//!
//! Security properties enforced here: (1) every secret is sealed at rest by the domain store, (2) inbound room keys
//! are accepted only from Olm sessions whose sender device is verified through a self-signed `keys/query` entry,
//! (3) a Megolm ciphertext must come from the device that issued the session (`sender_key` check) and from a device
//! belonging to the event's sender, (4) message indexes are replay-protected, (5) outbound sessions rotate on
//! membership/device removal, message count and age, (6) nothing falls back to plaintext on failure.

use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use serde_json::{Value, json};
use somework_core::{Error, ErrorCode, canonical::canonical_json, clock::ts};
use somework_domain::{
    Domain,
    matrix_crypto::{AccountRow, DeviceKeyRow, InboundRow, OlmRow, OutboundRow},
};
use vodozemac::{
    Curve25519PublicKey, Ed25519PublicKey, Ed25519Signature,
    megolm::{GroupSession, InboundGroupSession, InboundGroupSessionPickle, MegolmMessage, SessionConfig as MegolmConfig, SessionKey},
    olm::{Account, OlmMessage, Session, SessionConfig as OlmConfig, SessionPickle},
};

use crate::{bridge::map_matrix_error, client::MatrixClient, config::MatrixConfig};

pub const ALG_OLM: &str = "m.olm.v1.curve25519-aes-sha2";
pub const ALG_MEGOLM: &str = "m.megolm.v1.aes-sha2";
const OTK_TARGET: usize = 50;
const OTK_MIN: u64 = 25;

#[derive(Debug, Clone)]
pub struct CryptoLimits {
    pub max_messages: i64,
    pub max_age: Duration,
    pub device_cache: Duration,
}

impl Default for CryptoLimits {
    fn default() -> Self {
        Self { max_messages: 100, max_age: Duration::from_secs(7 * 24 * 3600), device_cache: Duration::from_secs(10) }
    }
}

#[derive(Debug, Clone)]
pub struct Decrypted {
    pub event_type: String,
    pub content: Value,
    pub sender_device: String,
}

#[derive(Debug, Clone)]
pub enum DecryptError {
    /// The room key has not arrived (yet); the event is parked until it does.
    UnknownSession(String),
    /// Authentication failure: forged sender key, replayed index, wrong room, malformed payload.
    Rejected(String),
    Failed(String),
}

impl std::fmt::Display for DecryptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DecryptError::UnknownSession(s) => write!(f, "unknown megolm session {s}"),
            DecryptError::Rejected(m) => write!(f, "rejected: {m}"),
            DecryptError::Failed(m) => write!(f, "decryption failed: {m}"),
        }
    }
}

struct Loaded {
    device_id: String,
    generation: i64,
    account: Account,
    uploaded: bool,
}

#[derive(Default)]
struct State {
    accounts: HashMap<String, Loaded>,
    fetched: HashMap<String, Instant>,
    txn: u64,
}

pub struct CryptoManager {
    domain: Domain,
    client: MatrixClient,
    cfg: MatrixConfig,
    limits: CryptoLimits,
    state: tokio::sync::Mutex<State>,
}

fn io<E: std::fmt::Display>(what: &str) -> impl FnOnce(E) -> Error + '_ {
    move |e| Error::internal(format!("{what}: {e}"))
}

fn sign_object(account: &Account, user_id: &str, device_id: &str, object: &Value) -> Value {
    let signature = account.sign(canonical_json(object).as_bytes());
    json!({user_id: {format!("ed25519:{device_id}"): signature.to_base64()}})
}

impl CryptoManager {
    pub fn new(domain: Domain, client: MatrixClient, cfg: MatrixConfig) -> Self {
        let limits = CryptoLimits {
            max_messages: cfg.crypto.max_messages,
            max_age: Duration::from_secs(cfg.crypto.max_age_secs),
            device_cache: Duration::from_millis(cfg.crypto.device_cache_ms),
        };
        Self { domain, client, cfg, limits, state: tokio::sync::Mutex::new(State::default()) }
    }

    pub fn observer_user(&self) -> String {
        self.cfg.bot_user_id()
    }

    fn own_namespace(&self, user: &str) -> bool {
        self.cfg.is_virtual_user(user) || self.cfg.is_bot(user)
    }

    // ---- accounts -----------------------------------------------------------------------------------------------------

    async fn ensure_loaded(&self, st: &mut State, user_id: &str) -> Result<(), Error> {
        if st.accounts.contains_key(user_id) {
            return Ok(());
        }
        let loaded = match self.domain.crypto_account_active(user_id).await? {
            Some(row) => {
                let pickle = serde_json::from_slice(&row.pickle).map_err(io("account pickle"))?;
                Loaded { device_id: row.device_id, generation: row.generation, account: Account::from_pickle(pickle), uploaded: true }
            }
            None => {
                let generation = 1;
                let device_id = format!("SW{}", hex::encode(rand_bytes::<5>()).to_uppercase());
                let mut l = Loaded { device_id, generation, account: Account::new(), uploaded: false };
                self.persist_account(user_id, &l).await?;
                self.publish_keys(user_id, &mut l).await?;
                self.domain.ensure_crypto_selftest().await?;
                st.accounts.insert(user_id.to_string(), l);
                self.delete_stale_devices(user_id, st).await;
                return Ok(());
            }
        };
        st.accounts.insert(user_id.to_string(), loaded);
        Ok(())
    }

    async fn persist_account(&self, user_id: &str, l: &Loaded) -> Result<(), Error> {
        let pickle = serde_json::to_vec(&l.account.pickle()).map_err(io("serialize account"))?;
        self.domain.crypto_account_put(&AccountRow { user_id: user_id.to_string(), device_id: l.device_id.clone(), generation: l.generation, pickle }).await
    }

    /// Uploads device keys (first time), one-time keys and a fallback key, signed by the device.
    async fn publish_keys(&self, user_id: &str, l: &mut Loaded) -> Result<(), Error> {
        let ids = l.account.identity_keys();
        let (curve, ed) = (ids.curve25519.to_base64(), ids.ed25519.to_base64());
        let mut body = json!({});
        if !l.uploaded {
            let mut device_keys = json!({
                "user_id": user_id,
                "device_id": l.device_id,
                "algorithms": [ALG_OLM, ALG_MEGOLM],
                "keys": {format!("curve25519:{}", l.device_id): curve, format!("ed25519:{}", l.device_id): ed},
            });
            device_keys["signatures"] = sign_object(&l.account, user_id, &l.device_id, &device_keys);
            body["device_keys"] = device_keys;
        }
        l.account.generate_one_time_keys(OTK_TARGET);
        let mut otks = serde_json::Map::new();
        for (id, key) in l.account.one_time_keys() {
            let mut k = json!({"key": key.to_base64()});
            k["signatures"] = sign_object(&l.account, user_id, &l.device_id, &k);
            otks.insert(format!("signed_curve25519:{}", id.to_base64()), k);
        }
        body["one_time_keys"] = Value::Object(otks);
        if !l.uploaded {
            l.account.generate_fallback_key();
            let mut fallbacks = serde_json::Map::new();
            for (id, key) in l.account.fallback_key() {
                let mut k = json!({"key": key.to_base64(), "fallback": true});
                k["signatures"] = sign_object(&l.account, user_id, &l.device_id, &k);
                fallbacks.insert(format!("signed_curve25519:{}", id.to_base64()), k);
            }
            body["fallback_keys"] = Value::Object(fallbacks);
        }
        self.client.keys_upload(user_id, &l.device_id, body).await.map_err(map_matrix_error)?;
        l.account.mark_keys_as_published();
        l.uploaded = true;
        self.persist_account(user_id, l).await
    }

    /// A brand-new account means any earlier device of this user (lost state) is stale: remove it from the homeserver so
    /// members stop sharing room keys with a device nobody can use any more.
    async fn delete_stale_devices(&self, user_id: &str, st: &mut State) {
        let ours = st.accounts.get(user_id).map(|l| l.device_id.clone()).unwrap_or_default();
        // queried but deliberately not cached: our own identity keys are only ever stored sealed
        let Ok(resp) = self.client.keys_query(user_id, &[user_id.to_string()]).await else { return };
        let stale: Vec<String> =
            resp["device_keys"][user_id].as_object().map(|o| o.keys().filter(|d| **d != ours && d.starts_with("SW")).cloned().collect()).unwrap_or_default();
        if !stale.is_empty()
            && let Err(e) = self.client.delete_devices(user_id, &stale).await
        {
            tracing::warn!(error = %e, "could not delete stale bridge devices");
        }
    }

    /// Makes sure `user_id` has a published device; returns `(device_id, curve25519, ed25519)`.
    pub async fn ensure_device(&self, user_id: &str) -> Result<(String, String, String), Error> {
        let mut st = self.state.lock().await;
        self.ensure_loaded(&mut st, user_id).await?;
        let l = &st.accounts[user_id];
        let ids = l.account.identity_keys();
        Ok((l.device_id.clone(), ids.curve25519.to_base64(), ids.ed25519.to_base64()))
    }

    /// Replenishes one-time keys when the homeserver reports fewer than half the target.
    pub async fn handle_otk_counts(&self, counts: &Value) {
        let Some(users) = counts.as_object() else { return };
        let mut st = self.state.lock().await;
        for (user, devices) in users {
            let Some(l) = st.accounts.get_mut(user) else { continue };
            let Some(n) = devices.get(&l.device_id).and_then(|d| d.get("signed_curve25519")).and_then(Value::as_u64) else { continue };
            if n < OTK_MIN {
                let mut taken = std::mem::replace(l, Loaded { device_id: String::new(), generation: 0, account: Account::new(), uploaded: true });
                let outcome = self.publish_keys(user, &mut taken).await;
                *l = taken;
                if let Err(e) = outcome {
                    tracing::warn!(error = %e, "one-time key replenishment failed");
                }
            }
        }
    }

    // ---- device discovery -------------------------------------------------------------------------------------------------

    /// Drops cached device lists (homeserver `device_lists.changed`) so the next send re-queries them.
    pub async fn invalidate_devices(&self, users: &[String]) {
        let mut st = self.state.lock().await;
        for u in users {
            st.fetched.remove(u);
        }
    }

    async fn refresh_devices(&self, st: &mut State, as_user: &str, users: &[String], force: bool) -> Result<(), Error> {
        let stale: Vec<String> =
            users.iter().filter(|u| force || st.fetched.get(*u).is_none_or(|t| t.elapsed() >= self.limits.device_cache)).cloned().collect();
        if stale.is_empty() {
            return Ok(());
        }
        let resp = self.client.keys_query(as_user, &stale).await.map_err(map_matrix_error)?;
        for user in &stale {
            let mut keep = vec![];
            for (device_id, obj) in resp["device_keys"][user].as_object().cloned().unwrap_or_default() {
                match self.verify_device_keys(user, &device_id, &obj) {
                    Ok((curve, ed)) => {
                        let known = self.domain.crypto_devices_of(user).await?.into_iter().find(|d| d.device_id == device_id);
                        if let Some(k) = known
                            && (k.curve25519 != curve || k.ed25519 != ed)
                        {
                            tracing::warn!(user, device = %device_id, "device keys changed for an existing device id; refusing the new keys");
                            continue;
                        }
                        self.domain
                            .crypto_device_put(&DeviceKeyRow {
                                user_id: user.clone(),
                                device_id: device_id.clone(),
                                curve25519: curve,
                                ed25519: ed,
                                deleted: false,
                            })
                            .await?;
                        keep.push(device_id);
                    }
                    Err(reason) => tracing::warn!(user, device = %device_id, %reason, "ignoring device with invalid keys"),
                }
            }
            self.domain.crypto_devices_prune(user, &keep).await?;
            st.fetched.insert(user.clone(), Instant::now());
        }
        Ok(())
    }

    /// Verifies the device's self-signature over its canonical key object.
    fn verify_device_keys(&self, user: &str, device_id: &str, obj: &Value) -> Result<(String, String), String> {
        if obj["user_id"] != user || obj["device_id"] != device_id {
            return Err("user/device id mismatch".into());
        }
        let curve = obj["keys"][format!("curve25519:{device_id}")].as_str().ok_or("missing curve25519 key")?.to_string();
        let ed = obj["keys"][format!("ed25519:{device_id}")].as_str().ok_or("missing ed25519 key")?.to_string();
        Curve25519PublicKey::from_base64(&curve).map_err(|e| e.to_string())?;
        let signature = obj["signatures"][user][format!("ed25519:{device_id}")].as_str().ok_or("missing self-signature")?;
        let mut unsigned = obj.clone();
        if let Some(o) = unsigned.as_object_mut() {
            o.remove("signatures");
            o.remove("unsigned");
        }
        Ed25519PublicKey::from_base64(&ed)
            .map_err(|e| e.to_string())?
            .verify(canonical_json(&unsigned).as_bytes(), &Ed25519Signature::from_base64(signature).map_err(|e| e.to_string())?)
            .map_err(|_| "self-signature does not verify".to_string())?;
        Ok((curve, ed))
    }

    async fn devices_of(&self, user: &str) -> Result<Vec<DeviceKeyRow>, Error> {
        Ok(self.domain.crypto_devices_of(user).await?.into_iter().filter(|d| !d.deleted).collect())
    }

    // ---- outbound -----------------------------------------------------------------------------------------------------------

    /// Encrypts `content` as an `m.room.encrypted` event sent by `sender_user` into `room_id`, sharing the room key
    /// with every device of the joined members first. Returns the outer (wire) content.
    pub async fn encrypt_room_event(&self, sender_user: &str, room_id: &str, event_type: &str, content: &Value) -> Result<Value, Error> {
        let mut st = self.state.lock().await;
        self.ensure_loaded(&mut st, sender_user).await?;
        let (device_id, curve) = {
            let l = &st.accounts[sender_user];
            (l.device_id.clone(), l.account.identity_keys().curve25519.to_base64())
        };

        let members: Vec<String> =
            self.client.joined_members(room_id, sender_user).await.map_err(map_matrix_error)?.into_iter().filter(|u| !self.own_namespace(u)).collect();
        self.refresh_devices(&mut st, sender_user, &members, false).await?;
        let mut targets: Vec<DeviceKeyRow> = vec![];
        for m in &members {
            targets.extend(self.devices_of(m).await?);
        }
        let target_keys: Vec<String> = targets.iter().map(|d| format!("{}|{}", d.user_id, d.device_id)).collect();

        let now = self.domain.now();
        let mut row = self.domain.crypto_out_active(sender_user, &device_id, room_id).await?;
        if let Some(r) = &row {
            let removed = r.shared_with.iter().any(|d| !target_keys.contains(d));
            let age = somework_core::clock::parse_ts(&r.created_at).map(|c| (now - c).to_std().unwrap_or_default()).unwrap_or_default();
            let reason = if removed {
                Some("membership_or_device_removed")
            } else if r.message_count >= self.limits.max_messages {
                Some("message_limit")
            } else if age >= self.limits.max_age {
                Some("age_limit")
            } else {
                None
            };
            if let Some(reason) = reason {
                self.domain.crypto_out_retire(&r.session_id, reason).await?;
                row = None;
            }
        }
        let (mut group, mut row) = match row {
            Some(r) => (GroupSession::from_pickle(serde_json::from_slice(&r.pickle).map_err(io("group session pickle"))?), r),
            None => {
                let g = GroupSession::new(MegolmConfig::version_1());
                let r = OutboundRow {
                    session_id: g.session_id(),
                    user_id: sender_user.into(),
                    device_id: device_id.clone(),
                    room_id: room_id.into(),
                    pickle: vec![],
                    message_count: 0,
                    shared_with: vec![],
                    created_at: ts(now),
                };
                (g, r)
            }
        };

        let missing: Vec<DeviceKeyRow> = targets.into_iter().filter(|d| !row.shared_with.contains(&format!("{}|{}", d.user_id, d.device_id))).collect();
        if !missing.is_empty() {
            let shared = self.share_session(&mut st, sender_user, &device_id, room_id, &group, &missing).await?;
            row.shared_with.extend(shared);
        }

        let plaintext = canonical_json(&json!({"type": event_type, "content": content, "room_id": room_id}));
        let message = group.encrypt(plaintext.as_bytes());
        row.message_count += 1;
        row.pickle = serde_json::to_vec(&group.pickle()).map_err(io("serialize group session"))?;
        self.domain.crypto_out_put(&row).await?;

        let mut outer =
            json!({"algorithm": ALG_MEGOLM, "sender_key": curve, "device_id": device_id, "session_id": row.session_id, "ciphertext": message.to_base64()});
        if let Some(rel) = content.get("m.relates_to") {
            outer["m.relates_to"] = rel.clone();
        }
        Ok(outer)
    }

    /// Shares the group session key with `targets` over Olm (one `m.room_key` per device). Returns the `user|device`
    /// pairs that were reached; unreachable devices are simply retried on the next send.
    async fn share_session(
        &self,
        st: &mut State,
        sender_user: &str,
        sender_device: &str,
        room_id: &str,
        group: &GroupSession,
        targets: &[DeviceKeyRow],
    ) -> Result<Vec<String>, Error> {
        let (our_curve, our_ed) = {
            let ids = st.accounts[sender_user].account.identity_keys();
            (ids.curve25519.to_base64(), ids.ed25519.to_base64())
        };
        let session_key = group.session_key().to_base64();
        let mut shared = vec![];
        let mut messages = serde_json::Map::new();

        // devices without an Olm session need a claimed one-time key
        let mut need_claim = vec![];
        let mut existing: HashMap<String, (OlmRow, Session)> = HashMap::new();
        for t in targets {
            match self.domain.crypto_olm_for(sender_user, sender_device, &t.curve25519).await?.into_iter().next() {
                Some(row) => {
                    let session = Session::from_pickle(serde_json::from_slice::<SessionPickle>(&row.pickle).map_err(io("olm pickle"))?);
                    existing.insert(format!("{}|{}", t.user_id, t.device_id), (row, session));
                }
                None => need_claim.push((t.user_id.clone(), t.device_id.clone())),
            }
        }
        let claimed = if need_claim.is_empty() { Value::Null } else { self.client.keys_claim(sender_user, &need_claim).await.map_err(map_matrix_error)? };

        for t in targets {
            let key = format!("{}|{}", t.user_id, t.device_id);
            let (mut olm_row, mut session) = match existing.remove(&key) {
                Some(pair) => pair,
                None => {
                    let Some((otk, otk_obj)) = claimed["one_time_keys"][&t.user_id][&t.device_id].as_object().and_then(|o| o.iter().next()) else {
                        tracing::warn!(user = %t.user_id, device = %t.device_id, "no one-time key available; room key not shared with this device yet");
                        continue;
                    };
                    let key_b64 = otk_obj["key"].as_str().unwrap_or_default();
                    let mut signed = json!({"key": key_b64});
                    if otk_obj.get("fallback").and_then(Value::as_bool) == Some(true) {
                        signed["fallback"] = json!(true);
                    }
                    let sig = otk_obj["signatures"][&t.user_id][format!("ed25519:{}", t.device_id)].as_str().unwrap_or_default();
                    let verified = Ed25519PublicKey::from_base64(&t.ed25519)
                        .ok()
                        .zip(Ed25519Signature::from_base64(sig).ok())
                        .is_some_and(|(pk, s)| pk.verify(canonical_json(&signed).as_bytes(), &s).is_ok());
                    if !verified || !otk.starts_with("signed_curve25519:") {
                        tracing::warn!(user = %t.user_id, device = %t.device_id, "one-time key signature does not verify; skipping device");
                        continue;
                    }
                    let (Ok(identity), Ok(one_time)) = (Curve25519PublicKey::from_base64(&t.curve25519), Curve25519PublicKey::from_base64(key_b64)) else {
                        continue;
                    };
                    let session = st.accounts[sender_user]
                        .account
                        .create_outbound_session(OlmConfig::version_1(), identity, one_time)
                        .map_err(io("create olm session"))?;
                    let row = OlmRow {
                        session_id: session.session_id(),
                        user_id: sender_user.into(),
                        device_id: sender_device.into(),
                        peer_user: t.user_id.clone(),
                        peer_device: t.device_id.clone(),
                        peer_curve25519: t.curve25519.clone(),
                        pickle: vec![],
                    };
                    (row, session)
                }
            };
            let payload = json!({
                "type": "m.room_key",
                "content": {"algorithm": ALG_MEGOLM, "room_id": room_id, "session_id": group.session_id(), "session_key": session_key},
                "sender": sender_user, "sender_device": sender_device, "keys": {"ed25519": our_ed},
                "recipient": t.user_id, "recipient_keys": {"ed25519": t.ed25519},
            });
            let ciphertext = session.encrypt(payload.to_string().as_bytes()).map_err(io("olm encrypt"))?;
            olm_row.pickle = serde_json::to_vec(&session.pickle()).map_err(io("serialize olm session"))?;
            self.domain.crypto_olm_put(&olm_row).await?;
            let content = json!({"algorithm": ALG_OLM, "sender_key": our_curve, "ciphertext": {t.curve25519.clone(): serde_json::to_value(&ciphertext)?}});
            messages.entry(t.user_id.clone()).or_insert_with(|| json!({}))[&t.device_id] = content;
            shared.push(key);
        }
        if !messages.is_empty() {
            st.txn += 1;
            let txn = format!("sw-{}-{}", hex::encode(rand_bytes::<4>()), st.txn);
            self.client.send_to_device(sender_user, sender_device, "m.room.encrypted", &txn, Value::Object(messages)).await.map_err(map_matrix_error)?;
        }
        Ok(shared)
    }

    pub async fn rotate_megolm(&self, user_id: &str, room_id: &str, reason: &str) -> Result<bool, Error> {
        let mut st = self.state.lock().await;
        self.ensure_loaded(&mut st, user_id).await?;
        let device = st.accounts[user_id].device_id.clone();
        match self.domain.crypto_out_active(user_id, &device, room_id).await? {
            Some(r) => {
                self.domain.crypto_out_retire(&r.session_id, reason).await?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Replaces the device of `user_id` with a brand-new one (new identity keys, no sessions); the old device is
    /// retired and removed from the homeserver.
    pub async fn rotate_device(&self, user_id: &str) -> Result<String, Error> {
        let mut st = self.state.lock().await;
        self.ensure_loaded(&mut st, user_id).await?;
        let old = st.accounts.remove(user_id).expect("loaded above");
        self.domain.crypto_account_retire(user_id, &old.device_id).await?;
        let device_id = format!("SW{}", hex::encode(rand_bytes::<5>()).to_uppercase());
        let mut fresh = Loaded { device_id: device_id.clone(), generation: old.generation + 1, account: Account::new(), uploaded: false };
        self.persist_account(user_id, &fresh).await?;
        self.publish_keys(user_id, &mut fresh).await?;
        st.accounts.insert(user_id.to_string(), fresh);
        if let Err(e) = self.client.delete_devices(user_id, std::slice::from_ref(&old.device_id)).await {
            tracing::warn!(error = %e, "could not delete the rotated-out device");
        }
        Ok(device_id)
    }

    // ---- inbound ------------------------------------------------------------------------------------------------------------

    /// Processes to-device events delivered to the appservice (MSC2409). Returns the `(room, session)` pairs for which a
    /// new room key arrived, so parked events can be retried.
    pub async fn handle_to_device(&self, events: &[Value]) -> Vec<(String, String)> {
        let mut st = self.state.lock().await;
        let mut arrived = vec![];
        for ev in events {
            if ev["type"] != "m.room.encrypted" {
                continue;
            }
            let to_user = ev["to_user_id"].as_str().map(String::from).unwrap_or_else(|| self.observer_user());
            // only the observer device holds inbound keys; other virtual devices never read Matrix traffic
            if to_user != self.observer_user() || !st.accounts.contains_key(&to_user) && self.ensure_loaded(&mut st, &to_user).await.is_err() {
                continue;
            }
            if let Some(device) = ev["to_device_id"].as_str()
                && st.accounts.get(&to_user).is_some_and(|l| l.device_id != device)
            {
                continue;
            }
            match self.handle_olm_event(&mut st, &to_user, ev).await {
                Ok(Some(pair)) => arrived.push(pair),
                Ok(None) => {}
                Err(e) => {
                    self.domain.metrics.matrix_ingest_errors.inc();
                    tracing::warn!(error = %e, sender = %ev["sender"], "rejected a to-device event");
                }
            }
        }
        arrived
    }

    async fn handle_olm_event(&self, st: &mut State, user: &str, ev: &Value) -> Result<Option<(String, String)>, Error> {
        let content = &ev["content"];
        let sender = ev["sender"].as_str().ok_or_else(|| Error::invalid("to-device event has no sender"))?.to_string();
        if content["algorithm"] != ALG_OLM {
            return Err(Error::invalid("unsupported to-device algorithm"));
        }
        let sender_key = content["sender_key"].as_str().ok_or_else(|| Error::invalid("missing sender_key"))?.to_string();
        let our = st.accounts[user].account.identity_keys();
        let our_curve = our.curve25519.to_base64();
        let message_json = content["ciphertext"][&our_curve].clone();
        if message_json.is_null() {
            return Err(Error::invalid("the Olm message is not addressed to this device"));
        }
        let message: OlmMessage = serde_json::from_value(message_json).map_err(|e| Error::invalid(format!("malformed Olm message: {e}")))?;
        let device_id = st.accounts[user].device_id.clone();

        // existing session first, otherwise a pre-key message creates an inbound one (consuming a one-time key)
        let mut plaintext = None;
        for row in self.domain.crypto_olm_for(user, &device_id, &sender_key).await? {
            let mut session = Session::from_pickle(serde_json::from_slice::<SessionPickle>(&row.pickle).map_err(io("olm pickle"))?);
            if let Ok(p) = session.decrypt(&message) {
                let mut updated = row.clone();
                updated.pickle = serde_json::to_vec(&session.pickle()).map_err(io("serialize olm session"))?;
                self.domain.crypto_olm_put(&updated).await?;
                plaintext = Some(p);
                break;
            }
        }
        let plaintext = match (plaintext, &message) {
            (Some(p), _) => p,
            (None, OlmMessage::PreKey(prekey)) => {
                let identity = Curve25519PublicKey::from_base64(&sender_key).map_err(|e| Error::invalid(format!("bad sender key: {e}")))?;
                let created = st
                    .accounts
                    .get_mut(user)
                    .expect("loaded")
                    .account
                    .create_inbound_session(OlmConfig::version_1(), identity, prekey)
                    .map_err(|e| Error::invalid(format!("cannot create an Olm session: {e}")))?;
                self.persist_account(user, &st.accounts[user]).await?;
                self.domain
                    .crypto_olm_put(&OlmRow {
                        session_id: created.session.session_id(),
                        user_id: user.into(),
                        device_id: device_id.clone(),
                        peer_user: sender.clone(),
                        peer_device: String::new(),
                        peer_curve25519: sender_key.clone(),
                        pickle: serde_json::to_vec(&created.session.pickle()).map_err(io("serialize olm session"))?,
                    })
                    .await?;
                created.plaintext
            }
            (None, _) => return Err(Error::invalid("no Olm session matches this message")),
        };
        let payload: Value = serde_json::from_slice(&plaintext).map_err(|_| Error::invalid("Olm payload is not JSON"))?;

        // the claimed identity must match the authenticated channel and a verified device of that user
        if payload["sender"] != sender || payload["recipient"] != user || payload["recipient_keys"]["ed25519"] != our.ed25519.to_base64() {
            return Err(Error::new(ErrorCode::Unauthenticated, "Olm payload identity does not match the to-device envelope"));
        }
        self.refresh_devices(st, user, std::slice::from_ref(&sender), false).await?;
        let mut device = self.devices_of(&sender).await?.into_iter().find(|d| d.curve25519 == sender_key);
        if device.is_none() {
            self.refresh_devices(st, user, std::slice::from_ref(&sender), true).await?;
            device = self.devices_of(&sender).await?.into_iter().find(|d| d.curve25519 == sender_key);
        }
        let device = device.ok_or_else(|| Error::new(ErrorCode::Unauthenticated, "the sending device is not a known device of the sender"))?;
        if payload["keys"]["ed25519"] != device.ed25519 {
            return Err(Error::new(ErrorCode::Unauthenticated, "the claimed Ed25519 key does not match the sender's device"));
        }
        if payload["type"] != "m.room_key" || payload["content"]["algorithm"] != ALG_MEGOLM {
            return Ok(None);
        }
        let room_id = payload["content"]["room_id"].as_str().unwrap_or_default().to_string();
        let session_id = payload["content"]["session_id"].as_str().unwrap_or_default().to_string();
        let key = SessionKey::from_base64(payload["content"]["session_key"].as_str().unwrap_or_default())
            .map_err(|e| Error::invalid(format!("bad session key: {e}")))?;
        let inbound = InboundGroupSession::new(&key, MegolmConfig::version_1());
        if inbound.session_id() != session_id {
            return Err(Error::new(ErrorCode::Unauthenticated, "the announced session id does not match the session key"));
        }
        let row = InboundRow {
            room_id: room_id.clone(),
            session_id: session_id.clone(),
            user_id: user.into(),
            sender_key,
            sender_user: sender,
            sender_device: device.device_id,
            first_known_index: 0,
            pickle: serde_json::to_vec(&inbound.pickle()).map_err(io("serialize inbound session"))?,
        };
        self.domain.crypto_in_put(&row).await?;
        Ok(Some((room_id, session_id)))
    }

    /// Decrypts a Megolm `m.room.encrypted` event for the observer device.
    pub async fn decrypt_room_event(&self, ev: &Value) -> Result<Decrypted, DecryptError> {
        let mut st = self.state.lock().await;
        let observer = self.observer_user();
        self.ensure_loaded(&mut st, &observer).await.map_err(|e| DecryptError::Failed(e.message))?;
        let content = &ev["content"];
        let (room_id, event_id, sender) =
            (ev["room_id"].as_str().unwrap_or_default(), ev["event_id"].as_str().unwrap_or_default(), ev["sender"].as_str().unwrap_or_default());
        if content["algorithm"] != ALG_MEGOLM {
            return Err(DecryptError::Rejected("unsupported encryption algorithm".into()));
        }
        let (session_id, sender_key) = (content["session_id"].as_str().unwrap_or_default(), content["sender_key"].as_str().unwrap_or_default());
        let row = self
            .domain
            .crypto_in_get(room_id, session_id)
            .await
            .map_err(|e| DecryptError::Failed(e.message))?
            .ok_or_else(|| DecryptError::UnknownSession(session_id.to_string()))?;
        if row.sender_key != sender_key {
            return Err(DecryptError::Rejected("sender_key does not match the device that issued this session".into()));
        }
        if row.sender_user != sender {
            return Err(DecryptError::Rejected("the session was issued by a different user than the event sender".into()));
        }
        let mut devices = self.devices_of(sender).await.map_err(|e| DecryptError::Failed(e.message))?;
        if !devices.iter().any(|d| d.curve25519 == sender_key) {
            self.refresh_devices(&mut st, &observer, &[sender.to_string()], true).await.map_err(|e| DecryptError::Failed(e.message))?;
            devices = self.devices_of(sender).await.map_err(|e| DecryptError::Failed(e.message))?;
        }
        let Some(device) = devices.into_iter().find(|d| d.curve25519 == sender_key) else {
            return Err(DecryptError::Rejected("sender_key is not a device of the event sender".into()));
        };
        if content["device_id"].as_str().is_some_and(|d| d != device.device_id) {
            return Err(DecryptError::Rejected("device_id does not match the sender key".into()));
        }
        let mut inbound = InboundGroupSession::from_pickle(
            serde_json::from_slice::<InboundGroupSessionPickle>(&row.pickle).map_err(|e| DecryptError::Failed(e.to_string()))?,
        );
        let message = MegolmMessage::from_base64(content["ciphertext"].as_str().unwrap_or_default())
            .map_err(|e| DecryptError::Rejected(format!("malformed ciphertext: {e}")))?;
        let decrypted = inbound.decrypt(&message).map_err(|e| DecryptError::Failed(e.to_string()))?;
        let fresh = self
            .domain
            .crypto_replay_record(room_id, session_id, decrypted.message_index as i64, event_id)
            .await
            .map_err(|e| DecryptError::Failed(e.message))?;
        if !fresh {
            return Err(DecryptError::Rejected(format!(
                "message index {} of this session was already used by another event (replay)",
                decrypted.message_index
            )));
        }
        let inner: Value = serde_json::from_slice(&decrypted.plaintext).map_err(|_| DecryptError::Rejected("plaintext is not JSON".into()))?;
        if inner["room_id"] != room_id {
            return Err(DecryptError::Rejected("the encrypted payload belongs to another room".into()));
        }
        Ok(Decrypted { event_type: inner["type"].as_str().unwrap_or_default().to_string(), content: inner["content"].clone(), sender_device: device.device_id })
    }

    pub async fn park_event(&self, session_id: &str, ev: &Value) -> Result<(), Error> {
        self.domain.crypto_pending_put(ev["event_id"].as_str().unwrap_or_default(), ev["room_id"].as_str().unwrap_or_default(), session_id, ev).await
    }

    pub async fn take_parked(&self, room_id: &str, session_id: &str) -> Result<Vec<Value>, Error> {
        self.domain.crypto_pending_take(room_id, session_id).await
    }

    // ---- introspection (operators and tests) ---------------------------------------------------------------------------------

    pub async fn account_pickle_json(&self, user_id: &str) -> Result<String, Error> {
        let mut st = self.state.lock().await;
        self.ensure_loaded(&mut st, user_id).await?;
        serde_json::to_string(&st.accounts[user_id].account.pickle()).map_err(io("serialize account"))
    }

    /// Forgets in-memory state (e.g. after the database was restored or replaced) so it is reloaded from storage.
    pub async fn reload(&self) {
        *self.state.lock().await = State::default();
    }
}

fn rand_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    let mut seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0) as u64
        ^ (std::process::id() as u64).rotate_left(32);
    for b in out.iter_mut() {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407 ^ (seed >> 29));
        *b = (seed >> 33) as u8;
    }
    out
}
