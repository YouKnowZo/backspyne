-- Relay pairing credentials for BackSpyne. Additive and safe to re-run on an existing
-- database: it only creates the table and indexes if they are missing.
--
-- The API also creates these objects lazily on first use, so running this file is
-- optional. It exists for operators who prefer to apply schema changes explicitly.
--
-- Only token digests are stored. The plaintext pairing token is returned once, by the
-- API response that creates it, and cannot be recovered from this table.

BEGIN;
CREATE TABLE IF NOT EXISTS backspyne_relay_tokens (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  label text NOT NULL,
  token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS backspyne_relay_tokens_token_hash_unique
  ON backspyne_relay_tokens (token_hash);
CREATE INDEX IF NOT EXISTS backspyne_relay_tokens_owner_index
  ON backspyne_relay_tokens (owner_id);
COMMIT;
