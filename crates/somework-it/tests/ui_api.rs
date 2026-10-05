use reqwest::{Client as Http, StatusCode};
use serde_json::{Value, json};
use somework_core::{contracts::SideEffects, jws};
use somework_testkit::{Stack, StackBuilder, capability};

async fn dev_stack() -> Stack {
    StackBuilder::new().config(|c| c.ui.dev_token_login = true).start().await
}

fn token(stack: &Stack, kind: &str, id: &str, key: &ed25519_dalek::SigningKey) -> String {
    jws::mint_assertion(key, &format!("{kind}:{id}"), &format!("somework:{}", stack.domain_id), None, chrono::Utc::now(), chrono::Duration::minutes(5))
}

async fn session_cookie(http: &Http, stack: &Stack, bearer: &str) -> (String, String) {
    let resp = http.post(format!("{}/ui/dev-login", stack.url)).json(&json!({"token": bearer})).send().await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let cookie = resp.headers().get("set-cookie").unwrap().to_str().unwrap().to_string();
    assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"), "{cookie}");
    let csrf = resp.json::<Value>().await.unwrap()["csrf"].as_str().unwrap().to_string();
    (cookie.split(';').next().unwrap().to_string(), csrf)
}

#[tokio::test]
async fn dev_token_login_is_off_unless_configured() {
    let stack = Stack::start().await;
    let http = Http::new();
    let resp = http.post(format!("{}/ui/dev-login", stack.url)).json(&json!({"token": "x"})).send().await.unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    let cfg: Value = http.get(format!("{}/ui/config.json", stack.url)).send().await.unwrap().json().await.unwrap();
    assert_eq!(cfg["devTokenLogin"], false);
    assert_eq!(cfg["oidcLogin"], false);
    stack.stop().await;
}

#[tokio::test]
async fn sessions_are_cookie_bound_csrf_protected_and_reflect_the_principal() {
    let stack = dev_stack().await;
    let http = Http::new();
    let (cookie, csrf) = session_cookie(&http, &stack, &token(&stack, "service", "root", &stack.admin_key)).await;

    let session: Value = http.get(format!("{}/ui/session", stack.url)).header("cookie", &cookie).send().await.unwrap().json().await.unwrap();
    assert_eq!(session["authenticated"], true);
    assert_eq!(session["operator"], true);
    assert_eq!(session["csrf"], csrf);

    let get = http.get(format!("{}/v1/admin/overview", stack.url)).header("cookie", &cookie).send().await.unwrap();
    assert_eq!(get.status(), StatusCode::OK);
    let forged = http.post(format!("{}/v1/admin/maintenance", stack.url)).header("cookie", &cookie).json(&json!({})).send().await.unwrap();
    assert_eq!(forged.status(), StatusCode::FORBIDDEN, "missing CSRF header must be refused");
    let wrong = http
        .post(format!("{}/v1/admin/maintenance", stack.url))
        .header("cookie", &cookie)
        .header("x-somework-csrf", "nope")
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), StatusCode::FORBIDDEN);
    let good = http
        .post(format!("{}/v1/admin/maintenance", stack.url))
        .header("cookie", &cookie)
        .header("x-somework-csrf", &csrf)
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(good.status(), StatusCode::OK);

    let anonymous: Value = http.get(format!("{}/ui/session", stack.url)).send().await.unwrap().json().await.unwrap();
    assert_eq!(anonymous["authenticated"], false);
    stack.stop().await;
}

#[tokio::test]
async fn operator_read_models_are_closed_to_ordinary_principals() {
    let stack = dev_stack().await;
    let worker = stack
        .worker("agent/reviewer", vec![capability("code.review", "2.1", "read", "Review pull requests")], somework_domain::policy::Permissions::default_agent())
        .await;
    let author = stack.requester("agent/author", &["code.review"], SideEffects::Read).await;
    author.client.submit_task(&json!({"capability": {"id": "code.review", "version": "2.1"}, "input": {"repository": "r"}}), None).await.unwrap();
    // an attempt that policy refuses leaves a denial for the decisions view
    let denied = worker.client.submit_task(&json!({"capability": {"id": "code.review", "version": "2.1"}, "input": {"repository": "r"}}), None).await;
    assert!(denied.is_err());

    for path in [
        "/v1/admin/policy-decisions",
        "/v1/admin/conversations",
        "/v1/admin/catalog",
        "/v1/admin/context-packs",
        "/v1/admin/artifacts",
        "/v1/admin/overview",
        "/v1/admin/audit",
    ] {
        for (who, client) in [("worker", &worker.client), ("requester", &author.client)] {
            let err = client.get(path).await.expect_err(&format!("{who} must not read {path}"));
            assert_eq!(err.status, 403, "{who} {path}");
        }
    }

    let decisions = stack.admin.get("/v1/admin/policy-decisions?decision=deny").await.unwrap();
    assert!(decisions["decisions"].as_array().unwrap().iter().any(|d| d["actor"] == "agent:agent/reviewer"));
    let conversations = stack.admin.get("/v1/admin/conversations").await.unwrap();
    assert_eq!(conversations["conversations"].as_array().unwrap().len(), 1);
    let catalog = stack.admin.get("/v1/admin/catalog").await.unwrap();
    assert_eq!(catalog["entries"][0]["agentCard"]["agentId"], "agent/reviewer");
    stack.stop().await;
}

#[tokio::test]
async fn static_console_is_served_with_its_modules() {
    let stack = Stack::start().await;
    let http = Http::new();
    let index = http.get(format!("{}/ui/", stack.url)).send().await.unwrap();
    assert_eq!(index.status(), StatusCode::OK);
    assert!(index.text().await.unwrap().contains("SomeWork Console"));
    let module = http.get(format!("{}/ui/js/app.js", stack.url)).send().await.unwrap();
    assert_eq!(module.status(), StatusCode::OK);
    stack.stop().await;
}
