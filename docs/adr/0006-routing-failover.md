# ADR 0006 — Routing: real target selection, capability filter, failover

Status: accepted (Week 2, Day 9).

## Context

Day 9 replaces the proxy's hardcoded upstream with a real route. A client's `model` field names an
org's **route**; the active **route version** carries an ordered/weighted list of **targets**, each
pointing at an encrypted provider credential and a provider-native model. The proxy must pick a
capable target, decrypt its credential in memory, call upstream, and fail over transparently — all
without a synchronous Postgres read on the hot path (ADR-SNAP) and within the G3 overhead budget.

## Decision

### routing — a library module, not an endpoint

`modules/routing` has no HTTP surface; its public API is `selectTargets(orgId, req) → Target[]`, an
ordered failover plan injected into the proxy from the composition root. Layers stay honest:
`service → repository → queries`, all SQL parametrized and run inside `withTenant` (RLS-scoped).

- **One query, one join.** `listActiveRouteTargetsQuery` joins
  `routes → route_versions (active) → route_targets → provider_credentials`, left-joining
  `model_catalog` (capabilities) and `rate_cards` (pricing). Rollback = point `active_version_id` at
  an older version; the query always reads whatever is active.
- **Short-lived cache.** Resolved rows are cached per `org:model` for 60s to keep the hot path off
  Postgres. Staleness is bounded; credential rotation/route edits converge within the TTL.
- **Capability filter.** The request's modalities (`text`, plus `image` when a message carries an
  `image_url` part), streaming need, and `max_tokens` must be a subset of a target's
  `model_catalog.capabilities`. No active route → `404 model_not_found`; a route exists but nothing
  is capable → `400 model_capability_mismatch`.
- **Ordering.** `priority` strategy sorts by ascending priority then descending health score.
  `weighted` picks a primary by weighted ticket, then appends the remaining targets (still ordered)
  so failover always has somewhere to go.
- **Credential open at send time only.** `openCredential` decrypts the envelope in worker memory as
  the plan is built; plaintext never touches the DB, logs, or the response.

### proxy — wired to reality with pre-first-token failover

The proxy iterates the plan. A target failure (`markFailure`) trips a **circuit breaker** keyed by
`credentialId:model` after 2 failures, with a jittered 30s cooldown; `availableTargets` prefers
closed breakers and only probes open ones when all are open (crude half-open). Streaming fails over
**only before the first token is emitted** — once bytes are on the wire the stream ends cleanly
rather than silently re-issuing. `x-relay-failover: true` marks a response that came from a
non-primary target. Non-streaming provider bodies are normalized to OpenAI shape via the adapter's
`toResponse` (see ADR 0005), so Anthropic replies stay drop-in compatible.

## Consequences

- No migration: `routes`, `route_versions`, `route_targets` (with `org_id` + FORCE RLS) already
  existed from Week 1. The isolation suite now also probes all three.
- The breaker and route cache are per-worker in-process state; Valkey remains the source of truth for
  limits/budgets (ADR 0007), not for routing.
- Response normalization added `toResponse` to the `ProviderAdapter` contract — a Layer-1 change with
  golden-style unit coverage per family; nothing above the adapter learned a new provider shape.
