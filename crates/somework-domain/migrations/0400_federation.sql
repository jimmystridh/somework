-- Trust-domain federation (DOM-01..04). Peers are explicit administrative relationships; nothing crosses a domain
-- boundary without a registered peer, a pinned mTLS certificate and a signed, task-bound grant.

CREATE TABLE federation_peers (
  peer_domain_id        TEXT PRIMARY KEY,
  display_name          TEXT NOT NULL,
  gateway_url           TEXT,
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
  trust_tier            TEXT NOT NULL DEFAULT 'partner' CHECK (trust_tier IN ('local','partner','external','untrusted')),
  -- SHA-256 hex thumbprints of the DER client certificates the peer may present to our gateway
  client_cert_thumbprints TEXT NOT NULL DEFAULT '[]',
  -- PEM bundle used to trust the peer's gateway server certificate when we call out
  server_ca_pem         TEXT,
  -- [{kid, publicKey, status}] verification keys for grants signed by the peer's domain
  signing_keys          TEXT NOT NULL DEFAULT '[]',
  -- exports/imports and disclosure limits, see somework-gateway PeerPolicy
  policy                TEXT NOT NULL DEFAULT '{}',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE TABLE federated_tasks (
  internal_task_id        TEXT PRIMARY KEY,
  direction               TEXT NOT NULL CHECK (direction IN ('egress','ingress','a2a_in','a2a_out')),
  peer_domain_id          TEXT,
  external_task_id        TEXT,
  external_context_id     TEXT,
  remote_agent_card_digest TEXT,
  remote_interface        TEXT,
  remote_principal        TEXT,
  protocol_version        TEXT,
  follow_up_of            TEXT,
  last_remote_event       INTEGER NOT NULL DEFAULT 0,
  status                  TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE INDEX federated_tasks_external ON federated_tasks(direction, peer_domain_id, external_task_id);
CREATE INDEX federated_tasks_open ON federated_tasks(direction, status);

-- Credentials this domain presents to external A2A agents, sealed with the domain master key.
CREATE TABLE a2a_credentials (
  origin        TEXT PRIMARY KEY,
  scheme        TEXT NOT NULL CHECK (scheme IN ('bearer','assertion')),
  secret_sealed TEXT NOT NULL,
  issuer        TEXT,
  audience      TEXT,
  created_at    TEXT NOT NULL
);
