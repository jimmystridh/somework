mod nats_common;

use std::time::Duration;

use nats_common::*;
use serde_json::json;
use somework_testkit::process::eventually;

#[tokio::test]
async fn presence_signals_refresh_registered_runtimes_only() {
    let env = start_env().await;
    let worker = reviewer(&env.stack, "agent/reviewer").await;
    let runtime = worker.client.runtime_instance_id().unwrap();
    let conn = connect_agent(&worker).await;
    let last_seen = || async {
        let v = env.stack.admin.get("/v1/runtimes?agentId=agent%2Freviewer").await.unwrap();
        v["runtimes"].as_array().unwrap().iter().find(|r| r["runtimeInstanceId"] == runtime.as_str()).unwrap()["lastSeenAt"].as_str().unwrap().to_string()
    };
    let before = last_seen().await;
    let subject = somework_core::subjects::presence("agent/reviewer");
    eventually("presence refresh", Duration::from_secs(10), || async {
        conn.client.publish(subject.clone(), json!({"agentId": "agent/reviewer", "runtimeInstanceId": runtime}).to_string().into()).await.unwrap();
        conn.client.flush().await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        (last_seen().await > before).then_some(())
    })
    .await;
    env.stack.stop().await;
}

#[tokio::test]
async fn consumer_lag_is_exposed_on_the_metrics_endpoint() {
    let env = start_env().await;
    let worker = reviewer(&env.stack, "agent/reviewer").await;
    let author = env.stack.requester("agent/author").await;
    drop(connect_agent(&worker).await);
    for n in 0..5 {
        author.client.send_message(&hello("agent/reviewer", &format!("message {n}"))).await.unwrap();
    }
    let lag = eventually("inbox consumer lag >= 5", Duration::from_secs(15), || async {
        let text = reqwest::get(format!("{}/metrics", env.stack.url)).await.ok()?.text().await.ok()?;
        text.lines()
            .find(|l| l.starts_with("somework_jetstream_consumer_lag{") && l.contains("SOMEWORK_INBOX") && l.contains("inbox_agent~2freviewer"))?
            .rsplit(' ')
            .next()?
            .parse::<f64>()
            .ok()
            .filter(|v| *v >= 5.0)
    })
    .await;
    assert!(lag >= 5.0);
    env.stack.stop().await;
}
