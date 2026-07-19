# ADR 0005 — Key lifecycle, provider credentials, adapter registry

Status: accepted (Week 2, Day 8).

## Context

Day 8 turns the two-key model into managed resources. Inbound: applications own virtual keys that must
be issued, rotated, and revoked. Outbound: upstream provider keys must be stored encrypted and never
returned. And the proxy needs a confirmed set of provider adapters with a regression harness.

## Decision

### apps — virtual-key lifecycle (`/api/v1/apps`, `/api/v1/keys`)

Org-scoped control plane (tenant = the caller's JWT org, never the body). Three audited operations:

- **issue** — `mintVirtualKey` produces `rk_<env>_<keyId>.<secret>`; only the public `key_id` and the
  PBKDF2 verifier are stored. The plaintext is returned exactly once and is unrecoverable after.
- **rotate** — in ONE transaction: insert a successor key, then point the predecessor at it and set
  `grace_until = now + 24h` (well under the ≤72h cap). The old key keeps working during the window.
- **revoke** — flip to `revoked` immediately.

Rotate and revoke publish `key.invalidate`, so every worker's snapshot drops the entry ≤1s. The
identity resolver now carries `grace_until` into the snapshot and `authVirtualKey` rejects a key past
its grace window (`401 key_revoked`) — so a rotated key dies on schedule without a DB re-read.

### providers — encrypted credential store (`/api/v1/providers`)

Write-only. `createCredential` seals the upstream key with envelope crypto (`sealCredential`) before
the transaction; reads select **metadata only** (name, provider, last4, health) — the query column
list physically excludes the sealed columns, so ciphertext can't leak through an API shape. Plaintext
is decrypted only in worker memory at send time (Day 9).

### adapters — registry + golden fixtures

P0 families confirmed: `openai`, `anthropic`, `openai_compat`. The compat adapter reuses OpenAI's
wire format but rewrites one header — it drops `Authorization` when the target has no key (local
Ollama). Canonical message `content` is now `string | ContentPart[]`, so inline images pass through:
OpenAI native, Anthropic mapped to URL image blocks. `adapter.golden.test.ts` records the exact
`translate()` output per family for a text AND an image request — recorded fixtures, no live calls.

### health-score stub

A pure `computeHealthScore(samples)` (error rate + p95) in `providers/lib/health.ts`, ready for the
Day-9 router to persist into `provider_credentials.health_score` and prefer healthier, faster targets.

## Consequences

- No migration: every table (applications, virtual_keys with successor/grace/key_id,
  provider_credentials with health_score) already existed. Day 8 is pure module + adapter code.
- All writes are tenant-scoped (`isPlatformAdmin: false`) and RLS-isolated; the isolation suite now
  also probes `provider_credentials`.
- Wiring the proxy to select a real target + decrypt the credential is deliberately Day 9.
