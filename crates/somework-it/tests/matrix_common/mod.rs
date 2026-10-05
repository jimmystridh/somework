#![allow(dead_code)]

use std::{sync::Arc, time::Duration};

use serde_json::{Value, json};
use somework_core::{
    contracts::{ActorKind, SideEffects},
    jws,
};
use somework_domain::{auth::CreatePrincipal, config::MatrixProfile, policy::Permissions};
use somework_matrix::MatrixConfig;
use somework_testkit::{Agent, Human, Stack, StackBuilder, capability, matrix::MockMatrix, process::eventually};

pub const AS_TOKEN: &str = "as_secret_token";
pub const HS_TOKEN: &str = "hs_secret_token";

pub struct MxEnv {
    pub stack: Stack,
    pub mx: MockMatrix,
}

pub fn matrix_config(mx: &MockMatrix) -> MatrixConfig {
    MatrixConfig {
        homeserver_url: mx.url.clone(),
        server_name: mx.server_name.clone(),
        as_token: AS_TOKEN.into(),
        hs_token: HS_TOKEN.into(),
        ..Default::default()
    }
}

impl MxEnv {
    pub async fn start() -> Self {
        Self::start_with(|_| {}, MatrixProfile::AuditableInternal).await
    }

    pub async fn start_with(tweak: impl FnOnce(&mut MatrixConfig), profile: MatrixProfile) -> Self {
        let mx = MockMatrix::start("hs.test").await;
        let mut mcfg = matrix_config(&mx);
        tweak(&mut mcfg);
        let stack = StackBuilder::new()
            .config(|cfg| {
                cfg.matrix = Some(mcfg.clone());
                cfg.domain.matrix_profile = profile;
            })
            .start()
            .await;
        mx.register_appservice(&stack.url, AS_TOKEN, HS_TOKEN, &mcfg.agent_prefix, &mcfg.sender_localpart);
        Self { stack, mx }
    }

    /// A human principal explicitly mapped to a Matrix account (ID-04).
    pub async fn human(&self, id: &str, mxid: &str, perms: Permissions) -> Human {
        let key = jws::new_signing_key();
        self.stack
            .domain()
            .create_principal(
                &self.stack.domain().system_ctx(),
                CreatePrincipal {
                    kind: ActorKind::Human,
                    id: id.into(),
                    display_name: Some(id.into()),
                    permissions: Some(perms),
                    public_key: Some(jws::verifying_key_to_b64(&key.verifying_key())),
                    matrix_user_id: Some(mxid.into()),
                    oidc_issuer: None,
                    oidc_subject: None,
                },
            )
            .await
            .expect("create human");
        self.mx.add_user(mxid);
        let client = somework_client::Client::assertion(&self.stack.url, key.clone(), "human", id, &self.stack.domain_id);
        Human { id: id.into(), key: Arc::new(key), client }
    }

    pub async fn wait_room(&self, fragment: &str) -> String {
        eventually(&format!("room containing {fragment:?}"), Duration::from_secs(10), || async { self.mx.room_by_name(fragment) }).await
    }

    pub async fn conversation(&self, owner: &Agent, title: &str, members: &[(&str, &str)], classification: Option<&str>) -> String {
        let members: Vec<Value> = members.iter().map(|(k, i)| json!({"kind": k, "id": i})).collect();
        let v = owner
            .client
            .post("/v1/conversations", &json!({"kind": "room", "title": title, "members": members, "classification": classification}))
            .await
            .expect("create conversation");
        v["conversationId"].as_str().expect("conversation id").to_string()
    }
}

pub fn human_perms() -> Permissions {
    let mut p = Permissions::default_human();
    p.actions.push("task.update".into());
    p.capabilities = vec!["code.review".into()];
    p
}

pub fn worker_perms(se: SideEffects) -> Permissions {
    let mut p = Permissions::default_agent();
    p.side_effects_at_most = Some(se);
    p
}

pub fn review_cap() -> Value {
    capability("code.review", "2.1", "read", "Review pull requests for correctness and security")
}

pub async fn eventually_events(
    mx: &MockMatrix,
    room: &str,
    what: &str,
    pred: impl Fn(&somework_testkit::matrix::MxEvent) -> bool,
) -> somework_testkit::matrix::MxEvent {
    eventually(what, Duration::from_secs(10), || async { mx.events(room).into_iter().find(|e| pred(e)) }).await
}
