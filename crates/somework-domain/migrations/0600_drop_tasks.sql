-- Messages and events are the only way agents communicate: tasks, reactions, task-bound approvals, grants, context handover
-- and federation of tasks are gone. The task-less history (messages, events, artifacts, audit) stays.

-- Work that was still in flight has no consumer any more; its notifications must not be retried.
UPDATE outbox_events SET status = 'skipped', last_error = 'tasks were removed'
 WHERE status IN ('pending','failed') AND (sink IN ('reaction','gateway') OR subject LIKE 'somework.work.%' OR subject LIKE 'somework.stream.%');

-- Messages that belonged to a task, to a context handover or to an approval cannot be read by the task-less envelope.
DELETE FROM message_deliveries WHERE message_id IN (
  SELECT message_id FROM messages
   WHERE task_id IS NOT NULL
      OR type NOT IN ('chat.message','chat.notice','event.notification','artifact.published','catalog.changed','policy.denied','presence.changed')
      OR envelope LIKE '%sourceTaskId%' OR envelope LIKE '%contextRefs%');
DELETE FROM messages
 WHERE task_id IS NOT NULL
    OR type NOT IN ('chat.message','chat.notice','event.notification','artifact.published','catalog.changed','policy.denied','presence.changed')
    OR envelope LIKE '%sourceTaskId%' OR envelope LIKE '%contextRefs%';

-- Subscriptions that followed a task or a capability queue followed nothing that exists now.
DELETE FROM subscriptions WHERE kind IN ('capability_queue','task');

DROP TABLE IF EXISTS federated_tasks;
DROP TABLE IF EXISTS federation_peers;
DROP TABLE IF EXISTS a2a_credentials;
DROP TABLE IF EXISTS reaction_firings;
DROP TABLE IF EXISTS approvals;
DROP TABLE IF EXISTS task_events;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS context_offers;
DROP TABLE IF EXISTS context_packs;
DROP TABLE IF EXISTS auth_grants;

-- A rule only wakes its owner now.
ALTER TABLE rules DROP COLUMN reaction;
ALTER TABLE rules DROP COLUMN fired;
ALTER TABLE rules DROP COLUMN skipped_duplicate;
ALTER TABLE rules DROP COLUMN skipped_depth;
ALTER TABLE rules DROP COLUMN skipped_rate;
ALTER TABLE rules DROP COLUMN skipped_denied;
ALTER TABLE rules DROP COLUMN skipped_approval;
ALTER TABLE rules DROP COLUMN skipped_error;
ALTER TABLE rules DROP COLUMN skipped_paused;
ALTER TABLE rules DROP COLUMN last_fired_at;

-- Columns that tied other rows to a task. The audit chain and the policy decisions keep theirs: the audit hash covers it.
DROP INDEX IF EXISTS messages_task;
ALTER TABLE messages DROP COLUMN task_id;
DROP INDEX IF EXISTS events_task;
ALTER TABLE events DROP COLUMN task_id;
ALTER TABLE events DROP COLUMN revision;
DROP INDEX IF EXISTS artifacts_task;
ALTER TABLE artifacts DROP COLUMN source_task_id;
ALTER TABLE conversations DROP COLUMN task_id;
DROP INDEX IF EXISTS audit_events_task;
DROP INDEX IF EXISTS policy_decisions_task;
