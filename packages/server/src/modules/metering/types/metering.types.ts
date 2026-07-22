/**
 * Metering module contracts (Week 3 Day 11). Every proxied request lands as ONE normalized usage
 * event; a background worker flushes the in-process ring queue to Postgres and rolls hourly totals up.
 * The write path is fully async so it adds zero hot-path latency (non-negotiable #3).
 */
import type { Queryable } from '../../../platform/db.js';

/** Request outcome recorded on the event — mirrors the `usage_events.status` check constraint. */
export type UsageStatus = 'ok' | 'error' | 'rate_limited' | 'budget_exceeded';

/** One metered request. Nullable ids match the schema (a key/route may be absent, e.g. a cache hit). */
export interface UsageEvent {
  orgId: string;
  appId: string;
  keyId: string | null;
  routeId: string | null;
  requestId: string; // the x-relay-trace-id, for correlation
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  status: UsageStatus;
  latencyMs: number | null;
}

export interface MeteringService {
  /** Non-blocking: enqueue a usage event. Safe to call on the hot path; never awaits Postgres. */
  recordUsage(event: UsageEvent): void;
  /** Start the flush + rollup background workers (serving only; not for the offline spec dump). */
  start(): void;
  /** Flush the queue once and stop the workers — used on graceful shutdown. */
  stop(): Promise<void>;
}

export interface MeteringRepository {
  /** Batch-insert usage events for a single org inside its tenant transaction. */
  insertEvents(tx: Queryable, events: UsageEvent[]): Promise<void>;
  /** Distinct orgs with usage since `sinceHourIso` (read in a platform-admin transaction). */
  listOrgsWithUsageSince(tx: Queryable, sinceHourIso: string): Promise<string[]>;
  /** Recompute one org's hourly rollups for the window — runs inside THAT org's tenant transaction so
   * RLS + the organizations FK line up (current_org must match the rows being written). */
  rebuildRollupsForOrgSince(tx: Queryable, orgId: string, sinceHourIso: string): Promise<void>;
}
