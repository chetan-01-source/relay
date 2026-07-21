# ADR 0007 — Policy: token-bucket rate limits + budget reserve/settle on Valkey

Status: accepted (Week 2, Day 10).

## Context

Day 10 enforces per-tenant rate limits and spend budgets on the data-plane hot path, under cluster
mode where N workers/replicas must agree. Postgres holds the _config_ (`rate_limits`, `budgets`) but
cannot be the live counter — a synchronous DB write per request would blow the G3 budget and race
across replicas. The limits/budget config already rides in the identity snapshot (ADR-SNAP), so
enforcement needs only an atomic, shared counter.

## Decision

### Valkey is the source of truth for counters; Postgres is config + reconciliation

`modules/policy` is a library module (`authorize` before the call, `settle` after). All counter math
runs inside **atomic Lua** via `EVALSHA`, so every worker/replica observes one consistent state:

- **Rate limits — token bucket.** Keys `b:{org}:rpm:{keyId}` and `b:{org}:tpm:{keyId}`; the script
  refills lazily by elapsed time, decrements the cost (1 request / estimated tokens), and returns
  remaining + retry-after. Breach → `429 rate_limited` with `Retry-After`; every allowed request
  carries `X-RateLimit-{Limit,Remaining}-{Requests,Tokens}`.
- **Budget — reserve then settle.** Estimate cost up front (`chars/4 + max_tokens`, priced by the
  target's rate card) and **reserve** it atomically. `hard_cutoff=true` rejects a reserve that would
  cross the limit → `429 budget_exceeded`; `hard_cutoff=false` is alert-only and always admits.
  After the call, **settle** posts `actual − reserved` (a refund when the estimate overshot),
  clamped at 0. Counters carry a TTL past the period so an abandoned reserve self-heals.
- **Offline degrade.** With no Valkey client (the `relay openapi` dump), policy admits every request
  and emits no headers — enforcement is fail-open only where there is no cluster to protect.

### Enforcement is off Postgres entirely

`authorize`/`settle` never touch Postgres. The config reaches them through the identity snapshot;
Postgres is the periodic reconciliation target, never the per-request counter.

## Consequences

- No migration: `budgets` and `rate_limits` (with `org_id` + FORCE RLS) already existed; the identity
  resolver now loads them into the snapshot's `policy`. The isolation suite probes both tables.
- Correctness of the Lua (bucket refill, hard-cutoff, alert-only, refund) is proven by a Valkey
  integration test that runs the real scripts; the unit test mocks `evalsha` for the control flow.
- New telemetry: `relay_rate_limit_rejections_total`, `relay_budget_rejections_total`,
  `relay_budget_settles_total`. Distributed-accuracy across replicas (G5) is validated under load,
  not in the unit suite.
