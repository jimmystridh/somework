mod matrix_common;

use std::time::Duration;

use matrix_common::*;
use serde_json::json;
use somework_core::contracts::SideEffects;
use somework_testkit::process::eventually;

/// Acceptance: "Humans can follow task request, progress, requests for input and completion in a readable
/// room/thread", with the structured custom events carrying resolvable canonical references.
#[tokio::test]
async fn task_is_followable_in_a_room_thread_with_structured_events() {
    let env = MxEnv::start().await;
    let worker = env.stack.worker("agent/reviewer", vec![review_cap()], worker_perms(SideEffects::Read)).await;
    let author = env.stack.requester("agent/author", &["code.review"], SideEffects::Read).await;
    let alice = env.human("alice", "@alice:hs.test", human_perms()).await;

    let conversation = env.conversation(&author, "PR 729 review", &[("human", "alice")], None).await;
    let task = author
        .client
        .submit_task(
            &json!({"capability": {"id": "code.review", "version": "2.1"}, "conversationId": conversation, "input": {"repository": "billing/import-service"}}),
            None,
        )
        .await
        .unwrap();

    let room = env.wait_room("PR 729 review").await;
    assert!(env.mx.members(&room).iter().any(|(u, _)| u == "@alice:hs.test"), "the mapped human is invited to the room");
    env.mx.join_invites("@alice:hs.test");

    let root = eventually_events(&env.mx, &room, "task root", |e| {
        e.content["dev.somework.ref"]["id"] == task.task_id.as_str() && e.content["dev.somework.ref"]["type"] == "task"
    })
    .await;
    assert_eq!(root.content["msgtype"], "m.notice");
    assert!(root.body().contains(&task.task_id));

    let claim = worker.client.claim_task(&task.task_id, Some(30)).await.unwrap();
    worker.client.progress_task(&task.task_id, &json!({"fencingToken": claim.fencing_token, "message": "reading the diff"})).await.unwrap();
    worker.client.progress_task(&task.task_id, &json!({"fencingToken": claim.fencing_token, "status": "input_required", "question": {"ask": "which branch?"}, "message": "need the target branch"})).await.unwrap();

    // the supervising human answers inside the thread; the bridge acts as alice, so policy applies to her
    eventually_events(&env.mx, &room, "input_required notice", |e| e.body().contains("need the target branch")).await;
    env.mx.user_send_in_thread(&room, "@alice:hs.test", "!input {\"branch\": \"main\"}", &root.event_id);
    eventually("task resumes after Matrix input", Duration::from_secs(10), || async {
        (author.client.get_task(&task.task_id).await.unwrap().state.as_str() == "running").then_some(())
    })
    .await;

    worker.client.complete_task(&task.task_id, claim.fencing_token, &json!({"verdict": "approve"}), &[]).await.unwrap();
    eventually("completion projected", Duration::from_secs(10), || async {
        env.mx.thread_children(&room, &root.event_id).into_iter().find(|e| e.kind == "dev.somework.task.v1" && e.content["state"] == "succeeded")
    })
    .await;

    let structured: Vec<_> = env.mx.thread_children(&room, &root.event_id).into_iter().filter(|e| e.kind == "dev.somework.task.v1").collect();
    let states: Vec<&str> = structured.iter().map(|e| e.content["state"].as_str().unwrap()).collect();
    for expected in ["queued", "claimed", "running", "input_required", "succeeded"] {
        assert!(states.contains(&expected), "{expected} missing in {states:?}");
    }
    let first = &structured[0];
    assert_eq!(first.content["schema_version"], "1.0");
    assert_eq!(first.content["m.relates_to"]["rel_type"], "m.thread");
    assert_eq!(first.content["m.relates_to"]["is_falling_back"], true);
    assert_eq!(first.content["m.relates_to"]["m.in_reply_to"]["event_id"], root.event_id.as_str());

    // canonical_ref resolves to the platform's task, so Matrix is a view and not the source of truth
    let canonical = structured.last().unwrap().content["canonical_ref"].as_str().unwrap();
    let id = canonical.strip_prefix("somework://tasks/").unwrap();
    assert_eq!(author.client.get_task(id).await.unwrap().state.as_str(), "succeeded");

    // companion notices are m.notice (non-triggering for bots) and carry a task reference with the revision
    let notices: Vec<_> = env
        .mx
        .thread_children(&room, &root.event_id)
        .into_iter()
        .filter(|e| e.content["msgtype"] == "m.notice" && e.content["dev.somework.ref"]["type"] == "task")
        .collect();
    assert!(notices.len() >= 4);
    assert!(notices.iter().all(|e| e.content["dev.somework.ref"]["revision"].is_number() || e.body().starts_with("Progress")));
    let _ = alice;
    env.stack.stop().await;
}

/// Spec: live progress is throttled (<= 1 update per 750 ms) and edits one event instead of flooding the timeline.
#[tokio::test]
async fn progress_updates_are_throttled_into_edits_of_one_notice() {
    let env = MxEnv::start().await;
    let worker = env.stack.worker("agent/reviewer", vec![review_cap()], worker_perms(SideEffects::Read)).await;
    let author = env.stack.requester("agent/author", &["code.review"], SideEffects::Read).await;
    let task = author.client.submit_task(&json!({"capability": {"id": "code.review", "version": "2.1"}, "input": {"repository": "r"}}), None).await.unwrap();
    let claim = worker.client.claim_task(&task.task_id, Some(60)).await.unwrap();

    let started = std::time::Instant::now();
    for i in 0..30 {
        worker.client.progress_task(&task.task_id, &json!({"fencingToken": claim.fencing_token, "message": format!("step {i}")})).await.unwrap();
    }
    let burst = started.elapsed();

    let room = eventually("task room", Duration::from_secs(10), || async {
        env.mx.rooms().into_iter().find(|r| !env.mx.events_of_type(r, "m.room.message").is_empty())
    })
    .await;
    eventually("latest progress visible", Duration::from_secs(15), || async {
        env.mx.events(&room).into_iter().rev().find(|e| e.content["m.new_content"]["body"] == "Progress: step 29")
    })
    .await;
    let progress: Vec<_> =
        env.mx.events(&room).into_iter().filter(|e| e.body().contains("Progress") || e.content["m.relates_to"]["rel_type"] == "m.replace").collect();
    let edits = progress.iter().filter(|e| e.content["m.relates_to"]["rel_type"] == "m.replace").count();
    let originals = progress.iter().filter(|e| e.body().starts_with("Progress")).count();
    assert_eq!(originals, 1, "one progress notice per task");
    let allowed = (started.elapsed().as_millis() / 750 + 2) as usize;
    assert!(edits <= allowed, "{edits} edits in {:?} (burst {burst:?}) exceeds the 750 ms throttle", started.elapsed());
    assert!(edits < 30, "progress was not coalesced");
    env.stack.stop().await;
}

/// Agent identities appear as Application Service virtual users with their own display names.
#[tokio::test]
async fn agents_are_virtual_users_in_the_exclusive_namespace() {
    let env = MxEnv::start().await;
    let worker = env.stack.worker("agent/reviewer", vec![review_cap()], worker_perms(SideEffects::Read)).await;
    let alice = env.human("alice", "@alice:hs.test", human_perms()).await;
    let conversation = {
        let v = alice
            .client
            .post("/v1/conversations", &json!({"kind": "room", "title": "Review chat", "members": [{"kind": "agent", "id": "agent/reviewer"}]}))
            .await
            .unwrap();
        v["conversationId"].as_str().unwrap().to_string()
    };
    worker.client.send_message(&json!({"conversationId": conversation, "content": {"mediaType": "text/plain", "data": "Hello from the reviewer"}, "recipients": [{"kind": "human", "id": "alice"}]})).await.unwrap();
    let room = env.wait_room("Review chat").await;
    let said = eventually_events(&env.mx, &room, "agent chat", |e| e.body() == "Hello from the reviewer").await;
    assert_eq!(said.sender, "@_agent_agent=2freviewer:hs.test");
    assert_eq!(said.content["msgtype"], "m.text");
    assert_eq!(env.mx.display_name(&said.sender).as_deref(), Some("agent/reviewer"));
    env.stack.stop().await;
}
