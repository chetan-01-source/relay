# ADR 0009 — Metering: async ring queue + recomputed hourly rollups

Status: accepted (Week 3, Day 11).

## Context

Every proxied request must land as one normalized, priced usage event so dashboards can attribute
spend per app/route/model. But writing to Postgres on the request path would violate the hard
non-negotiable "no synchronous Postgres on the hot path" and blow the G3 overhead budget. And
dashboards must never scan the raw, high-volume partitions.

## Decision

### A library module (`modules/metering`): non-blocking write, background durability

`recordUsage` is called from the proxy controller **after the response is fully sent** and only
**enqueues** onto a bounded in-process ring queue — it never awaits Postgres. Two workers do the
durable work off the hot path:

- **flush** — drains the queue on an interval and batch-inserts events, **grouped per org** so each
  batch runs inside that org's `withTenant` transaction (RLS applies on write). Metering is
  best-effort this phase: a failed flush increments `relay_metering_flush_failures_total` rather than
  crashing the worker or back-pressuring requests.
- **rollup** — periodically recomputes `usage_rollups_hourly` for the recent window. One
  platform-admin read lists which orgs to rebuild (JOINed to `organizations` so orphaned events from a
  deleted org are skipped); each org is then rebuilt in **its own** tenant transaction. Rebuild is
  **delete-then-insert per org, filtered by explicit `org_id`** — idempotent, and correct even on a
  connection where RLS is bypassed (a superuser test URL). The hourly unique key includes a nullable
  column (`route_id`), so an incremental `ON CONFLICT` upsert would not dedupe — a fresh recompute is
  simpler and race-free.

### Bounded ring queue (`lib/ring-queue.ts`, pure)

Fixed capacity; when full it **drops the oldest** event and counts the drop
(`relay_metering_dropped_total`). Losing the least-recent metering row is preferable to blocking a
live request or exhausting memory under a burst. `stop()` flushes the queue so a graceful shutdown
doesn't lose what's buffered.

### Cost

`cost_usd` is computed at record time from the route target's pricing — which routing already resolved
from `rate_cards` — mirroring the policy module's settle math. A model with no rate card costs 0; a
cache hit (no target) costs 0.

## Consequences

- No migration: `usage_events` (partitioned) and `usage_rollups_hourly` already exist from Week 1; the
  metering module fills them. Both are in the isolation suite (Day 11).
- New env: `RELAY_METERING_QUEUE_MAX`, `RELAY_METERING_FLUSH_INTERVAL_MS`, `RELAY_ROLLUP_INTERVAL_MS`.
- New telemetry: `relay_metering_queue_depth`, `relay_metering_dropped_total`,
  `relay_metering_flush_failures_total`, `relay_rollup_runs_total{result}`.
- Workers start only when serving (a bus is present) and stop on `app.onClose`; the offline spec dump
  constructs the module but never starts them.
- Dashboards (Day 12 analytics) read `usage_rollups_hourly` exclusively, never the raw partitions.
