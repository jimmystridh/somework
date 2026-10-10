//! Seeded development stack for the operations UI and its Playwright suite.
//!
//! Env: DEVSTACK_PORT (18080), DEVSTACK_IDP_PORT (18081), DEVSTACK_OUT (credentials JSON, default ./devstack.json).
//! Prints the console URL and writes agent/human keys so tests can drive the API alongside the browser.

use std::{sync::Arc, time::Duration};

use serde_json::{Value, json};
use somework_client::Client;
use somework_core::{contracts::ActorKind, jws};
use somework_domain::{auth::CreatePrincipal, policy::Permissions};
use somework_testkit::{Agent, StackBuilder, capability, oidc::MockIdp};

fn env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

fn key_json(kind: &str, id: &str, key: &ed25519_dalek::SigningKey, runtime: Option<String>) -> Value {
    json!({"kind": kind, "id": id, "privateKey": jws::signing_key_to_b64(key), "runtimeInstanceId": runtime})
}

async fn send(client: &Client, conversation: &str, kind: &str, to: Option<&str>, text: &str, artifacts: &[Value]) -> Value {
    let mut body = json!({"type": kind, "conversationId": conversation, "content": {"mediaType": "text/plain", "data": text}, "artifacts": artifacts});
    if let Some(to) = to {
        body["recipients"] = json!([{"kind": "agent", "id": to}]);
    }
    client.send_message(&body).await.expect("send message")
}

#[tokio::main]
async fn main() {
    let port: u16 = env("DEVSTACK_PORT", "18080").parse().expect("port");
    let idp = MockIdp::start(env("DEVSTACK_IDP_PORT", "18081").parse().expect("idp port"), &["alice", "bob", "mallory"]).await;
    let provider: Value = json!({"issuer": idp.issuer, "audience": idp.client_id, "jwks": idp.jwks()});
    let builder = StackBuilder::new().config(|c| {
        c.domain.listen = format!("127.0.0.1:{port}");
        c.domain.public_url = format!("http://127.0.0.1:{port}");
        c.oidc = vec![serde_json::from_value(provider).expect("oidc provider")];
        c.ui.login = Some(somework_api::ui_session::UiLogin {
            issuer: idp.issuer.clone(),
            client_id: idp.client_id.clone(),
            client_secret: idp.client_secret.clone(),
            ..Default::default()
        });
    });
    let stack = builder.start().await;
    let domain = stack.domain().clone();
    let sys = domain.system_ctx();

    // humans: alice operates, bob is an ordinary human; mallory authenticates at the IdP but is not provisioned
    let alice_key = jws::new_signing_key();
    domain
        .create_principal(
            &sys,
            CreatePrincipal {
                kind: ActorKind::Human,
                id: "alice".into(),
                display_name: Some("Alice (operator)".into()),
                permissions: Some(Permissions::admin()),
                public_key: Some(jws::verifying_key_to_b64(&alice_key.verifying_key())),
                matrix_user_id: None,
                oidc_issuer: Some(idp.issuer.clone()),
                oidc_subject: Some("alice".into()),
            },
        )
        .await
        .expect("alice");
    let bob_key = jws::new_signing_key();
    domain
        .create_principal(
            &sys,
            CreatePrincipal {
                kind: ActorKind::Human,
                id: "bob".into(),
                display_name: Some("Bob".into()),
                permissions: Some(Permissions::default_human()),
                public_key: Some(jws::verifying_key_to_b64(&bob_key.verifying_key())),
                matrix_user_id: None,
                oidc_issuer: Some(idp.issuer.clone()),
                oidc_subject: Some("bob".into()),
            },
        )
        .await
        .expect("bob");

    // agents
    let reviewer = stack
        .worker(
            "agent/reviewer",
            vec![capability("code.review", "2.1", "read", "Review pull requests for correctness and security")],
            Permissions::default_agent(),
        )
        .await;
    let deployer = stack
        .worker(
            "agent/deployer",
            vec![
                capability("deployment.inspect", "1.0", "read", "Inspect a deployment"),
                capability("deployment.execute", "1.0", "irreversible", "Execute a production deployment"),
            ],
            Permissions::default_agent(),
        )
        .await;
    let author_key = stack.create_principal(ActorKind::Agent, "agent/author", Permissions::default_agent()).await;
    let author = Client::assertion(&stack.url, (*author_key).clone(), "agent", "agent/author", &stack.domain_id);

    let mut ids = serde_json::Map::new();

    // A. a conversation between two agents with a notice, an answer and an attached file
    let first = send(&author, "", "chat.message", Some("agent/reviewer"), "Please review PR 729, focus on auth changes.", &[]).await;
    let conv = first["conversationId"].as_str().expect("conversation").to_string();
    send(&reviewer.client, &conv, "chat.notice", None, "working… 40% through the diff", &[]).await;
    let artifact = reviewer.client.upload_artifact("review-notes.txt", "text/plain", "internal", b"No blocking issues found.\n").await.expect("artifact");
    send(
        &reviewer.client,
        &conv,
        "chat.message",
        Some("agent/author"),
        "I ran the tests and everything passed.",
        std::slice::from_ref(&serde_json::to_value(&artifact).unwrap()),
    )
    .await;
    ids.insert("conversation".into(), json!(conv));
    ids.insert("artifactId".into(), json!(artifact.artifact_id));
    domain
        .write({
            let conv = conv.clone();
            let d = domain.clone();
            move |tx| {
                Box::pin(async move {
                    sqlx::query("INSERT INTO transport_mappings(transport, external_id, object_kind, object_id, domain_id, created_at) VALUES ('matrix', '!devroom:example.org', 'conversation', ?, ?, ?)")
                        .bind(&conv)
                        .bind(&d.cfg.domain_id)
                        .bind(d.now_ts())
                        .execute(&mut **tx)
                        .await
                        .map_err(somework_domain::db::db_error)?;
                    Ok(())
                })
            }
        })
        .await
        .expect("matrix mapping");

    // B. a room with agents
    let room = author.post("/v1/conversations", &json!({"kind": "room", "title": "Release 4.2 war room", "members": [{"kind": "agent", "id": "agent/reviewer"}, {"kind": "agent", "id": "agent/deployer"}]})).await.expect("room");
    let room_id = room["conversationId"].as_str().unwrap().to_string();
    send(&author, &room_id, "chat.message", Some("agent/deployer"), "Deploy window opens at 14:00.", &[]).await;
    send(&deployer.client, &room_id, "chat.notice", None, "standing by", &[]).await;
    ids.insert("room".into(), json!(room_id));

    let out = json!({
        "url": stack.url, "idpUrl": idp.issuer, "domainId": stack.domain_id,
        "admin": key_json("service", "root", &stack.admin_key, None),
        "humans": {"alice": key_json("human", "alice", &alice_key, None), "bob": key_json("human", "bob", &bob_key, None)},
        "agents": {"reviewer": agent_json(&reviewer), "deployer": agent_json(&deployer), "author": key_json("agent", "agent/author", &author_key, None)},
        "ids": ids,
    });
    let path = env("DEVSTACK_OUT", "devstack.json");
    std::fs::write(&path, serde_json::to_string_pretty(&out).unwrap()).expect("write credentials");
    println!("devstack ready: console {}/ui/  idp {}  credentials {}", stack.url, idp.issuer, path);
    // keep agent runtimes "online" so availability and runtime counts stay meaningful while the stack runs
    for agent in [&reviewer, &deployer] {
        let client = agent.client.clone();
        tokio::spawn(async move {
            loop {
                let _ = client.runtime_heartbeat().await;
                tokio::time::sleep(Duration::from_secs(10)).await;
            }
        });
    }
    let _keep = (Arc::new(()), &stack, &idp);
    std::future::pending::<()>().await;
}

fn agent_json(a: &Agent) -> Value {
    key_json("agent", &a.id, &a.key, a.client.runtime_instance_id())
}
