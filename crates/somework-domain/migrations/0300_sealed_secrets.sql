-- Sealed-secret extension: short-lived, recipient-bound, one-time opaque envelopes.
-- The server never sees plaintext; envelopes are removed on first read or at expiry.
CREATE TABLE sealed_secrets (
  secret_id              TEXT PRIMARY KEY,
  domain_id              TEXT NOT NULL,
  sender_principal_id    TEXT NOT NULL,
  recipient_principal_id TEXT NOT NULL,
  label                  TEXT,
  envelope               TEXT,
  envelope_digest        TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  expires_at             TEXT NOT NULL,
  read_at                TEXT
);
CREATE INDEX sealed_secrets_recipient ON sealed_secrets(recipient_principal_id, read_at);
