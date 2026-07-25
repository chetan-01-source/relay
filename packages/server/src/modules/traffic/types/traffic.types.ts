/**
 * Traffic module contracts (Week 3 Day 13) — a read model over `usage_events` (0007) powering the
 * console's live-traffic table and trace-detail view. No new tables: reads are tenant-scoped via
 * withTenant, and the live feed rides the Valkey channel the metering path publishes to. This module
 * owns NO hot-path code.
 */
import type { Queryable } from '../../../platform/db.js';

export type UsageStatus = 'ok' | 'error' | 'rate_limited' | 'budget_exceeded';

/** Row shape straight from usage_events (cost is numeric → arrives as a string). */
export interface TrafficEventRow {
  id: string;
  app_id: string;
  key_id: string | null;
  route_id: string | null;
  request_id: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: string;
  status: UsageStatus;
  latency_ms: number | null;
  created_at: string;
}

/** API shape — cost coerced to a number; `object` tags the resource. */
export interface TrafficEvent {
  object: 'traffic.event';
  id: string;
  app_id: string;
  key_id: string | null;
  route_id: string | null;
  request_id: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  status: UsageStatus;
  latency_ms: number | null;
  created_at: string;
}

export interface ListTrafficOptions {
  limit: number;
  status?: UsageStatus;
}

export interface TrafficRepository {
  listRecent(tx: Queryable, opts: ListTrafficOptions): Promise<TrafficEventRow[]>;
  getByRequestId(tx: Queryable, requestId: string): Promise<TrafficEventRow[]>;
}

export interface TrafficService {
  listRecent(orgId: string, opts: ListTrafficOptions): Promise<TrafficEvent[]>;
  getTrace(orgId: string, requestId: string): Promise<TrafficEvent[]>;
  /** Subscribe to this org's live feed. Returns an unsubscribe fn; a no-op when no bus is configured. */
  subscribe(orgId: string, onEvent: (event: TrafficEvent) => void): () => void;
}

/** The per-org Valkey channel the metering path publishes each settled request to. Kept in sync with
 * the identical string in modules/metering (duplicated deliberately to avoid a cross-module import). */
export function trafficChannel(orgId: string): string {
  return `relay:traffic:${orgId}`;
}
