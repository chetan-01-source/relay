-- 0010_virtual_key_lookup.sql — virtual-key O(1) lookup selector (Week 2 Day 6 · ADR 0001)
-- Additive-only. Adds the public, indexed lookup key so the identity resolver can find a key by a
-- fast unique-index probe (no hashing) and derive the peppered verifier only on a snapshot miss.
--
-- Token format becomes  rk_<env>_<keyId>.<secret>  (ADR docs/adr/0001-virtual-key-format.md):
--   key_id     — 16-byte base64url selector, PUBLIC + indexed (NOT a secret)
--   key_sha256 — PBKDF2(secret, pepper) verifier over the SECRET half only (was the full key)
--
-- No RLS change: virtual_keys is already a gated tenant table (0003). Adding a column keeps the
-- check-rls.sh gate green (it asserts FORCE RLS + both policies, which remain in 0003).

ALTER TABLE virtual_keys ADD COLUMN key_id text;

-- Unique, indexed selector. Nullable for the additive step; every issued key sets it going forward
-- (the resolver treats a NULL key_id as unresolvable). Partial unique index ignores legacy NULLs.
CREATE UNIQUE INDEX virtual_keys_key_id_key ON virtual_keys (key_id) WHERE key_id IS NOT NULL;

COMMENT ON COLUMN virtual_keys.key_id IS
  'Public 16B base64url lookup selector (rk_<env>_<key_id>.<secret>). Indexed, not secret; the secret half is verified against key_sha256 = PBKDF2(secret, pepper).';
COMMENT ON COLUMN virtual_keys.key_sha256 IS
  'PBKDF2(secret, server pepper) verifier over the SECRET half only. Plaintext is never stored or logged.';
