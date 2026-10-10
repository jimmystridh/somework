mod nats_common;

use std::time::Duration;

use nats_common::*;
use somework_testkit::process::eventually;

#[tokio::test]
async fn offline_agent_receives_its_durable_inbox_after_reconnect() {
    let env = start_env().await;
    let sleeper = reviewer(&env.stack, "agent/sleeper").await;
    let author = env.stack.requester("agent/author").await;
    // make sure the inbox consumer exists before the agent ever connects (it is provisioned from the directory)
    let first = connect_agent(&sleeper).await;
    drop(first);

    let first = author.client.send_message(&hello("agent/sleeper", "please look at PR 729")).await.unwrap();
    let second = author.client.send_message(&hello("agent/sleeper", "and PR 730")).await.unwrap();

    // the agent was offline when both were sent; on reconnect both are waiting, in order
    let back = connect_agent(&sleeper).await;
    let inbox = back.inbox_consumer().await;
    let items = eventually("both directed messages in the durable inbox", Duration::from_secs(10), || async {
        let items = drain(&inbox, Duration::from_millis(700)).await;
        (items.len() >= 2).then_some(items)
    })
    .await;
    assert!(items.iter().all(|i| i["kind"] == "message" && i["messageType"] == "chat.message" && i["wake"] == true), "{items:?}");
    assert_eq!(items[0]["messageId"], first["messageId"]);
    assert_eq!(items[1]["messageId"], second["messageId"]);
    env.stack.stop().await;
}

#[tokio::test]
async fn nats_outage_keeps_accepting_messages_and_delivers_after_restoration() {
    let mut env = start_env().await;
    let worker = reviewer(&env.stack, "agent/reviewer").await;
    let author = env.stack.requester("agent/author").await;
    drop(connect_agent(&worker).await);
    wait_outbox_empty(&env.stack, "nats").await;

    env.nats.stop();
    let mut ids = vec![];
    for n in 0..3 {
        let sent = author.client.send_message(&hello("agent/reviewer", &format!("message {n}"))).await.expect("sending is canonical even while NATS is down");
        ids.push(sent["messageId"].as_str().unwrap().to_string());
    }
    assert!(outbox_pending(&env.stack, "nats").await >= 3, "notifications wait in the outbox");

    env.nats.restart().await;
    wait_outbox_empty(&env.stack, "nats").await;
    let conn = connect_agent(&worker).await;
    let inbox = conn.inbox_consumer().await;
    let mut seen = vec![];
    while let Some((msg, payload)) = next_message(&inbox, Duration::from_secs(5)).await {
        msg.ack().await.ok();
        seen.push(payload["messageId"].as_str().unwrap().to_string());
        if seen.len() == 3 {
            break;
        }
    }
    assert_eq!(seen, ids, "delivered in the order they were sent");
    env.stack.stop().await;
}

#[tokio::test]
async fn jetstream_state_loss_is_repaired_and_unread_messages_stay_readable() {
    let mut env = start_env().await;
    let worker = reviewer(&env.stack, "agent/reviewer").await;
    let author = env.stack.requester("agent/author").await;
    drop(connect_agent(&worker).await);
    let lost = author.client.send_message(&hello("agent/reviewer", "sent before the broker lost its state")).await.unwrap();
    wait_outbox_empty(&env.stack, "nats").await;

    env.nats.stop();
    env.nats.wipe_store();
    env.nats.restart().await;

    // streams and consumers come back through the reconciler; the wake that was lost with the store is not republished, but the
    // message itself is canonical and an agent that sweeps its inbox finds it
    let conn = eventually("inbox consumer re-provisioned", Duration::from_secs(20), || async {
        let info = worker.client.get("/v1/connection").await.ok()?;
        let n = &info["nats"];
        let client = async_nats::connect_with_options(
            n["url"].as_str()?,
            async_nats::ConnectOptions::with_user_and_password(n["user"].as_str()?.into(), n["password"].as_str()?.into()),
        )
        .await
        .ok()?;
        let js = async_nats::jetstream::new(client);
        let stream = js.get_stream(n["inboxStream"].as_str()?).await.ok()?;
        stream.get_consumer::<async_nats::jetstream::consumer::pull::Config>(n["inboxConsumer"].as_str()?).await.ok()
    })
    .await;
    let unread = worker.client.get("/v1/inbox?unread=true").await.unwrap();
    assert_eq!(unread["messages"][0]["messageId"], lost["messageId"]);

    let fresh = author.client.send_message(&hello("agent/reviewer", "sent after the repair")).await.unwrap();
    let (msg, payload) = next_message(&conn, Duration::from_secs(10)).await.expect("new messages flow again");
    msg.ack().await.ok();
    assert_eq!(payload["messageId"], fresh["messageId"]);
    env.stack.stop().await;
}
