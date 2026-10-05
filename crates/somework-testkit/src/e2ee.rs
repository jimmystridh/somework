//! A scriptable end-to-end-encrypted Matrix client built on vodozemac (what Element does for a human): it publishes
//! device keys, shares Megolm room keys to every device in the room over Olm, encrypts messages and decrypts what the
//! bridge projects. Used against [`MockMatrix`] to prove the bridge's Olm/Megolm implementation interoperates.

use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};
use somework_core::canonical::canonical_json;
use vodozemac::{
    Curve25519PublicKey, Ed25519PublicKey, Ed25519Signature,
    megolm::{GroupSession, InboundGroupSession, MegolmMessage, SessionConfig as MegolmConfig, SessionKey},
    olm::{Account, OlmMessage, Session, SessionConfig as OlmConfig},
};

use crate::matrix::{MockMatrix, MxEvent};

pub struct TestHumanDevice {
    pub user: String,
    pub device_id: String,
    account: Account,
    olm: HashMap<String, Session>,
    outbound: HashMap<String, (GroupSession, HashSet<String>)>,
    inbound: HashMap<(String, String), InboundGroupSession>,
    /// Sessions announced to us whose sender key we recorded (to detect forged sender keys on decryption).
    inbound_sender: HashMap<(String, String), String>,
}

fn sign(account: &Account, user: &str, device: &str, obj: &Value) -> Value {
    json!({user: {format!("ed25519:{device}"): account.sign(canonical_json(obj).as_bytes()).to_base64()}})
}

impl TestHumanDevice {
    /// Creates the device and publishes device keys, 20 one-time keys and a fallback key.
    pub fn new(mock: &MockMatrix, user: &str, device_id: &str) -> Self {
        let mut account = Account::new();
        let ids = account.identity_keys();
        let mut device_keys = json!({
            "user_id": user, "device_id": device_id,
            "algorithms": ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
            "keys": {format!("curve25519:{device_id}"): ids.curve25519.to_base64(), format!("ed25519:{device_id}"): ids.ed25519.to_base64()},
        });
        device_keys["signatures"] = sign(&account, user, device_id, &device_keys);
        account.generate_one_time_keys(20);
        let mut otks = serde_json::Map::new();
        for (id, key) in account.one_time_keys() {
            let mut k = json!({"key": key.to_base64()});
            k["signatures"] = sign(&account, user, device_id, &k);
            otks.insert(format!("signed_curve25519:{}", id.to_base64()), k);
        }
        account.generate_fallback_key();
        let mut fallbacks = serde_json::Map::new();
        for (id, key) in account.fallback_key() {
            let mut k = json!({"key": key.to_base64(), "fallback": true});
            k["signatures"] = sign(&account, user, device_id, &k);
            fallbacks.insert(format!("signed_curve25519:{}", id.to_base64()), k);
        }
        mock.client_keys_upload(user, device_id, &json!({"device_keys": device_keys, "one_time_keys": otks, "fallback_keys": fallbacks}));
        account.mark_keys_as_published();
        Self {
            user: user.into(),
            device_id: device_id.into(),
            account,
            olm: HashMap::new(),
            outbound: HashMap::new(),
            inbound: HashMap::new(),
            inbound_sender: HashMap::new(),
        }
    }

    pub fn curve25519(&self) -> String {
        self.account.identity_keys().curve25519.to_base64()
    }

    pub fn ed25519(&self) -> String {
        self.account.identity_keys().ed25519.to_base64()
    }

    /// Decrypts queued to-device events: Olm-wrapped `m.room_key` events become inbound Megolm sessions.
    pub fn process_to_device(&mut self, mock: &MockMatrix) -> usize {
        let mut accepted = 0;
        for ev in mock.client_take_to_device(&self.user, &self.device_id) {
            let content = &ev["content"];
            let Some(sender_key) = content["sender_key"].as_str() else { continue };
            let Ok(message) = serde_json::from_value::<OlmMessage>(content["ciphertext"][self.curve25519()].clone()) else { continue };
            let plaintext = match self.olm.get_mut(sender_key).and_then(|s| s.decrypt(&message).ok()) {
                Some(p) => p,
                None => match &message {
                    OlmMessage::PreKey(pre) => {
                        let Ok(identity) = Curve25519PublicKey::from_base64(sender_key) else { continue };
                        let Ok(created) = self.account.create_inbound_session(OlmConfig::version_1(), identity, pre) else { continue };
                        self.olm.insert(sender_key.to_string(), created.session);
                        created.plaintext
                    }
                    _ => continue,
                },
            };
            let Ok(payload) = serde_json::from_slice::<Value>(&plaintext) else { continue };
            if payload["type"] != "m.room_key" {
                continue;
            }
            let (room, session_id) = (
                payload["content"]["room_id"].as_str().unwrap_or_default().to_string(),
                payload["content"]["session_id"].as_str().unwrap_or_default().to_string(),
            );
            let Ok(key) = SessionKey::from_base64(payload["content"]["session_key"].as_str().unwrap_or_default()) else { continue };
            self.inbound.entry((room.clone(), session_id.clone())).or_insert_with(|| InboundGroupSession::new(&key, MegolmConfig::version_1()));
            self.inbound_sender.insert((room, session_id), sender_key.to_string());
            accepted += 1;
        }
        accepted
    }

    /// Verifies and claims a one-time key of `(user, device)` and returns an outbound Olm session to it.
    fn session_to(&mut self, mock: &MockMatrix, user: &str, device: &str, curve: &str, ed: &str) -> Option<()> {
        if self.olm.contains_key(curve) {
            return Some(());
        }
        let claimed = mock.client_keys_claim(user, device)?;
        let (_, otk) = claimed.as_object()?.iter().next()?;
        let mut signed = json!({"key": otk["key"]});
        if otk["fallback"] == true {
            signed["fallback"] = json!(true);
        }
        let sig = otk["signatures"][user][format!("ed25519:{device}")].as_str()?;
        Ed25519PublicKey::from_base64(ed).ok()?.verify(canonical_json(&signed).as_bytes(), &Ed25519Signature::from_base64(sig).ok()?).ok()?;
        let session = self
            .account
            .create_outbound_session(
                OlmConfig::version_1(),
                Curve25519PublicKey::from_base64(curve).ok()?,
                Curve25519PublicKey::from_base64(otk["key"].as_str()?).ok()?,
            )
            .ok()?;
        self.olm.insert(curve.to_string(), session);
        Some(())
    }

    /// Devices of the room's joined members other than this one (clients share keys with all of them).
    fn room_devices(&self, mock: &MockMatrix, room: &str) -> Vec<(String, String, String, String)> {
        let members = mock.joined_members_of(room);
        let keys = mock.client_keys_query(&members);
        let mut out = vec![];
        for u in members {
            for (device, obj) in keys[&u].as_object().cloned().unwrap_or_default() {
                if u == self.user && device == self.device_id {
                    continue;
                }
                let (Some(curve), Some(ed)) = (obj["keys"][format!("curve25519:{device}")].as_str(), obj["keys"][format!("ed25519:{device}")].as_str()) else {
                    continue;
                };
                out.push((u.clone(), device, curve.to_string(), ed.to_string()));
            }
        }
        out
    }

    /// Shares the room's current Megolm session with every device that has not received it; starts a new session
    /// when a device that held the old one is gone (what clients do when somebody leaves).
    pub fn ensure_room_session(&mut self, mock: &MockMatrix, room: &str) {
        let devices = self.room_devices(mock, room);
        let current: HashSet<String> = devices.iter().map(|(u, d, _, _)| format!("{u}|{d}")).collect();
        if let Some((_, shared)) = self.outbound.get(room)
            && shared.iter().any(|d| !current.contains(d))
        {
            self.outbound.remove(room);
        }
        let (group, shared) = self.outbound.entry(room.to_string()).or_insert_with(|| (GroupSession::new(MegolmConfig::version_1()), HashSet::new()));
        let (session_id, session_key) = (group.session_id(), group.session_key().to_base64());
        let mut messages = serde_json::Map::new();
        let missing: Vec<_> = devices.into_iter().filter(|(u, d, _, _)| !shared.contains(&format!("{u}|{d}"))).collect();
        let our_curve = self.account.identity_keys().curve25519.to_base64();
        let our_ed = self.account.identity_keys().ed25519.to_base64();
        for (user, device, curve, ed) in missing {
            if self.session_to(mock, &user, &device, &curve, &ed).is_none() {
                continue;
            }
            let payload = json!({
                "type": "m.room_key", "content": {"algorithm": "m.megolm.v1.aes-sha2", "room_id": room, "session_id": session_id, "session_key": session_key},
                "sender": self.user, "sender_device": self.device_id, "keys": {"ed25519": our_ed}, "recipient": user, "recipient_keys": {"ed25519": ed},
            });
            let Ok(ciphertext) = self.olm.get_mut(&curve).expect("session").encrypt(payload.to_string().as_bytes()) else { continue };
            messages.entry(user.clone()).or_insert_with(|| json!({}))[&device] = json!({"algorithm": "m.olm.v1.curve25519-aes-sha2", "sender_key": our_curve, "ciphertext": {curve.clone(): serde_json::to_value(&ciphertext).expect("olm message")}});
            self.outbound.get_mut(room).expect("session").1.insert(format!("{user}|{device}"));
        }
        if !messages.is_empty() {
            mock.client_send_to_device(&self.user, "m.room.encrypted", &serde_json::Value::Object(messages));
        }
    }

    /// Encrypts and sends an event as this human (shares the room key first).
    pub fn send_encrypted(&mut self, mock: &MockMatrix, room: &str, event_type: &str, content: Value) -> MxEvent {
        self.ensure_room_session(mock, room);
        let outer = self.encrypt_only(room, event_type, content);
        mock.user_send(room, &self.user, "m.room.encrypted", outer).expect("send encrypted event")
    }

    /// Produces the wire content of an encrypted event without sending it (forgery/replay scenarios).
    pub fn encrypt_only(&mut self, room: &str, event_type: &str, content: Value) -> Value {
        let (group, _) = self.outbound.get_mut(room).expect("room session exists; call ensure_room_session first");
        let message = group.encrypt(canonical_json(&json!({"type": event_type, "content": content, "room_id": room})).as_bytes());
        let mut outer = json!({"algorithm": "m.megolm.v1.aes-sha2", "sender_key": self.account.identity_keys().curve25519.to_base64(), "device_id": self.device_id, "session_id": group.session_id(), "ciphertext": message.to_base64()});
        if let Some(rel) = content.get("m.relates_to") {
            outer["m.relates_to"] = rel.clone();
        }
        outer
    }

    /// Decrypts an `m.room.encrypted` event (e.g. a bridge projection); `None` when no key for its session is known.
    pub fn decrypt(&mut self, mock: &MockMatrix, ev: &MxEvent) -> Option<(String, Value)> {
        self.process_to_device(mock);
        if ev.kind != "m.room.encrypted" {
            return Some((ev.kind.clone(), ev.content.clone()));
        }
        let session_id = ev.content["session_id"].as_str()?;
        let session = self.inbound.get_mut(&(ev.room_id.clone(), session_id.to_string()))?;
        let message = MegolmMessage::from_base64(ev.content["ciphertext"].as_str()?).ok()?;
        let decrypted = session.decrypt(&message).ok()?;
        let inner: Value = serde_json::from_slice(&decrypted.plaintext).ok()?;
        Some((inner["type"].as_str()?.to_string(), inner["content"].clone()))
    }

    pub fn knows_session(&self, room: &str, session_id: &str) -> bool {
        self.inbound.contains_key(&(room.to_string(), session_id.to_string()))
    }

    pub fn current_session_id(&self, room: &str) -> Option<String> {
        self.outbound.get(room).map(|(g, _)| g.session_id())
    }
}
