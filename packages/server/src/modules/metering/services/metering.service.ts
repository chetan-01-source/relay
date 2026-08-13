/**
 * Metering service (Week 3 Day 11) — business logic only. `recordUsage` is a NON-blocking enqueue on
 * the hot path; two background workers do the durable work off-path:
 *   • flush  — drains the ring queue and batch-inserts events, grouped per org so each write runs in
 *              that org's tenant transaction (RLS applies on write);
 *   • rollup — periodically recomputes recent hourly rollups (dashboards read rollups, never the raw
 *              partitions), in ONE platform-admin transaction that spans orgs.
 * Metering is best-effort this phase: a failed flush increments a metric rather than crashing the
 * worker or back-pressuring requests.
 */
import type { Database } from '../../../platform/db.js';
import type { EventBus } from '../../../platform/eventbus.js';
import {
  meteringDropped,
  meteringFlushFailures,
  meteringQueueDepth,
  retentionPruneRuns,
  rollupRuns,
} from '../../../platform/metrics.js';
import { RingQueue } from '../lib/ring-queue.js';
import { createMeteringRepository } from '../repositories/metering.repository.js';
import type {
  MeteringRepository,
  MeteringService,
  RetentionSource,
  UsageEvent,
} from '../types/metering.types.js';

export interface MeteringServiceDeps {
  db: Database;
  repo?: MeteringRepository; // injectable for tests; defaults to the real repository
  bus?: EventBus; // when present, each recorded event is published to the org's live-traffic channel
  queueMax: number;
  flushIntervalMs: number;
  rollupIntervalMs: number;
  /**
   * Supplies each org's `retention.traffic_days` (ADR-0014). Absent ⇒ the prune worker never starts
   * and nothing is ever deleted, which is the correct behaviour for a deployment with no plan layer
   * and for the offline spec dump.
   */
  retention?: RetentionSource;
  /** How often to sweep. Retention is a days-scale promise; hourly is ample and cheap. */
  pruneIntervalMs?: number;
}

// The rollup transaction reads/writes across orgs, so it runs as a platform admin. withTenant still
// needs a syntactically valid org uuid for set_config; the nil uuid is a harmless placeholder since
// the platform_admin_access policy (USING is_platform_admin) ignores app.current_org.
const SYSTEM_ORG = '00000000-0000-0000-0000-000000000000';
// Recompute the current + previous hour each run so events that landed late are still captured.
const ROLLUP_LOOKBACK_MS = 2 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
// Rows deleted per org per sweep. Bounded so a first run against a long-neglected table cannot hold
// a transaction open for minutes and block autovacuum — the next tick continues where this stopped.
const PRUNE_BATCH = 20_000;

/** MeteringService plus the two workers exposed so tests can trigger them without the interval timers. */
export interface MeteringServiceInternal extends MeteringService {
  flush(): Promise<void>;
  rollup(nowMs: number): Promise<void>;
  /** One retention sweep across every org. Exposed so a test can trigger it without the timer. */
  prune(): Promise<number>;
}

export function createMeteringService(deps: MeteringServiceDeps): MeteringServiceInternal {
  const repo = deps.repo ?? createMeteringRepository();
  const queue = new RingQueue<UsageEvent>(deps.queueMax);
  let flushTimer: NodeJS.Timeout | undefined;
  let rollupTimer: NodeJS.Timeout | undefined;
  let pruneTimer: NodeJS.Timeout | undefined;

  function recordUsage(event: UsageEvent): void {
    const accepted = queue.enqueue(event);
    if (!accepted) meteringDropped.inc();
    meteringQueueDepth.set(queue.size);
    // Fire-and-forget publish to the org's live-traffic channel (consumed by modules/traffic's SSE).
    // Never awaited: this is the hot path, and the feed is best-effort. Channel string is duplicated
    // in modules/traffic (trafficChannel) deliberately, to avoid a cross-module import.
    if (deps.bus) {
      const payload = {
        object: 'traffic.event',
        id: event.requestId,
        app_id: event.appId,
        key_id: event.keyId,
        route_id: event.routeId,
        request_id: event.requestId,
        provider: event.provider,
        model: event.model,
        input_tokens: event.inputTokens,
        output_tokens: event.outputTokens,
        cost_usd: event.costUsd,
        status: event.status,
        latency_ms: event.latencyMs,
        created_at: new Date().toISOString(),
      };
      void deps.bus
        .publish(`relay:traffic:${event.orgId}`, JSON.stringify(payload))
        .catch(() => {});
    }
  }

  async function flush(): Promise<void> {
    const batch = queue.drain();
    meteringQueueDepth.set(queue.size);
    if (batch.length === 0) return;

    for (const [orgId, events] of groupByOrg(batch)) {
      try {
        await deps.db.withTenant(orgId, { isPlatformAdmin: false }, (tx) =>
          repo.insertEvents(tx, events),
        );
      } catch {
        // Best-effort: a transient DB error loses this batch but must not kill the worker.
        meteringFlushFailures.inc();
      }
    }
  }

  async function rollup(nowMs: number): Promise<void> {
    const since = new Date(nowMs - ROLLUP_LOOKBACK_MS).toISOString();
    try {
      // One platform-admin read finds which orgs to rebuild; each rebuild then runs in THAT org's
      // tenant transaction so RLS + the organizations FK agree (current_org must match written rows).
      const orgs = await deps.db.withTenant(SYSTEM_ORG, { isPlatformAdmin: true }, (tx) =>
        repo.listOrgsWithUsageSince(tx, since),
      );
      for (const orgId of orgs) {
        // Each org rebuilds independently so one bad org can't abort the whole run.
        try {
          await deps.db.withTenant(orgId, { isPlatformAdmin: false }, (tx) =>
            repo.rebuildRollupsForOrgSince(tx, orgId, since),
          );
        } catch {
          rollupRuns.inc({ result: 'error' });
        }
      }
      rollupRuns.inc({ result: 'ok' });
    } catch {
      rollupRuns.inc({ result: 'error' });
    }
  }

  /**
   * Enforce `retention.traffic_days` (docs/plans.md §3). Walks every org with traffic, asks the
   * retention source how long that org keeps it, and deletes past the window.
   *
   * Each org is pruned in its OWN tenant transaction so RLS applies to the delete — a retention
   * sweep is the last place a cross-tenant delete should be possible. A failure on one org is
   * swallowed and the sweep continues: retention is a background promise, not a request, and one
   * org's problem must not stop everyone else's data from expiring.
   */
  async function prune(): Promise<number> {
    if (!deps.retention) return 0;
    let deleted = 0;
    try {
      const orgs = await deps.db.withTenant(SYSTEM_ORG, { isPlatformAdmin: true }, (tx) =>
        repo.listOrgsWithUsage(tx),
      );
      for (const orgId of orgs) {
        try {
          const days = await deps.retention.trafficDaysFor(orgId);
          if (days === null || days <= 0) continue; // unlimited — keep everything
          deleted += await deps.db.withTenant(orgId, { isPlatformAdmin: false }, (tx) =>
            repo.pruneUsageEvents(tx, orgId, days, PRUNE_BATCH),
          );
        } catch {
          retentionPruneRuns.inc({ result: 'error' });
        }
      }
      retentionPruneRuns.inc({ result: 'ok' });
    } catch {
      retentionPruneRuns.inc({ result: 'error' });
    }
    return deleted;
  }

  function start(): void {
    if (flushTimer) return; // idempotent
    flushTimer = setInterval(() => void flush(), deps.flushIntervalMs);
    rollupTimer = setInterval(() => void rollup(Date.now()), deps.rollupIntervalMs);
    // Only when a retention source was supplied — no plan layer means nothing to enforce, and a
    // timer that would delete data must not exist unless something asked for it.
    if (deps.retention) {
      pruneTimer = setInterval(() => void prune(), deps.pruneIntervalMs ?? PRUNE_INTERVAL_MS);
      pruneTimer.unref();
    }
    // Don't let the metering timers keep the process alive on their own.
    flushTimer.unref();
    rollupTimer.unref();
  }

  async function stop(): Promise<void> {
    if (flushTimer) clearInterval(flushTimer);
    if (rollupTimer) clearInterval(rollupTimer);
    if (pruneTimer) clearInterval(pruneTimer);
    flushTimer = undefined;
    rollupTimer = undefined;
    pruneTimer = undefined;
    await flush(); // drain what's queued so a graceful shutdown doesn't lose it
  }

  // flush/rollup are exposed (beyond the MeteringService interface) so tests can trigger them
  // deterministically instead of waiting on the interval timers.
  return { recordUsage, start, stop, flush, rollup, prune };
}

/** Group a mixed batch by org so each org's rows insert inside that org's tenant transaction. */
function groupByOrg(events: UsageEvent[]): Map<string, UsageEvent[]> {
  const byOrg = new Map<string, UsageEvent[]>();
  for (const event of events) {
    const bucket = byOrg.get(event.orgId);
    if (bucket) bucket.push(event);
    else byOrg.set(event.orgId, [event]);
  }
  return byOrg;
}
