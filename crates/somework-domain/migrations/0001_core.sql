-- SomeWork canonical state (SQLite). Every tenant-owned row carries domain_id.
-- Timestamps are RFC 3339 UTC strings with millisecond precision (lexicographic order == chronological order).

CREATE TABLE domains (
  domain_id    TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('local','peer')),
  display_name TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
  config       TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL
);

CREATE TABLE principals (
  principal_id TEXT PRIMARY KEY,
  domain_id    TEXT NOT NULL REFERENCES domains(domain_id),
  kind         TEXT NOT NULL CHECK (kind IN ('agent','human','service','domain')),
  external_id  TEXT NOT NULL,
  display_name TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  permissions  TEXT NOT NULL DEFAULT '{}',
  public_key   TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (domain_id, kind, external_id)
);

CREATE TABLE human_identities (
  principal_id   TEXT PRIMARY KEY REFERENCES principals(principal_id),
  oidc_issuer    TEXT,
  oidc_subject   TEXT,
  matrix_user_id TEXT UNIQUE,
  UNIQUE (oidc_issuer, oidc_subject)
);

CREATE TABLE signing_keys (
  kid         TEXT PRIMARY KEY,
  domain_id   TEXT NOT NULL REFERENCES domains(domain_id),
  public_key  TEXT NOT NULL,
  private_key TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('active','retired')),
  created_at  TEXT NOT NULL,
  retired_at  TEXT
);

CREATE TABLE policies (
  version    TEXT NOT NULL,
  domain_id  TEXT NOT NULL REFERENCES domains(domain_id),
  document   TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (domain_id, version)
);
CREATE UNIQUE INDEX policies_one_active ON policies(domain_id) WHERE active = 1;

-- Agents -----------------------------------------------------------------------------------------------------------
CREATE TABLE agents (
  agent_id     TEXT PRIMARY KEY,
  domain_id    TEXT NOT NULL REFERENCES domains(domain_id),
  principal_id TEXT REFERENCES principals(principal_id),
  display_name TEXT NOT NULL,
  description  TEXT NOT NULL,
  owner        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','degraded','offline','disabled')),
  card_version INTEGER NOT NULL DEFAULT 1,
  pool_id      TEXT NOT NULL,
  card         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX agents_domain ON agents(domain_id);

CREATE TABLE runtime_instances (
  runtime_instance_id TEXT PRIMARY KEY,
  agent_id            TEXT NOT NULL REFERENCES agents(agent_id),
  domain_id           TEXT NOT NULL,
  started_at          TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  ended_at            TEXT,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  meta                TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX runtime_instances_agent ON runtime_instances(agent_id, status, last_seen_at);

-- Capability contracts are immutable per (domain, id, version); changing a contract requires a new version.
CREATE TABLE capabilities (
  domain_id     TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  version       TEXT NOT NULL,
  definition    TEXT NOT NULL,
  digest        TEXT NOT NULL,
  side_effects  TEXT NOT NULL CHECK (side_effects IN ('none','read','write','irreversible')),
  created_at    TEXT NOT NULL,
  PRIMARY KEY (domain_id, capability_id, version)
);

CREATE TABLE agent_capabilities (
  agent_id           TEXT NOT NULL REFERENCES agents(agent_id),
  capability_id      TEXT NOT NULL,
  capability_version TEXT NOT NULL,
  domain_id          TEXT NOT NULL,
  PRIMARY KEY (agent_id, capability_id, capability_version)
);
CREATE INDEX agent_capabilities_lookup ON agent_capabilities(domain_id, capability_id, capability_version);

CREATE TABLE catalog_entries (
  entry_id              TEXT PRIMARY KEY,
  domain_id             TEXT NOT NULL,
  agent_id              TEXT NOT NULL UNIQUE REFERENCES agents(agent_id),
  visibility            TEXT NOT NULL CHECK (visibility IN ('private','domain','exported','public')),
  exported_capabilities TEXT NOT NULL DEFAULT '[]',
  trust_tier            TEXT CHECK (trust_tier IN ('local','partner','external','untrusted')),
  approval_status       TEXT NOT NULL CHECK (approval_status IN ('draft','approved','suspended','revoked')),
  approved_by           TEXT,
  approved_at           TEXT,
  policy_version        TEXT,
  source_type           TEXT NOT NULL CHECK (source_type IN ('native','a2a','manual')),
  source_uri            TEXT,
  source_digest         TEXT,
  search_text           TEXT NOT NULL DEFAULT '',
  labels                TEXT NOT NULL DEFAULT '{}',
  created_by            TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX catalog_entries_domain ON catalog_entries(domain_id, approval_status);

CREATE VIRTUAL TABLE catalog_fts USING fts5(entry_id UNINDEXED, body, tokenize = 'porter unicode61');

-- Conversations and messages -----------------------------------------------------------------------------------------
CREATE TABLE conversations (
  conversation_id TEXT PRIMARY KEY,
  domain_id       TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('room','dm','task')),
  title           TEXT,
  classification  TEXT NOT NULL DEFAULT 'internal',
  created_by      TEXT NOT NULL,
  parent_conversation_id TEXT,
  task_id         TEXT,
  dm_key          TEXT,
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX conversations_dm_key ON conversations(domain_id, dm_key) WHERE dm_key IS NOT NULL;

CREATE TABLE conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  principal_id    TEXT NOT NULL REFERENCES principals(principal_id),
  role            TEXT NOT NULL DEFAULT 'member',
  joined_at       TEXT NOT NULL,
  PRIMARY KEY (conversation_id, principal_id)
);
CREATE INDEX conversation_members_principal ON conversation_members(principal_id);

CREATE TABLE messages (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id      TEXT NOT NULL UNIQUE,
  domain_id       TEXT NOT NULL,
  conversation_id TEXT REFERENCES conversations(conversation_id),
  task_id         TEXT,
  type            TEXT NOT NULL,
  sender_principal_id TEXT NOT NULL,
  trigger_mode    TEXT NOT NULL,
  envelope        TEXT NOT NULL,
  content_digest  TEXT NOT NULL,
  idempotency_key TEXT,
  causation_id    TEXT,
  hop_depth       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX messages_idempotency ON messages(domain_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX messages_conversation ON messages(conversation_id, seq);
CREATE INDEX messages_task ON messages(task_id, seq);

-- Delivery/read receipts per recipient (inbox projection).
CREATE TABLE message_deliveries (
  message_id   TEXT NOT NULL REFERENCES messages(message_id),
  principal_id TEXT NOT NULL,
  wake         INTEGER NOT NULL DEFAULT 0,
  delivered_at TEXT,
  read_at      TEXT,
  PRIMARY KEY (message_id, principal_id)
);
CREATE INDEX message_deliveries_inbox ON message_deliveries(principal_id, read_at);

-- Tasks ------------------------------------------------------------------------------------------------------------
CREATE TABLE tasks (
  task_id               TEXT PRIMARY KEY,
  domain_id             TEXT NOT NULL,
  conversation_id       TEXT,
  parent_task_id        TEXT,
  capability_id         TEXT NOT NULL,
  capability_version    TEXT NOT NULL,
  side_effects          TEXT NOT NULL,
  capability_snapshot   TEXT NOT NULL,
  requester             TEXT NOT NULL,
  requester_principal_id TEXT NOT NULL,
  target_agent_id       TEXT,
  pool_id               TEXT,
  assignee_agent_id     TEXT,
  assignee_principal_id TEXT,
  state                 TEXT NOT NULL,
  revision              INTEGER NOT NULL,
  attempt               INTEGER NOT NULL DEFAULT 1,
  input                 TEXT NOT NULL,
  context_refs          TEXT NOT NULL DEFAULT '[]',
  lease_id              TEXT,
  lease_runtime_instance_id TEXT,
  lease_expires_at      TEXT,
  fencing_counter       INTEGER NOT NULL DEFAULT 0,
  authorization_token_id TEXT,
  policy_decision_id    TEXT,
  effective_authority   TEXT,
  constraints           TEXT,
  delegation_depth_remaining INTEGER NOT NULL DEFAULT 0,
  result                TEXT,
  result_artifacts      TEXT NOT NULL DEFAULT '[]',
  failure               TEXT,
  blocker               TEXT,
  idempotency_key       TEXT,
  traceparent           TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  deadline_at           TEXT,
  completed_at          TEXT
);
CREATE UNIQUE INDEX tasks_idempotency ON tasks(domain_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX tasks_state ON tasks(domain_id, state);
CREATE INDEX tasks_queue ON tasks(domain_id, state, pool_id, target_agent_id, capability_id);
CREATE INDEX tasks_lease ON tasks(state, lease_expires_at);
CREATE INDEX tasks_deadline ON tasks(deadline_at) WHERE deadline_at IS NOT NULL;
CREATE INDEX tasks_parent ON tasks(parent_task_id);
CREATE INDEX tasks_requester ON tasks(requester_principal_id, created_at);
CREATE INDEX tasks_conversation ON tasks(conversation_id);

CREATE TABLE task_events (
  task_id        TEXT NOT NULL REFERENCES tasks(task_id),
  event_sequence INTEGER NOT NULL,
  event_id       TEXT NOT NULL UNIQUE,
  type           TEXT NOT NULL,
  from_state     TEXT,
  to_state       TEXT,
  revision       INTEGER NOT NULL,
  actor          TEXT NOT NULL,
  data           TEXT NOT NULL DEFAULT '{}',
  trace_id       TEXT,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (task_id, event_sequence)
);

-- Context packs and artifacts --------------------------------------------------------------------------------------
CREATE TABLE context_packs (
  context_pack_id TEXT NOT NULL,
  version         INTEGER NOT NULL,
  domain_id       TEXT NOT NULL,
  manifest        TEXT NOT NULL,
  digest          TEXT NOT NULL,
  classification  TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  source_task_id  TEXT,
  size_bytes      INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (context_pack_id, version)
);

CREATE TABLE context_offers (
  offer_id        TEXT PRIMARY KEY,
  domain_id       TEXT NOT NULL,
  context_pack_id TEXT NOT NULL,
  version         INTEGER NOT NULL,
  from_principal_id TEXT NOT NULL,
  to_principal_id TEXT NOT NULL,
  to_agent_id     TEXT,
  mode            TEXT NOT NULL CHECK (mode IN ('subtask','ownership_transfer','consultation')),
  task_id         TEXT,
  sections        TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','expired','withdrawn')),
  result          TEXT,
  expires_at      TEXT,
  created_at      TEXT NOT NULL,
  decided_at      TEXT,
  FOREIGN KEY (context_pack_id, version) REFERENCES context_packs(context_pack_id, version)
);
CREATE INDEX context_offers_to ON context_offers(to_principal_id, status);

CREATE TABLE artifacts (
  artifact_id    TEXT NOT NULL,
  version        INTEGER NOT NULL,
  domain_id      TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending','complete','failed','expired')),
  filename       TEXT,
  media_type     TEXT NOT NULL,
  declared_size  INTEGER NOT NULL,
  size_bytes     INTEGER,
  declared_digest TEXT NOT NULL,
  actual_digest  TEXT,
  classification TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  created_by_principal_id TEXT NOT NULL,
  source_task_id TEXT,
  provenance     TEXT NOT NULL DEFAULT '{}',
  encryption     TEXT NOT NULL DEFAULT '{}',
  storage_key    TEXT NOT NULL,
  upload         TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  completed_at   TEXT,
  expires_at     TEXT,
  PRIMARY KEY (artifact_id, version)
);
CREATE INDEX artifacts_domain ON artifacts(domain_id, status);
CREATE INDEX artifacts_task ON artifacts(source_task_id);

-- Authorization, policy, audit ------------------------------------------------------------------------------------------
CREATE TABLE auth_grants (
  jti          TEXT PRIMARY KEY,
  domain_id    TEXT NOT NULL,
  subject_principal_id TEXT NOT NULL,
  task_id      TEXT,
  parent_jti   TEXT,
  claims       TEXT NOT NULL,
  issued_at    TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX auth_grants_task ON auth_grants(task_id);

-- Single-use token ids (assertions and cross-domain grants) for replay control.
CREATE TABLE used_jtis (
  jti        TEXT NOT NULL,
  scope      TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (scope, jti)
);

CREATE TABLE policy_decisions (
  decision_id    TEXT PRIMARY KEY,
  domain_id      TEXT NOT NULL,
  occurred_at    TEXT NOT NULL,
  actor_principal_id TEXT,
  actor          TEXT NOT NULL,
  action         TEXT NOT NULL,
  resource       TEXT,
  decision       TEXT NOT NULL CHECK (decision IN ('allow','deny')),
  reasons        TEXT NOT NULL DEFAULT '[]',
  policy_version TEXT NOT NULL,
  task_id        TEXT,
  trace_id       TEXT
);
CREATE INDEX policy_decisions_time ON policy_decisions(domain_id, occurred_at);
CREATE INDEX policy_decisions_task ON policy_decisions(task_id);

CREATE TABLE audit_events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_event_id TEXT NOT NULL UNIQUE,
  domain_id      TEXT NOT NULL,
  occurred_at    TEXT NOT NULL,
  authenticated_actor TEXT NOT NULL,
  runtime_instance_id TEXT,
  action         TEXT NOT NULL,
  resource       TEXT,
  task_id        TEXT,
  conversation_id TEXT,
  authorization_grant_jti TEXT,
  policy_decision_id TEXT,
  policy_version TEXT,
  request_digest TEXT,
  before_state_digest TEXT,
  after_state_digest TEXT,
  outcome        TEXT NOT NULL,
  trace_id       TEXT,
  source_transport TEXT,
  source_transport_event_id TEXT,
  detail         TEXT NOT NULL DEFAULT '{}',
  prev_hash      TEXT NOT NULL,
  hash           TEXT NOT NULL
);
CREATE INDEX audit_events_task ON audit_events(task_id);
CREATE INDEX audit_events_time ON audit_events(domain_id, occurred_at);

CREATE TABLE approvals (
  approval_id    TEXT PRIMARY KEY,
  domain_id      TEXT NOT NULL,
  task_id        TEXT NOT NULL REFERENCES tasks(task_id),
  task_revision  INTEGER NOT NULL,
  action_digest  TEXT NOT NULL,
  action         TEXT NOT NULL,
  requested_by   TEXT NOT NULL,
  required_approver_policy TEXT NOT NULL DEFAULT '{}',
  approved_by    TEXT,
  decision       TEXT CHECK (decision IN ('approved','denied')),
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','expired','superseded')),
  expires_at     TEXT NOT NULL,
  policy_decision_id TEXT,
  created_at     TEXT NOT NULL,
  decided_at     TEXT
);
CREATE INDEX approvals_task ON approvals(task_id, status);

-- Events, subscriptions, outbox, idempotency ----------------------------------------------------------------------------
CREATE TABLE events (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id      TEXT NOT NULL UNIQUE,
  domain_id     TEXT NOT NULL,
  type          TEXT NOT NULL,
  task_id       TEXT,
  conversation_id TEXT,
  message_id    TEXT,
  revision      INTEGER,
  subject       TEXT,
  payload       TEXT NOT NULL,
  traceparent   TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX events_task ON events(task_id, seq);

CREATE TABLE event_recipients (
  event_seq    INTEGER NOT NULL REFERENCES events(seq),
  principal_id TEXT NOT NULL,
  wake         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (event_seq, principal_id)
);
CREATE INDEX event_recipients_principal ON event_recipients(principal_id, event_seq);

CREATE TABLE event_cursors (
  principal_id TEXT PRIMARY KEY,
  cursor       INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL
);

CREATE TABLE subscriptions (
  subscription_id TEXT PRIMARY KEY,
  domain_id       TEXT NOT NULL,
  principal_id    TEXT NOT NULL REFERENCES principals(principal_id),
  kind            TEXT NOT NULL CHECK (kind IN ('topic','capability_queue','conversation','task')),
  selector        TEXT NOT NULL,
  wake            INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
  created_at      TEXT NOT NULL,
  deleted_at      TEXT
);
CREATE INDEX subscriptions_match ON subscriptions(domain_id, kind, selector, status);

CREATE TABLE outbox_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_seq       INTEGER NOT NULL REFERENCES events(seq),
  domain_id       TEXT NOT NULL,
  sink            TEXT NOT NULL,
  subject         TEXT NOT NULL,
  dedupe_key      TEXT NOT NULL,
  coalesce_key    TEXT,
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','failed','dead','skipped')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  claimed_by      TEXT,
  claim_expires_at TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  published_at    TEXT,
  UNIQUE (sink, dedupe_key)
);
CREATE INDEX outbox_pending ON outbox_events(sink, status, next_attempt_at);

CREATE TABLE transport_mappings (
  transport   TEXT NOT NULL,
  external_id TEXT NOT NULL,
  object_kind TEXT NOT NULL,
  object_id   TEXT NOT NULL,
  domain_id   TEXT NOT NULL,
  data        TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  PRIMARY KEY (transport, external_id)
);
CREATE INDEX transport_mappings_object ON transport_mappings(transport, object_kind, object_id);

CREATE TABLE idempotency_keys (
  domain_id      TEXT NOT NULL,
  principal_id   TEXT NOT NULL,
  idem_key       TEXT NOT NULL,
  operation      TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response       TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  PRIMARY KEY (domain_id, principal_id, idem_key)
);

-- Immutability guards (defence in depth; the application never issues these statements) ----------------------------------
CREATE TABLE maintenance_flags (name TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);
INSERT INTO maintenance_flags(name, enabled) VALUES ('retention_purge', 0);

CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events are immutable'); END;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
WHEN (SELECT enabled FROM maintenance_flags WHERE name = 'retention_purge') = 0
BEGIN SELECT RAISE(ABORT, 'audit_events are immutable'); END;

CREATE TRIGGER task_events_no_update BEFORE UPDATE ON task_events
BEGIN SELECT RAISE(ABORT, 'task_events are append-only'); END;
CREATE TRIGGER task_events_no_delete BEFORE DELETE ON task_events
WHEN (SELECT enabled FROM maintenance_flags WHERE name = 'retention_purge') = 0
BEGIN SELECT RAISE(ABORT, 'task_events are append-only'); END;

CREATE TRIGGER policy_decisions_no_update BEFORE UPDATE ON policy_decisions
BEGIN SELECT RAISE(ABORT, 'policy_decisions are immutable'); END;

CREATE TRIGGER context_packs_no_update BEFORE UPDATE ON context_packs
BEGIN SELECT RAISE(ABORT, 'context pack versions are immutable'); END;

CREATE TRIGGER capabilities_no_update BEFORE UPDATE ON capabilities
BEGIN SELECT RAISE(ABORT, 'capability contracts are immutable per version'); END;

-- TASK-04: terminal task states are immutable.
CREATE TRIGGER tasks_terminal_immutable BEFORE UPDATE ON tasks
WHEN OLD.state IN ('succeeded','failed','rejected','canceled','expired')
BEGIN SELECT RAISE(ABORT, 'terminal tasks are immutable'); END;

-- ART-01: completed artifact versions are immutable.
CREATE TRIGGER artifacts_complete_immutable BEFORE UPDATE ON artifacts
WHEN OLD.status = 'complete' AND (NEW.status <> 'complete' OR NEW.actual_digest IS NOT OLD.actual_digest OR NEW.size_bytes IS NOT OLD.size_bytes OR NEW.storage_key <> OLD.storage_key)
BEGIN SELECT RAISE(ABORT, 'completed artifact versions are immutable'); END;
