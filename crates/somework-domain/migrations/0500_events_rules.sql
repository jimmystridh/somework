-- Published events, rules (subscriptions with optional reactions) and the per-event reaction ledger.

-- A task started by a reaction records where it came from: {"kind":"reaction","rule":...,"eventId":...,"depth":n}.
ALTER TABLE tasks ADD COLUMN origin TEXT;

-- Producer dedupe: one row per (publishing principal, event key); rows older than the retention window are ignored and purged.
CREATE TABLE event_keys (
  domain_id    TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  event_key    TEXT NOT NULL,
  event_seq    INTEGER NOT NULL REFERENCES events(seq),
  event_id     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (domain_id, principal_id, event_key)
);
CREATE INDEX event_keys_age ON event_keys(created_at);

-- A rule is a subscription (kind 'topic') plus the optional reaction; the subscription row carries the owner and wake flag.
CREATE TABLE rules (
  domain_id          TEXT NOT NULL,
  rule_name          TEXT NOT NULL,
  subscription_id    TEXT NOT NULL UNIQUE REFERENCES subscriptions(subscription_id),
  owner_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  owner              TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  where_filters      TEXT NOT NULL DEFAULT '[]',
  reaction           TEXT,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  fired              INTEGER NOT NULL DEFAULT 0,
  skipped_duplicate  INTEGER NOT NULL DEFAULT 0,
  skipped_depth      INTEGER NOT NULL DEFAULT 0,
  skipped_rate       INTEGER NOT NULL DEFAULT 0,
  skipped_denied     INTEGER NOT NULL DEFAULT 0,
  skipped_approval   INTEGER NOT NULL DEFAULT 0,
  skipped_error      INTEGER NOT NULL DEFAULT 0,
  skipped_paused     INTEGER NOT NULL DEFAULT 0,
  last_fired_at      TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (domain_id, rule_name)
);

-- One row per (rule, event): written when the event matches, settled by the reaction worker. The primary key is what makes
-- task creation exactly-once.
CREATE TABLE reaction_firings (
  domain_id   TEXT NOT NULL,
  rule_name   TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  event_seq   INTEGER NOT NULL,
  depth       INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','fired','skipped')),
  reason      TEXT,
  detail      TEXT,
  task_id     TEXT,
  approval_id TEXT,
  created_at  TEXT NOT NULL,
  decided_at  TEXT,
  PRIMARY KEY (domain_id, rule_name, event_id)
);
CREATE INDEX reaction_firings_rate ON reaction_firings(domain_id, rule_name, status, decided_at);
