-- Matrix end-to-end encryption state (Olm/Megolm). Every *_pickle column holds a vodozemac pickle sealed with the
-- domain master key (AES-256-GCM, AAD = table + primary key); nothing secret is stored in plaintext.

CREATE TABLE matrix_crypto_accounts (
  user_id       TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  generation    INTEGER NOT NULL DEFAULT 1,
  sealed_pickle TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_at    TEXT NOT NULL,
  retired_at    TEXT,
  PRIMARY KEY (user_id, device_id)
);

CREATE TABLE matrix_olm_sessions (
  session_id      TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  device_id       TEXT NOT NULL,
  peer_user       TEXT NOT NULL,
  peer_device     TEXT NOT NULL,
  peer_curve25519 TEXT NOT NULL,
  sealed_pickle   TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  last_used_at    TEXT NOT NULL
);
CREATE INDEX matrix_olm_sessions_peer ON matrix_olm_sessions(user_id, device_id, peer_curve25519);

CREATE TABLE matrix_megolm_outbound (
  session_id     TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  device_id      TEXT NOT NULL,
  room_id        TEXT NOT NULL,
  sealed_pickle  TEXT NOT NULL,
  message_count  INTEGER NOT NULL DEFAULT 0,
  shared_with    TEXT NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  rotated_reason TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX matrix_megolm_outbound_room ON matrix_megolm_outbound(user_id, device_id, room_id, status);

CREATE TABLE matrix_megolm_inbound (
  room_id           TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  sender_key        TEXT NOT NULL,
  sender_user       TEXT NOT NULL,
  sender_device     TEXT NOT NULL,
  sealed_pickle     TEXT NOT NULL,
  first_known_index INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (room_id, session_id)
);

-- Message-index replay protection: one (session, index) maps to exactly one event id.
CREATE TABLE matrix_megolm_replay (
  room_id       TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  message_index INTEGER NOT NULL,
  event_id      TEXT NOT NULL,
  PRIMARY KEY (room_id, session_id, message_index)
);

-- Peer device keys learned through /keys/query (public keys only).
CREATE TABLE matrix_device_keys (
  user_id    TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  curve25519 TEXT NOT NULL,
  ed25519    TEXT NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (user_id, device_id)
);

-- Encrypted events whose room key has not arrived yet (ciphertext only).
CREATE TABLE matrix_crypto_pending (
  event_id   TEXT PRIMARY KEY,
  room_id    TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX matrix_crypto_pending_session ON matrix_crypto_pending(room_id, session_id);

-- A stored Megolm test vector: restore verification proves the key material still decrypts it.
CREATE TABLE matrix_crypto_selftest (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  sealed_vector TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
