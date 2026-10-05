//! Shared bridge state: homeserver client, virtual users, room/thread mappings. Both the outbound projector
//! ([`crate::sink`]) and the inbound ingestion ([`crate::ingest`]) use it.

use std::{collections::HashSet, sync::Arc};

use parking_lot::Mutex;
use serde_json::{Value, json};
use somework_core::{Error, ErrorCode, contracts::ActorKind};
use somework_domain::{Ctx, Domain, config::MatrixProfile, transport::Mapping};

use crate::{
    client::{MatrixClient, MatrixError, Tokens},
    config::MatrixConfig,
    crypto::CryptoManager,
};

pub const TRANSPORT: &str = "matrix";
pub const EV_TASK: &str = "dev.somework.task.v1";
pub const EV_CONTEXT: &str = "dev.somework.context.v1";
pub const EV_ARTIFACT: &str = "dev.somework.artifact.v1";
pub const EV_APPROVAL: &str = "dev.somework.approval.v1";
pub const EV_ROOM: &str = "dev.somework.room";
pub const REF_KEY: &str = "dev.somework.ref";

#[derive(Default)]
struct Caches {
    registered: HashSet<String>,
    joined: HashSet<(String, String)>,
    invited: HashSet<(String, String)>,
}

pub struct Bridge {
    pub domain: Domain,
    pub cfg: MatrixConfig,
    pub client: MatrixClient,
    pub tokens: Tokens,
    /// Present only in the `encrypted_with_observer` profile: the bridge's Olm/Megolm devices.
    pub crypto: Option<Arc<CryptoManager>>,
    caches: Mutex<Caches>,
    structure_lock: tokio::sync::Mutex<()>,
}

pub fn thread_relation(root: &str) -> Value {
    json!({"rel_type": "m.thread", "event_id": root, "is_falling_back": true, "m.in_reply_to": {"event_id": root}})
}

pub fn map_matrix_error(e: MatrixError) -> Error {
    if e.is_transient() { Error::unavailable(e.to_string()) } else { Error::new(ErrorCode::Conflict, e.to_string()) }
}

impl Bridge {
    pub fn new(domain: Domain, cfg: MatrixConfig) -> Arc<Self> {
        let tokens = Tokens::new(&cfg);
        let client = MatrixClient::new(&cfg, tokens.clone());
        // Only the observer profile holds crypto devices. In `metadata_only_private` the bridge must be unable to read
        // human content, so it never uploads device keys and therefore never receives room keys.
        let crypto = (domain.cfg.matrix_profile == MatrixProfile::EncryptedWithObserver)
            .then(|| Arc::new(CryptoManager::new(domain.clone(), client.clone(), cfg.clone())));
        Arc::new(Self { domain, cfg, client, tokens, crypto, caches: Mutex::default(), structure_lock: tokio::sync::Mutex::new(()) })
    }

    pub fn ctx(&self) -> Ctx {
        self.domain.system_ctx().with_transport(TRANSPORT)
    }

    pub fn profile(&self) -> MatrixProfile {
        self.domain.cfg.matrix_profile
    }

    /// Content (message text, progress text, offer objectives...) may be projected in the auditable profile (plaintext
    /// rooms) and in the observer profile (genuinely end-to-end encrypted rooms). The metadata-only profile never
    /// projects content.
    pub fn content_allowed(&self) -> bool {
        match self.profile() {
            MatrixProfile::AuditableInternal => true,
            MatrixProfile::EncryptedWithObserver => self.crypto.is_some(),
            MatrixProfile::MetadataOnlyPrivate => false,
        }
    }

    pub fn rotate_tokens(&self, as_token: &str, hs_token: &str, keep_previous_hs: bool) {
        self.tokens.rotate(as_token.to_string(), hs_token.to_string(), keep_previous_hs);
    }

    pub async fn ensure_virtual_user(&self, agent_id: &str) -> Result<String, Error> {
        let user_id = self.cfg.agent_user_id(agent_id);
        if self.caches.lock().registered.contains(&user_id) {
            return Ok(user_id);
        }
        let localpart = user_id.trim_start_matches('@').split(':').next().unwrap_or_default().to_string();
        self.client.register_virtual_user(&localpart).await.map_err(map_matrix_error)?;
        let name = self.domain.principal_display_name(ActorKind::Agent, agent_id).await?.unwrap_or_else(|| agent_id.to_string());
        self.client.set_displayname(&user_id, &name).await.map_err(map_matrix_error)?;
        self.caches.lock().registered.insert(user_id.clone());
        Ok(user_id)
    }

    /// Bot invites, the virtual user joins (private rooms cannot be joined uninvited).
    pub async fn ensure_joined(&self, room_id: &str, user_id: &str) -> Result<(), Error> {
        let key = (room_id.to_string(), user_id.to_string());
        if self.caches.lock().joined.contains(&key) {
            return Ok(());
        }
        self.client.invite(room_id, &self.cfg.bot_user_id(), user_id).await.map_err(map_matrix_error)?;
        self.client.join(room_id, user_id).await.map_err(map_matrix_error)?;
        self.caches.lock().joined.insert(key);
        Ok(())
    }

    pub async fn room_for_conversation(&self, conversation_id: &str) -> Result<Option<String>, Error> {
        Ok(self.domain.mapping_by_object(TRANSPORT, "conversation", conversation_id).await?.map(|m| m.external_id))
    }

    pub async fn conversation_for_room(&self, room_id: &str) -> Result<Option<String>, Error> {
        Ok(self.domain.mapping_by_external(TRANSPORT, room_id).await?.filter(|m| m.object_kind == "conversation").map(|m| m.object_id))
    }

    /// Conversation -> room. Every conversation owns exactly one room, so Matrix membership always tracks
    /// conversation membership; sensitive classifications are flagged dedicated and never share a room.
    pub async fn ensure_room(&self, conversation_id: &str) -> Result<String, Error> {
        if let Some(room) = self.room_for_conversation(conversation_id).await? {
            self.sync_members(&room, conversation_id).await?;
            return Ok(room);
        }
        let _guard = self.structure_lock.lock().await;
        if let Some(room) = self.room_for_conversation(conversation_id).await? {
            return Ok(room);
        }
        let ctx = self.ctx();
        let conv = self.domain.get_conversation(&ctx, conversation_id).await?;
        let policy = self.domain.get_policy(&ctx).await?;
        let scale = policy.scale();
        let dedicated = match (scale.rank(&conv.classification), scale.rank(&policy.dedicated_room_classification)) {
            (Some(c), Some(d)) => c >= d,
            _ => true,
        };
        let mut invites = self.human_members(&conv).await?;
        let profile = self.profile();
        if profile == MatrixProfile::EncryptedWithObserver
            && let Some(observer) = &self.cfg.observer_user
        {
            invites.push(observer.clone());
        }
        let mut initial_state = vec![
            json!({"type": "m.room.power_levels", "state_key": "", "content": {"users": {self.cfg.bot_user_id(): 100}, "users_default": self.cfg.default_users_power_level, "events_default": 0, "state_default": 50}}),
            json!({"type": EV_ROOM, "state_key": "", "content": {"conversation_id": conversation_id, "classification": conv.classification, "dedicated": dedicated, "profile": profile}}),
        ];
        if profile != MatrixProfile::AuditableInternal {
            initial_state.push(json!({"type": "m.room.encryption", "state_key": "", "content": {"algorithm": "m.megolm.v1.aes-sha2"}}));
        }
        let alias_local = format!("somework-{}", conversation_id.to_lowercase());
        let name = match &conv.title {
            Some(t) if dedicated => format!("[{}] {t}", conv.classification),
            Some(t) => t.clone(),
            None => format!("SomeWork {conversation_id}"),
        };
        let body = json!({
            "name": name,
            "room_alias_name": alias_local,
            "preset": "private_chat",
            "is_direct": conv.kind == "dm",
            "invite": invites,
            "initial_state": initial_state,
        });
        let room_id = match self.client.create_room(&self.cfg.bot_user_id(), body).await {
            Ok(id) => id,
            Err(e) if e.errcode == "M_ROOM_IN_USE" => {
                let alias = format!("#{alias_local}:{}", self.cfg.server_name);
                self.client
                    .resolve_alias(&alias)
                    .await
                    .map_err(map_matrix_error)?
                    .ok_or_else(|| Error::unavailable("room alias exists but cannot be resolved"))?
            }
            Err(e) => return Err(map_matrix_error(e)),
        };
        if let Some(crypto) = &self.crypto {
            // humans' clients can only share room keys with the observer device once its keys are on the homeserver
            crypto.ensure_device(&self.cfg.bot_user_id()).await?;
        }
        self.domain
            .put_mapping(&Mapping::new(
                TRANSPORT,
                &room_id,
                "conversation",
                conversation_id,
                json!({"dedicated": dedicated, "classification": conv.classification}),
            ))
            .await?;
        let mut caches = self.caches.lock();
        for user in invites {
            caches.invited.insert((room_id.clone(), user));
        }
        Ok(room_id)
    }

    async fn human_members(&self, conv: &somework_domain::messages::ConversationView) -> Result<Vec<String>, Error> {
        let mut out = vec![];
        for m in conv.members.iter().filter(|m| m.kind == ActorKind::Human) {
            if let Some(mxid) = self.domain.matrix_user_for_principal(ActorKind::Human, &m.id).await? {
                out.push(mxid);
            }
        }
        Ok(out)
    }

    /// Invites newly added human members (e.g. approvers added when an approval is requested).
    pub async fn sync_members(&self, room_id: &str, conversation_id: &str) -> Result<(), Error> {
        let conv = self.domain.get_conversation(&self.ctx(), conversation_id).await?;
        for mxid in self.human_members(&conv).await? {
            let key = (room_id.to_string(), mxid.clone());
            if self.caches.lock().invited.contains(&key) {
                continue;
            }
            self.client.invite(room_id, &self.cfg.bot_user_id(), &mxid).await.map_err(map_matrix_error)?;
            self.caches.lock().invited.insert(key);
        }
        Ok(())
    }

    /// Sends an event with the size guard: projections that would exceed the Matrix limit are replaced by a notice
    /// pointing at the canonical object (nothing oversized is ever sent).
    pub async fn send(&self, room_id: &str, as_user: &str, event_type: &str, txn_id: &str, content: Value, canonical_ref: &str) -> Result<String, Error> {
        let size = serde_json::to_vec(&content).map(|v| v.len()).unwrap_or(usize::MAX) + 600;
        let (event_type, content) = if size > self.cfg.max_event_bytes {
            (
                "m.room.message",
                json!({"msgtype": "m.notice", "body": format!("This update is {size} bytes, over the Matrix event limit of {}; read it at {canonical_ref}", self.cfg.max_event_bytes), "dev.somework.oversize": true, REF_KEY: {"canonical_ref": canonical_ref}, "m.relates_to": content.get("m.relates_to").cloned().unwrap_or(Value::Null)}),
            )
        } else {
            (event_type, content)
        };
        let content = match content {
            Value::Object(mut o) => {
                if o.get("m.relates_to").is_some_and(Value::is_null) {
                    o.remove("m.relates_to");
                }
                Value::Object(o)
            }
            other => other,
        };
        // Observer profile: everything the bridge sends into an encrypted room is encrypted; a failure never falls back
        // to plaintext (the outbox retries instead).
        let (event_type, content) = match &self.crypto {
            Some(crypto) => ("m.room.encrypted".to_string(), crypto.encrypt_room_event(as_user, room_id, event_type, &content).await?),
            None => (event_type.to_string(), content),
        };
        self.client.send_event(room_id, as_user, &event_type, txn_id, &content).await.map_err(map_matrix_error)
    }

    pub async fn notice(&self, room_id: &str, txn_id: &str, body: &str, thread_root: Option<&str>, reference: Option<Value>) -> Result<String, Error> {
        let mut content = json!({"msgtype": "m.notice", "body": body});
        if let Some(root) = thread_root {
            content["m.relates_to"] = thread_relation(root);
        }
        if let Some(r) = reference {
            content[REF_KEY] = r;
        }
        self.send(room_id, &self.cfg.bot_user_id(), "m.room.message", txn_id, content, "somework://").await
    }

    pub async fn task_root(&self, room_id: &str, task_id: &str) -> Result<String, Error> {
        if let Some(m) = self.domain.mapping_by_object(TRANSPORT, "task", task_id).await? {
            return Ok(m.external_id);
        }
        let _guard = self.structure_lock.lock().await;
        if let Some(m) = self.domain.mapping_by_object(TRANSPORT, "task", task_id).await? {
            return Ok(m.external_id);
        }
        let view = self.domain.get_task(&self.ctx(), task_id).await?;
        let summary = format!("Task {} — {}@{}", task_id, view.task.capability.id, view.task.capability.version);
        let content = json!({"msgtype": "m.notice", "body": summary, REF_KEY: {"type": "task", "id": task_id}});
        let event_id =
            self.send(room_id, &self.cfg.bot_user_id(), "m.room.message", &format!("root:{task_id}"), content, &format!("somework://tasks/{task_id}")).await?;
        self.domain.put_mapping(&Mapping::new(TRANSPORT, &event_id, "task", task_id, json!({"roomId": room_id}))).await?;
        Ok(event_id)
    }
}
