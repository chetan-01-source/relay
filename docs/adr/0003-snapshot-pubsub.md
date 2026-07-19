# ADR 0003 — Identity snapshot: in-process LRU + Valkey pub/sub, no Postgres on the hot path

Status: accepted (Week 2, Day 6).

## Context

Every data-plane request must authorize a virtual key. Reading Postgres per request would blow the
G3 hot-path budget and couple throughput to the database. But cached authorization must not outlive a
revocation — the SLA is **≤1s** propagation.

## Decision

Each worker holds an **in-process LRU** keyed by `key_id`, caching the resolved snapshot
`{ org, app, key, entitlements, policy }`. Resolution:

- **hit** → return from memory (≤1µs, no Postgres) — the steady state.
- **miss** → one platform-scoped read + one PBKDF2 verify, then cache.

Invalidation is **push, not TTL**. Workers subscribe to Valkey channels:

| channel                | message        | effect                |
| ---------------------- | -------------- | --------------------- |
| `key.invalidate`       | `{id: key_id}` | drop that key's entry |
| `org.suspend`          | `{id: org_id}` | clear the cache       |
| `org.features.updated` | `{id: org_id}` | clear the cache       |

Messages carry a publish timestamp; each subscriber observes the propagation delay into the
`relay_snapshot_invalidation_lag` histogram — the metric that proves the ≤1s SLA.

## Consequences

- Steady state never touches Postgres; a miss is a single RLS-scoped read. Correctness never depends
  on a cache hit.
- Org-level events clear the whole cache (snapshots are not indexed by org, and these events are
  rare) rather than maintaining a reverse index.
- The lookup crosses the org boundary (a presented key names no org yet), so the miss read runs as a
  **platform admin** with a NIL org id — the one cross-org read on the data path.
- Publishers land later: `org.suspend` with the tenancy module (Day 7), `key.invalidate` with the
  apps/keys revoke lifecycle (Day 8). Day 6 defines the channel contract and the subscriber.
