use std::{borrow::Cow, sync::Arc};

use chrono::{TimeZone, Utc};
use somework_core::clock::ManualClock;
use somework_domain::{Domain, config::DomainConfig, db::MIGRATOR, messages::SendMessage, rules::RuleSpec};
use sqlx::{
    Connection, SqliteConnection,
    migrate::Migrator,
    sqlite::{SqliteConnectOptions, SqliteJournalMode},
};
use tempfile::TempDir;

const KEPT_ENVELOPE: &str = r#"{"schemaVersion":"1.0","messageId":"msg_keep","type":"chat.message","sender":{"kind":"agent","id":"agent/a","domainId":"development"},"recipients":[{"kind":"agent","id":"agent/b","domainId":"development"}],"domainId":"development","conversationId":"conv_1","createdAt":"2026-10-01T00:00:00.000Z","triggerMode":"directed","content":{"mediaType":"text/plain","data":"hello"}}"#;

const DATA: &[&str] = &[
    "INSERT INTO domains(domain_id, kind, display_name, created_at) VALUES ('development', 'local', 'development', '2026-10-01T00:00:00.000Z')",
    "INSERT INTO principals(principal_id, domain_id, kind, external_id, permissions, created_at) VALUES ('prn_a', 'development', 'agent', 'agent/a', '{\"actions\":[\"message.send\",\"message.read\"]}', '2026-10-01T00:00:00.000Z'), ('prn_b', 'development', 'agent', 'agent/b', '{}', '2026-10-01T00:00:00.000Z')",
    "INSERT INTO conversations(conversation_id, domain_id, kind, created_by, task_id, created_at) VALUES ('conv_1', 'development', 'dm', 'prn_a', NULL, '2026-10-01T00:00:00.000Z'), ('conv_task', 'development', 'task', 'prn_a', 'task_1', '2026-10-01T00:00:00.000Z')",
    "INSERT INTO conversation_members(conversation_id, principal_id, joined_at) VALUES ('conv_1', 'prn_a', '2026-10-01T00:00:00.000Z'), ('conv_1', 'prn_b', '2026-10-01T00:00:00.000Z')",
    "INSERT INTO tasks(task_id, domain_id, conversation_id, capability_id, capability_version, side_effects, capability_snapshot, requester, requester_principal_id, state, revision, input, created_at, updated_at)
       VALUES ('task_1', 'development', 'conv_task', 'code.review', '1', 'read', '{}', '{}', 'prn_a', 'queued', 1, '{}', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')",
    "INSERT INTO task_events(task_id, event_sequence, event_id, type, revision, actor, created_at) VALUES ('task_1', 1, 'evt_t1', 'task.queued', 1, 'agent:a', '2026-10-01T00:00:00.000Z')",
    "INSERT INTO approvals(approval_id, domain_id, task_id, task_revision, action_digest, action, requested_by, expires_at, created_at) VALUES ('appr_1', 'development', 'task_1', 1, 'd', 'deploy', 'agent:a', '2026-10-02T00:00:00.000Z', '2026-10-01T00:00:00.000Z')",
    "INSERT INTO messages(message_id, domain_id, conversation_id, task_id, type, sender_principal_id, trigger_mode, envelope, content_digest, created_at)
       VALUES ('msg_keep', 'development', 'conv_1', NULL, 'chat.message', 'prn_a', 'directed', json('{KEPT}'), 'd', '2026-10-01T00:00:00.000Z'),
              ('msg_task', 'development', 'conv_task', 'task_1', 'task.request', 'prn_a', 'task-state', '{}', 'd', '2026-10-01T00:00:00.000Z'),
              ('msg_status', 'development', 'conv_1', NULL, 'task.status', 'prn_a', 'never', '{}', 'd', '2026-10-01T00:00:00.000Z'),
              ('msg_artifact', 'development', 'conv_1', NULL, 'chat.message', 'prn_a', 'directed', '{\"artifacts\":[{\"sourceTaskId\":\"task_1\"}]}', 'd', '2026-10-01T00:00:00.000Z')",
    "INSERT INTO message_deliveries(message_id, principal_id) VALUES ('msg_keep', 'prn_b'), ('msg_task', 'prn_b'), ('msg_status', 'prn_b'), ('msg_artifact', 'prn_b')",
    "INSERT INTO artifacts(artifact_id, version, domain_id, status, media_type, declared_size, declared_digest, classification, created_by, created_by_principal_id, source_task_id, storage_key, created_at)
       VALUES ('art_1', 1, 'development', 'complete', 'text/plain', 1, 'd', 'internal', '{}', 'prn_a', 'task_1', 'k', '2026-10-01T00:00:00.000Z')",
    "INSERT INTO context_packs(context_pack_id, version, domain_id, manifest, digest, classification, created_by, size_bytes, created_at) VALUES ('ctxp_1', 1, 'development', '{}', 'd', 'internal', 'prn_a', 2, '2026-10-01T00:00:00.000Z')",
    "INSERT INTO context_offers(offer_id, domain_id, context_pack_id, version, from_principal_id, to_principal_id, mode, created_at) VALUES ('offer_1', 'development', 'ctxp_1', 1, 'prn_a', 'prn_b', 'subtask', '2026-10-01T00:00:00.000Z')",
    "INSERT INTO auth_grants(jti, domain_id, subject_principal_id, task_id, claims, issued_at, expires_at) VALUES ('jti_1', 'development', 'prn_a', 'task_1', '{}', '2026-10-01T00:00:00.000Z', '2026-10-01T00:15:00.000Z')",
    "INSERT INTO federation_peers(peer_domain_id, display_name, created_at, updated_at) VALUES ('peer', 'Peer', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')",
    "INSERT INTO federated_tasks(internal_task_id, direction, created_at, updated_at) VALUES ('task_1', 'egress', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')",
    "INSERT INTO a2a_credentials(origin, scheme, secret_sealed, created_at) VALUES ('https://remote.example', 'bearer', 'x', '2026-10-01T00:00:00.000Z')",
    "INSERT INTO events(event_id, domain_id, type, task_id, revision, payload, created_at) VALUES ('evt_task', 'development', 'task.queued', 'task_1', 1, '{}', '2026-10-01T00:00:00.000Z'), ('evt_msg', 'development', 'message.created', NULL, NULL, '{}', '2026-10-01T00:00:00.000Z')",
    "INSERT INTO event_recipients(event_seq, principal_id, wake) VALUES (1, 'prn_b', 1), (2, 'prn_b', 0)",
    "INSERT INTO outbox_events(event_seq, domain_id, sink, subject, dedupe_key, payload, next_attempt_at, created_at)
       VALUES (1, 'development', 'nats', 'somework.work.pool.agent~2fb', 'k1', '{}', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
              (1, 'development', 'reaction', 'reaction.pr-review', 'k2', '{}', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
              (2, 'development', 'nats', 'somework.inbox.agent~2fb', 'k3', '{}', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')",
    "INSERT INTO subscriptions(subscription_id, domain_id, principal_id, kind, selector, wake, created_at) VALUES
       ('sub_topic', 'development', 'prn_b', 'topic', 'github.*', 1, '2026-10-01T00:00:00.000Z'),
       ('sub_task', 'development', 'prn_a', 'task', 'task_1', 1, '2026-10-01T00:00:00.000Z'),
       ('sub_queue', 'development', 'prn_b', 'capability_queue', 'code.review', 1, '2026-10-01T00:00:00.000Z')",
    "INSERT INTO rules(domain_id, rule_name, subscription_id, owner_principal_id, owner, description, reaction, fired, created_at, updated_at)
       VALUES ('development', 'pr-review', 'sub_topic', 'prn_b', 'agent/b', 'review', '{\"capability\":{\"id\":\"code.review\",\"version\":\"1\"}}', 3, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')",
    "INSERT INTO reaction_firings(domain_id, rule_name, event_id, event_seq, depth, created_at) VALUES ('development', 'pr-review', 'evt_task', 1, 0, '2026-10-01T00:00:00.000Z')",
    "INSERT INTO policy_decisions(decision_id, domain_id, occurred_at, actor, action, decision, policy_version, task_id) VALUES ('pol_1', 'development', '2026-10-01T00:00:00.000Z', 'agent:a', 'task.submit', 'allow', 'builtin-1', 'task_1')",
    "INSERT INTO audit_events(audit_event_id, domain_id, occurred_at, authenticated_actor, action, task_id, outcome, prev_hash, hash) VALUES ('aud_1', 'development', '2026-10-01T00:00:00.000Z', 'agent:a', 'task.submit', 'task_1', 'success', 'p', 'h')",
];

async fn database_at_0500(dir: &TempDir) -> std::path::PathBuf {
    let path = dir.path().join("somework.db");
    let options = SqliteConnectOptions::new().filename(&path).create_if_missing(true).journal_mode(SqliteJournalMode::Wal).foreign_keys(true);
    let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
    let old = Migrator { migrations: Cow::Owned(MIGRATOR.migrations.iter().filter(|m| m.version <= 500).cloned().collect()), ..Migrator::DEFAULT };
    old.run(&mut conn).await.unwrap();
    for statement in DATA {
        let statement = statement.replace("{KEPT}", &KEPT_ENVELOPE.replace('\'', "''"));
        sqlx::query(sqlx::AssertSqlSafe(statement.clone())).execute(&mut conn).await.unwrap_or_else(|e| panic!("{e}: {statement}"));
    }
    conn.close().await.unwrap();
    path
}

#[tokio::test]
async fn the_task_tables_are_dropped_and_everything_else_that_is_still_valid_survives() {
    let dir = TempDir::new().unwrap();
    let path = database_at_0500(&dir).await;
    let mut cfg = DomainConfig::new("development", &path);
    cfg.db_synchronous_full = false;
    cfg.master_key = Some(somework_domain::secrets::MasterKey::generate().to_b64());
    let clock = ManualClock::new(Utc.with_ymd_and_hms(2026, 10, 10, 12, 0, 0).unwrap());
    let domain = Domain::open_with_clock(cfg, Arc::new(clock)).await.unwrap();
    let pool = domain.db.pool();

    for table in [
        "tasks",
        "task_events",
        "approvals",
        "context_packs",
        "context_offers",
        "auth_grants",
        "federation_peers",
        "federated_tasks",
        "a2a_credentials",
        "reaction_firings",
    ] {
        let present: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?").bind(table).fetch_one(pool).await.unwrap();
        assert_eq!(present, 0, "{table} is gone");
    }
    let triggers: Vec<String> = sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").fetch_all(pool).await.unwrap();
    assert!(!triggers.iter().any(|t| t.contains("task") || t.contains("context")), "{triggers:?}");

    let messages: Vec<String> = sqlx::query_scalar("SELECT message_id FROM messages ORDER BY seq").fetch_all(pool).await.unwrap();
    assert_eq!(messages, ["msg_keep"], "messages of tasks, approvals and task-bound attachments cannot be read any more and are removed");
    let deliveries: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM message_deliveries").fetch_one(pool).await.unwrap();
    assert_eq!(deliveries, 1);
    let page = domain.list_messages(&domain.system_ctx(), "conv_1", 0, 10).await.unwrap();
    assert_eq!(page.messages.len(), 1);
    assert_eq!(page.messages[0].envelope.content.data, "hello");

    let kinds: Vec<String> = sqlx::query_scalar("SELECT kind FROM subscriptions WHERE status = 'active' OR status IS NOT NULL").fetch_all(pool).await.unwrap();
    assert_eq!(kinds, ["topic"], "subscriptions to tasks and capability queues are removed");
    let rules = domain.list_rules(&domain.system_ctx()).await.unwrap();
    assert_eq!(rules.len(), 1);
    assert_eq!((rules[0].name.as_str(), rules[0].owner.as_str(), rules[0].selector.as_str()), ("pr-review", "agent/b", "github.*"));
    let rule_columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('rules')").fetch_all(pool).await.unwrap();
    assert!(!rule_columns.iter().any(|c| c == "reaction" || c.starts_with("skipped_") || c == "fired"), "{rule_columns:?}");

    let artifact_columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('artifacts')").fetch_all(pool).await.unwrap();
    assert!(!artifact_columns.iter().any(|c| c == "source_task_id"));
    let artifacts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM artifacts WHERE artifact_id = 'art_1'").fetch_one(pool).await.unwrap();
    assert_eq!(artifacts, 1, "artifacts stay");

    let events: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM events").fetch_one(pool).await.unwrap();
    assert_eq!(events, 2, "the event history stays");
    let outbox: Vec<(String, String)> = sqlx::query_as("SELECT subject, status FROM outbox_events ORDER BY id").fetch_all(pool).await.unwrap();
    assert_eq!(
        outbox,
        [
            ("somework.work.pool.agent~2fb".to_string(), "skipped".to_string()),
            ("reaction.pr-review".to_string(), "skipped".to_string()),
            ("somework.inbox.agent~2fb".to_string(), "pending".to_string())
        ],
        "notifications of work that no longer exists are not retried"
    );
    let audit: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE task_id = 'task_1'").fetch_one(pool).await.unwrap();
    assert_eq!(audit, 1, "the audit chain keeps what it hashed");

    // the migrated database is a working domain: a new message and a wake-only rule
    let mut conn = pool.acquire().await.unwrap();
    let agent_a = domain.principal_by_label(&mut conn, somework_core::contracts::ActorKind::Agent, "agent/a").await.unwrap().unwrap();
    drop(conn);
    let ctx = somework_domain::Ctx::new(domain.actor_for_principal(&agent_a).await);
    let sent = domain
        .send_message(
            &ctx,
            SendMessage {
                recipients: vec![somework_domain::messages::MemberRef { kind: somework_core::contracts::ActorKind::Agent, id: "agent/b".into() }],
                content: Some(somework_core::contracts::MessageContent { media_type: "text/plain".into(), data: serde_json::json!("after") }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(sent.seq > 0);
    let (rule, created) = domain
        .put_rule(
            &domain.system_ctx(),
            "alerts",
            RuleSpec { owner: Some("agent/a".into()), selector: Some("grafana.alert.*".into()), wake: true, ..Default::default() },
        )
        .await
        .unwrap();
    assert!(created && rule.wake);
}
