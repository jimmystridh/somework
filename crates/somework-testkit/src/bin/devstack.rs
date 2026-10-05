//! Seeded development stack for the operations UI and its Playwright suite.
//!
//! Env: DEVSTACK_PORT (18080), DEVSTACK_IDP_PORT (18081), DEVSTACK_OUT (credentials JSON, default ./devstack.json).
//! Prints the console URL and writes agent/human keys so tests can drive the API alongside the browser.

use std::{sync::Arc, time::Duration};

use serde_json::{Value, json};
use somework_client::Client;
use somework_core::{
    contracts::{ActorKind, SideEffects},
    jws,
};
use somework_domain::{
    auth::CreatePrincipal,
    policy::{DelegationPerm, Permissions},
};
use somework_testkit::{Agent, StackBuilder, capability, oidc::MockIdp, process::repo_root};

fn env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

fn key_json(kind: &str, id: &str, key: &ed25519_dalek::SigningKey, runtime: Option<String>) -> Value {
    json!({"kind": kind, "id": id, "privateKey": jws::signing_key_to_b64(key), "runtimeInstanceId": runtime})
}

fn plan_capability() -> Value {
    json!({
        "id": "plan.change", "version": "1.0", "name": "Plan a change", "description": "Break a change request into reviewable steps and delegate the reviews",
        "inputSchema": {"type": "object"}, "outputSchema": {"type": "object"}, "sideEffects": "write", "tags": ["planning"]
    })
}

fn pack() -> Value {
    json!({
        "objective": "Diagnose and fix the invoice-import regression introduced after commit 61a8d52.",
        "acceptanceCriteria": ["Root cause is identified", "A regression test fails before the fix and passes afterwards"],
        "currentState": {"summary": "Failure isolated to date parsing under the sv-SE locale.", "completed": ["Reproduced the failure"], "remaining": ["Write the regression test"]},
        "facts": [{"statement": "The test reproduces at commit 61a8d52.", "confidence": 1.0, "assertedBy": {"kind": "agent", "id": "agent/author", "domainId": "development"}}],
        "hypotheses": [{"statement": "Process-culture parsing replaced invariant parsing.", "confidence": 0.78}],
        "openQuestions": ["Does credit-note import share the parser?"],
        "requestedContinuation": {"mode": "consultation", "instruction": "Independently verify the hypothesis."},
        "security": {"classification": "internal", "allowedDomains": ["development"], "instructionsTrusted": false},
    })
}

async fn send(client: &Client, conversation: &str, kind: &str, to: Option<&str>, text: &str) {
    let mut body = json!({"type": kind, "conversationId": conversation, "content": {"mediaType": "text/plain", "data": text}});
    if let Some(to) = to {
        body["recipients"] = json!([{"kind": "agent", "id": to}]);
    }
    client.send_message(&body).await.expect("send message");
}

async fn submit(client: &Client, cap: &str, ver: &str, target: Option<&str>) -> somework_client::TaskInfo {
    let mut body = json!({"capability": {"id": cap, "version": ver}, "input": {"repository": "billing/import-service", "commit": "61a8d52"}});
    if let Some(t) = target {
        body["targetAgentId"] = json!(t);
    }
    client.submit_task(&body, None).await.expect("submit task")
}

#[tokio::main]
async fn main() {
    let port: u16 = env("DEVSTACK_PORT", "18080").parse().expect("port");
    let idp = MockIdp::start(env("DEVSTACK_IDP_PORT", "18081").parse().expect("idp port"), &["alice", "bob", "mallory"]).await;
    let provider: Value = json!({"issuer": idp.issuer, "audience": idp.client_id, "jwks": idp.jwks()});
    let builder = StackBuilder::new().config(|c| {
        c.domain.listen = format!("127.0.0.1:{port}");
        c.domain.public_url = format!("http://127.0.0.1:{port}");
        c.domain.max_lease_seconds = 86_400;
        c.domain.lease_seconds = 3_600;
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
    let alice = Client::assertion(&stack.url, alice_key.clone(), "human", "alice", &stack.domain_id);

    // agents
    let reviewer = stack
        .worker("agent/reviewer", vec![capability("code.review", "2.1", "read", "Review pull requests for correctness and security")], reviewer_perms())
        .await;
    let mut deployer_perms = Permissions::default_agent();
    deployer_perms.side_effects_at_most = Some(SideEffects::Irreversible);
    let deployer = stack
        .worker(
            "agent/deployer",
            vec![
                capability("deployment.inspect", "1.0", "read", "Inspect a deployment"),
                capability("deployment.execute", "1.0", "irreversible", "Execute a production deployment"),
            ],
            deployer_perms,
        )
        .await;
    let mut planner_perms = Permissions::default_agent();
    planner_perms.side_effects_at_most = Some(SideEffects::Write);
    planner_perms.capabilities = vec!["code.review".into()];
    planner_perms.actions.push("task.delegate".into());
    planner_perms.delegation = DelegationPerm { allowed: true, max_depth: 3 };
    let planner = stack.worker("agent/planner", vec![plan_capability()], planner_perms).await;

    let mut author_perms = Permissions::default_agent();
    author_perms.side_effects_at_most = Some(SideEffects::Irreversible);
    author_perms.capabilities = vec!["code.review".into(), "deployment.*".into(), "plan.change".into()];
    author_perms.delegation = DelegationPerm { allowed: true, max_depth: 3 };
    let author_key = stack.create_principal(ActorKind::Agent, "agent/author", author_perms).await;
    let author = Client::assertion(&stack.url, (*author_key).clone(), "agent", "agent/author", &stack.domain_id);
    let mut intruder_perms = Permissions::default_agent();
    intruder_perms.discover = vec!["deployment.inspect".into()];
    let intruder_key = stack.create_principal(ActorKind::Agent, "agent/intruder", intruder_perms).await;
    let intruder = Client::assertion(&stack.url, (*intruder_key).clone(), "agent", "agent/intruder", &stack.domain_id);

    let mut ids = serde_json::Map::new();

    // A. succeeded review with conversation, artifact and mixed claims/notices
    let a = submit(&author, "code.review", "2.1", Some("agent/reviewer")).await;
    let conv = a.conversation_id.clone().expect("task conversation");
    send(&author, &conv, "chat.message", Some("agent/reviewer"), "Please review PR 729, focus on auth changes.").await;
    let claim = reviewer.client.claim_task(&a.task_id, Some(3600)).await.expect("claim");
    reviewer.client.progress_task(&a.task_id, &json!({"fencingToken": claim.fencing_token, "message": "reading diff"})).await.expect("progress");
    send(&reviewer.client, &conv, "chat.notice", None, "working… 40% through the diff").await;
    send(&reviewer.client, &conv, "chat.message", Some("agent/author"), "I ran the tests and everything passed.").await;
    let artifact = reviewer
        .client
        .upload_artifact("review-notes.txt", "text/plain", "internal", b"No blocking issues found.\n", Some(&a.task_id))
        .await
        .expect("artifact");
    reviewer.client.complete_task(&a.task_id, claim.fencing_token, &json!({"verdict": "approve"}), std::slice::from_ref(&artifact)).await.expect("complete");
    ids.insert("succeeded".into(), json!(a.task_id));
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

    // B. running
    let b = submit(&author, "code.review", "2.1", Some("agent/reviewer")).await;
    let cb = reviewer.client.claim_task(&b.task_id, Some(86_400)).await.expect("claim");
    reviewer
        .client
        .progress_task(&b.task_id, &json!({"fencingToken": cb.fencing_token, "message": "analysing authentication changes"}))
        .await
        .expect("progress");
    ids.insert("running".into(), json!(b.task_id));

    // C. input_required
    let c = submit(&author, "code.review", "2.1", Some("agent/reviewer")).await;
    let cc = reviewer.client.claim_task(&c.task_id, Some(86_400)).await.expect("claim");
    reviewer
        .client
        .progress_task(&c.task_id, &json!({"fencingToken": cc.fencing_token, "status": "input_required", "question": {"ask": "Which branch should I review?"}}))
        .await
        .expect("input required");
    ids.insert("inputRequired".into(), json!(c.task_id));

    // D. queued, E. failed, F. canceled
    ids.insert("queued".into(), json!(submit(&author, "code.review", "2.1", None).await.task_id));
    let e = submit(&author, "code.review", "2.1", Some("agent/reviewer")).await;
    let ce = reviewer.client.claim_task(&e.task_id, Some(3600)).await.expect("claim");
    reviewer.client.progress_task(&e.task_id, &json!({"fencingToken": ce.fencing_token})).await.expect("progress");
    reviewer
        .client
        .fail_task(
            &e.task_id,
            ce.fencing_token,
            &somework_core::contracts::Failure {
                code: "checkout_failed".into(),
                message: "repository could not be cloned".into(),
                retryable: true,
                details: None,
            },
        )
        .await
        .expect("fail");
    ids.insert("failed".into(), json!(e.task_id));
    let f = submit(&author, "code.review", "2.1", None).await;
    author.cancel_task(&f.task_id, Some("no longer needed")).await.expect("cancel");
    ids.insert("canceled".into(), json!(f.task_id));

    // G. approvals: three pending, one denied (-> rejected)
    let mut pending = vec![];
    for _ in 0..3 {
        let t = submit(&author, "deployment.execute", "1.0", Some("agent/deployer")).await;
        pending.push(json!({"taskId": t.task_id, "approvalId": t.approval_id.clone().expect("approval required")}));
    }
    ids.insert("approvalsPending".into(), json!(pending));
    let denied = submit(&author, "deployment.execute", "1.0", Some("agent/deployer")).await;
    let denied_approval = denied.pending_approval.clone().expect("pending approval");
    alice.post(&format!("/v1/approvals/{}/decision", denied_approval["approvalId"].as_str().unwrap()), &json!({"decision": "denied", "actionDigest": denied_approval["actionDigest"], "taskRevision": denied_approval["taskRevision"], "comment": "outside the change window"})).await.expect("deny");
    ids.insert("rejected".into(), json!(denied.task_id));

    // reconciliation: approved irreversible task whose worker disappears mid-flight
    let mut reconcile = vec![];
    for _ in 0..3 {
        let t = submit(&author, "deployment.execute", "1.0", Some("agent/deployer")).await;
        let p = t.pending_approval.clone().expect("pending approval");
        alice
            .post(
                &format!("/v1/approvals/{}/decision", p["approvalId"].as_str().unwrap()),
                &json!({"decision": "approved", "actionDigest": p["actionDigest"], "taskRevision": p["taskRevision"]}),
            )
            .await
            .expect("approve");
        let claim = deployer.client.claim_task(&t.task_id, Some(1)).await.expect("claim");
        deployer.client.progress_task(&t.task_id, &json!({"fencingToken": claim.fencing_token, "message": "rolling out"})).await.expect("progress");
        reconcile.push(t.task_id);
    }
    for id in &reconcile {
        let mut parked = false;
        for _ in 0..80 {
            let t = author.get_task(id).await.expect("get");
            if t.blocker.as_ref().and_then(|b| b.get("kind")).and_then(Value::as_str) == Some("reconciliation") {
                parked = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(parked, "task {id} never reached reconciliation");
    }
    ids.insert("reconciliation".into(), json!(reconcile));

    // H. delegation tree
    let root = submit_plan(&author).await;
    let cp = planner.client.claim_task(&root, Some(86_400)).await.expect("claim plan");
    planner.client.progress_task(&root, &json!({"fencingToken": cp.fencing_token, "message": "delegating reviews"})).await.expect("progress");
    let mut children = vec![];
    for _ in 0..2 {
        let child = planner
            .client
            .post("/v1/tasks", &json!({"capability": {"id": "code.review", "version": "2.1"}, "input": {"repository": "billing/import-service"}, "parentTaskId": root, "parentFencingToken": cp.fencing_token}))
            .await
            .expect("delegate");
        children.push(child["taskId"].as_str().unwrap().to_string());
    }
    let cr = reviewer.client.claim_task(&children[0], Some(3600)).await.expect("claim child");
    reviewer.client.progress_task(&children[0], &json!({"fencingToken": cr.fencing_token})).await.expect("progress child");
    reviewer.client.complete_task(&children[0], cr.fencing_token, &json!({"verdict": "approve"}), &[]).await.expect("complete child");
    ids.insert("delegationRoot".into(), json!(root));
    ids.insert("delegationChildren".into(), json!(children));

    // I. a policy denial: the intruder may see deployment.inspect but not invoke it
    let denied_submit = intruder
        .submit_task(&json!({"capability": {"id": "deployment.inspect", "version": "1.0"}, "input": {"repository": "billing/import-service"}}), None)
        .await;
    assert!(denied_submit.is_err(), "intruder submit must be denied");

    // J. context pack offered for consultation
    let record = author.post("/v1/context-packs", &pack()).await.expect("context pack");
    let (pid, pver) = (record["contextPackId"].as_str().unwrap().to_string(), record["version"].as_u64().unwrap());
    author
        .post(
            &format!("/v1/context-packs/{pid}/{pver}/offer"),
            &json!({"to": {"kind": "agent", "id": "agent/reviewer"}, "mode": "consultation", "sections": ["facts", "hypotheses", "currentState"]}),
        )
        .await
        .expect("offer");
    ids.insert("contextPack".into(), json!({"id": pid, "version": pver}));

    // K. a room with agents and a human conversation
    let room = author.post("/v1/conversations", &json!({"kind": "room", "title": "Release 4.2 war room", "members": [{"kind": "agent", "id": "agent/reviewer"}, {"kind": "agent", "id": "agent/deployer"}]})).await.expect("room");
    let room_id = room["conversationId"].as_str().unwrap().to_string();
    send(&author, &room_id, "chat.message", Some("agent/deployer"), "Deploy window opens at 14:00.").await;
    send(&deployer.client, &room_id, "chat.notice", None, "standing by").await;
    ids.insert("room".into(), json!(room_id));

    let out = json!({
        "url": stack.url, "idpUrl": idp.issuer, "domainId": stack.domain_id,
        "admin": key_json("service", "root", &stack.admin_key, None),
        "humans": {"alice": key_json("human", "alice", &alice_key, None), "bob": key_json("human", "bob", &bob_key, None)},
        "agents": {
            "reviewer": agent_json(&reviewer), "deployer": agent_json(&deployer), "planner": agent_json(&planner),
            "author": key_json("agent", "agent/author", &author_key, None),
        },
        "ids": ids,
    });
    let path = env("DEVSTACK_OUT", "devstack.json");
    std::fs::write(&path, serde_json::to_string_pretty(&out).unwrap()).expect("write credentials");
    println!("devstack ready: console {}/ui/  idp {}  credentials {}", stack.url, idp.issuer, path);
    // keep worker runtimes "online" so availability and runtime counts stay meaningful while the stack runs
    for worker in [&reviewer, &deployer, &planner] {
        let client = worker.client.clone();
        tokio::spawn(async move {
            loop {
                let _ = client.runtime_heartbeat().await;
                tokio::time::sleep(Duration::from_secs(10)).await;
            }
        });
    }
    let _ = repo_root();
    let _keep = (Arc::new(()), &stack, &idp);
    std::future::pending::<()>().await;
}

fn reviewer_perms() -> Permissions {
    let mut p = Permissions::default_agent();
    p.side_effects_at_most = Some(SideEffects::Read);
    p
}

fn agent_json(a: &Agent) -> Value {
    key_json("agent", &a.id, &a.key, a.client.runtime_instance_id())
}

async fn submit_plan(author: &Client) -> String {
    let t = author
        .submit_task(
            &json!({"capability": {"id": "plan.change", "version": "1.0"}, "targetAgentId": "agent/planner", "input": {"change": "migrate invoice import"}}),
            None,
        )
        .await
        .expect("plan");
    t.task_id
}
