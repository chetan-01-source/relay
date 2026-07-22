# ADR 0008 — Exact response cache (Valkey), tenant-isolated by key

Status: accepted (Week 3, Day 11).

## Context

Repeated identical completions are pure waste — provider latency and spend for an answer we already
have. Day 11 adds an **exact-match** cache on the data-plane hot path. It must never leak across
tenants, never block or unbounded-buffer a request, and must degrade to a no-op where there is no
Valkey (the offline `relay openapi` dump). Semantic/similarity caching is explicitly P1 (§14).

## Decision

### A library module (`modules/cache`), Valkey only — no Postgres

Mirrors routing/policy: `service → lib`, no HTTP surface, injected into the proxy from the composition
root. It reuses the event bus's Redis client; it has no pool of its own.

- **Key = `c:{org}:{sha256(semantic request)}`.** The org id is the first segment, so a cached entry
  is **tenant-isolated by construction** — org A's key space can never collide with org B's. The hash
  covers only semantic fields (model, messages, temperature bucket, max_tokens, image-part URLs);
  `stream` and trace/user fields are excluded, so a streaming and non-streaming ask for identical
  content share one entry. Key derivation is a pure function (`lib/cache-key.ts`), exhaustively tested.
- **Disabled-safe.** No Valkey client (offline dump) or `RELAY_CACHE_TTL_S = 0` ⇒ every `get`/`set`
  is a no-op and the gateway behaves exactly as before.
- **Tee-within-cap on write.** A response is cached on the way out only if it serializes under
  `RELAY_CACHE_MAX_BYTES`; oversized bodies are never stored (no unbounded buffering). Streaming
  responses are accumulated as they are written and cached once complete; a corrupt entry reads as a
  miss, never a 500.

### Hit semantics in the proxy

The cache is checked **before** routing (the cheapest path). On a hit:

- **rate limits still apply** — the controller calls `policy.authorize` with an empty target list, so
  the rpm/tpm token buckets are decremented (a cache hit can't be used to bypass them) but **no budget
  is reserved** (nothing is spent upstream);
- the upstream, credential decrypt, and budget settle are **skipped**;
- the response carries `X-Relay-Cache: hit-exact` (a miss carries `miss`), and the hit is still
  metered — at zero cost (ADR 0009).

## Consequences

- No migration: the cache is Valkey-only. New env: `RELAY_CACHE_TTL_S`, `RELAY_CACHE_MAX_BYTES`.
- New telemetry: `relay_cache_hits_total{result}`.
- Tenant isolation is enforced by the key, not RLS — covered by a `cache-key` unit probe (same org ⇒
  same key; different org ⇒ different key) rather than the SQL isolation suite.
- Default TTL is 0 (off): caching is opt-in per deployment, since exact-cache correctness depends on
  the workload tolerating identical answers for identical inputs.
