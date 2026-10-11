-- Operations (ADR 0004). No agent secrets and no job content are stored here: the operator's setup (names and free text), the catalog and
-- the skill library, fleet limits, who may sign in, how delivery went and who did what.

CREATE TABLE users (
    email    text PRIMARY KEY CHECK (email = lower(email)),
    role     text NOT NULL CHECK (role IN ('viewer', 'editor', 'admin')),
    added_by text NOT NULL,
    added_at timestamptz NOT NULL DEFAULT now()
);

-- One row per save: the operator's form (library skill and catalog entry names plus free text), never the resolved document.
CREATE TABLE agent_setup_revisions (
    agent      text NOT NULL,
    revision   bigint NOT NULL CHECK (revision > 0),
    form       jsonb NOT NULL,
    note       text NOT NULL DEFAULT '',
    author     text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (agent, revision)
);

CREATE TABLE catalog_entries (
    name       text PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text NOT NULL,
    deleted_at timestamptz
);

CREATE TABLE catalog_revisions (
    name       text NOT NULL REFERENCES catalog_entries (name),
    revision   bigint NOT NULL CHECK (revision > 0),
    entry      jsonb,            -- null: the revision that deleted the entry
    note       text NOT NULL DEFAULT '',
    author     text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (name, revision)
);

CREATE TABLE library_skills (
    name       text PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text NOT NULL,
    deleted_at timestamptz
);

CREATE TABLE library_revisions (
    name        text NOT NULL REFERENCES library_skills (name),
    version     bigint NOT NULL CHECK (version > 0),
    content     text,            -- null: the revision that deleted the skill
    description text NOT NULL DEFAULT '',
    sha256      text NOT NULL DEFAULT '',
    size_bytes  bigint NOT NULL DEFAULT 0,
    note        text NOT NULL DEFAULT '',
    author      text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (name, version)
);

CREATE TABLE fleet_limits_revisions (
    revision   bigint PRIMARY KEY CHECK (revision > 0),
    limits     jsonb NOT NULL,
    note       text NOT NULL DEFAULT '',
    author     text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- What was sent to each agent and what it reports back; rewritten as the reconcile loop learns more.
CREATE TABLE delivery_state (
    agent                  text NOT NULL,
    kind                   text NOT NULL CHECK (kind IN ('override', 'limits')),
    revision_sent          bigint,
    last_sent_at           timestamptz,
    last_reported_revision bigint,
    last_reported_at       timestamptz,
    rejected_revision      bigint,
    rejected_reason        text,
    rejected_at            timestamptz,
    last_error             text,
    last_error_at          timestamptz,
    failures               integer NOT NULL DEFAULT 0,
    PRIMARY KEY (agent, kind)
);

CREATE TABLE audit_log (
    id     bigserial PRIMARY KEY,
    at     timestamptz NOT NULL DEFAULT now(),
    actor  text NOT NULL,
    action text NOT NULL,
    target text NOT NULL,
    detail text NOT NULL DEFAULT ''
);

-- Revisions and the audit log are append-only: not even the application's own role can change history.
CREATE FUNCTION operations_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END
$$;

CREATE TRIGGER agent_setup_revisions_append_only BEFORE UPDATE OR DELETE ON agent_setup_revisions FOR EACH ROW EXECUTE FUNCTION operations_append_only();
CREATE TRIGGER catalog_revisions_append_only BEFORE UPDATE OR DELETE ON catalog_revisions FOR EACH ROW EXECUTE FUNCTION operations_append_only();
CREATE TRIGGER library_revisions_append_only BEFORE UPDATE OR DELETE ON library_revisions FOR EACH ROW EXECUTE FUNCTION operations_append_only();
CREATE TRIGGER fleet_limits_revisions_append_only BEFORE UPDATE OR DELETE ON fleet_limits_revisions FOR EACH ROW EXECUTE FUNCTION operations_append_only();
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION operations_append_only();

CREATE INDEX audit_log_at ON audit_log (at DESC);
