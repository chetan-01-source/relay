# ADR 0001 — Virtual-key format: prefixed `keyId.secret`

Status: accepted (Week 2, Day 6) · Supersedes the Week-1 `sha256(fullKey)` lookup.

## Context

The master PRD stored `sha256(key)` and resolved a presented virtual key by that hash. Our security
scan (CodeQL) rejects a _fast_ hash of a credential and demands a slow KDF. But a slow KDF **on every
request** — needed if the lookup key is itself a hash of the secret — would destroy the G3 hot-path
budget (`<25ms` p99 gateway overhead), because the resolver would PBKDF2 on every call, including
cache hits.

## Decision

Adopt the GitHub/Stripe **prefixed-token** model. A virtual key is:

```
rk_<env>_<keyId>.<secret>
  keyId  = 16 bytes base64url — PUBLIC, indexed lookup selector (NOT a secret)
  secret = 24 bytes base64url — the actual credential (192-bit random)
```

Stored in `virtual_keys`:

| column       | value                                                             |
| ------------ | ----------------------------------------------------------------- |
| `key_id`     | the public selector — `UNIQUE`, indexed (migration `0010`)        |
| `key_sha256` | `PBKDF2(secret, pepper)` — verifier over the **secret half only** |
| `last4`      | last 4 chars of the secret, display only                          |

Hot-path resolve (identity module):

```
parse keyId → snapshot LRU by keyId (fast, no hashing)
  hit  → return {org, app, key, entitlements, policy}        ← steady state, no Postgres
  miss → 1 platform-scoped read WHERE key_id = $1
         → PBKDF2-verify the secret ONCE (timing-safe) → cache
```

## Consequences

- **O(1) indexed lookup** by `key_id`; PBKDF2 runs only on a cache **miss** (rare), never on the hot
  path — so it is defense-in-depth, not a per-request cost. Secrets are 192-bit random, so a fast
  path is safe; the peppered KDF means the database alone cannot verify guessed secrets offline.
- **Timing-safe** secret comparison (`crypto.timingSafeEqual`).
- `hashVirtualKey` now hashes the **secret**, not the full key. `mintVirtualKey` / `parseVirtualKey`
  / `verifyVirtualKeySecret` live in `platform/crypto.ts`.
- Additive migration `0010_virtual_key_lookup.sql` adds `key_id` (nullable + partial unique index);
  `check-rls.sh` stays green because `virtual_keys` keeps its FORCE RLS + both policies from `0003`.
