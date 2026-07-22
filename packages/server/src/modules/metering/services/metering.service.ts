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
import {
  meteringDropped,
  meteringFlushFailures,
  meteringQueueDepth,
  rollupRuns,
} from '../../../platform/metrics.js';
import { RingQueue } from '../lib/ring-queue.js';
import { createMeteringRepository } from '../repositories/metering.repository.js';
import type { MeteringRepository, MeteringService, UsageEvent } from '../types/metering.types.js';

export interface MeteringServiceDeps {
  db: Database;
  repo?: MeteringRepository; // injectable for tests; defaults to the real repository
  queueMax: number;
  flushIntervalMs: number;
  rollupIntervalMs: number;
}

// The rollup transaction reads/writes across orgs, so it runs as a platform admin. withTenant still
// needs a syntactically valid org uuid for set_config; the nil uuid is a harmless placeholder since
// the platform_admin_access policy (USING is_platform_admin) ignores app.current_org.
const SYSTEM_ORG = '00000000-0000-0000-0000-000000000000';
// Recompute the current + previous hour each run so events that landed late are still captured.
const ROLLUP_LOOKBACK_MS = 2 * 60 * 60 * 1000;

/** MeteringService plus the two workers exposed so tests can trigger them without the interval timers. */
export interface MeteringServiceInternal extends MeteringService {
  flush(): Promise<void>;
  rollup(nowMs: number): Promise<void>;
}

export function createMeteringService(deps: MeteringServiceDeps): MeteringServiceInternal {
  const repo = deps.repo ?? createMeteringRepository();
  const queue = new RingQueue<UsageEvent>(deps.queueMax);
  let flushTimer: NodeJS.Timeout | undefined;
  let rollupTimer: NodeJS.Timeout | undefined;

  function recordUsage(event: UsageEvent): void {
    const accepted = queue.enqueue(event);
    if (!accepted) meteringDropped.inc();
    meteringQueueDepth.set(queue.size);
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

  function start(): void {
    if (flushTimer) return; // idempotent
    flushTimer = setInterval(() => void flush(), deps.flushIntervalMs);
    rollupTimer = setInterval(() => void rollup(Date.now()), deps.rollupIntervalMs);
    // Don't let the metering timers keep the process alive on their own.
    flushTimer.unref();
    rollupTimer.unref();
  }

  async function stop(): Promise<void> {
    if (flushTimer) clearInterval(flushTimer);
    if (rollupTimer) clearInterval(rollupTimer);
    flushTimer = undefined;
    rollupTimer = undefined;
    await flush(); // drain what's queued so a graceful shutdown doesn't lose it
  }

  // flush/rollup are exposed (beyond the MeteringService interface) so tests can trigger them
  // deterministically instead of waiting on the interval timers.
  return { recordUsage, start, stop, flush, rollup };
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
