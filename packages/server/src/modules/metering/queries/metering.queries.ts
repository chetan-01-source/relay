/**
 * Metering SQL — the ONLY place this module holds query text; every value is bound as a parameter.
 * usage_events is partitioned by month with a DEFAULT partition, so a plain INSERT routes itself.
 * Rollups are rebuilt (delete-then-insert) per run rather than incrementally UPSERTed: the hourly
 * unique key includes nullable columns (route_id), where ON CONFLICT would not dedupe — a fresh
 * recompute of the recent window is simpler and idempotent.
 */
import type { SqlQuery } from '../../../platform/db.js';
import type { UsageEvent } from '../types/metering.types.js';

const EVENT_COLUMNS = 12;

/** Batch INSERT for a single org's events. Placeholder tuples are built from the row COUNT (static
 * structure), while every value is bound — so this stays fully parametrized. */
export function insertUsageEventsQuery(events: UsageEvent[]): SqlQuery {
  const tuples: string[] = [];
  const values: unknown[] = [];
  events.forEach((e, i) => {
    const base = i * EVENT_COLUMNS;
    tuples.push(
      `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12})`,
    );
    values.push(
      e.orgId,
      e.appId,
      e.keyId,
      e.routeId,
      e.requestId,
      e.provider,
      e.model,
      e.inputTokens,
      e.outputTokens,
      e.costUsd,
      e.status,
      e.latencyMs,
    );
  });
  return {
    text: `INSERT INTO usage_events
             (org_id, app_id, key_id, route_id, request_id, provider, model,
              input_tokens, output_tokens, cost_usd, status, latency_ms)
           VALUES ${tuples.join(',')}`,
    values,
  };
}

/**
 * Distinct orgs that logged usage in the window. The JOIN to organizations excludes orphaned events
 * (usage_events has no FK, so a deleted org can leave rows behind) — we only rebuild orgs that exist.
 */
export function listOrgsWithUsageSinceQuery(sinceHourIso: string): SqlQuery {
  return {
    text: `SELECT DISTINCT ue.org_id
             FROM usage_events ue
             JOIN organizations o ON o.id = ue.org_id
            WHERE ue.created_at >= date_trunc('hour', $1::timestamptz)`,
    values: [sinceHourIso],
  };
}

/** Clear ONE org's rollups for the recompute window so the following INSERT can rebuild them cleanly. */
export function deleteRollupsForOrgSinceQuery(orgId: string, sinceHourIso: string): SqlQuery {
  return {
    text: `DELETE FROM usage_rollups_hourly
            WHERE org_id = $1 AND hour >= date_trunc('hour', $2::timestamptz)`,
    values: [orgId, sinceHourIso],
  };
}

/**
 * Recompute ONE org's hourly rollups from its raw events in the window. The explicit org_id filter
 * (not only RLS) keeps the aggregate correct even on a connection where RLS is bypassed (superuser).
 */
export function rebuildRollupsForOrgSinceQuery(orgId: string, sinceHourIso: string): SqlQuery {
  return {
    text: `INSERT INTO usage_rollups_hourly
             (org_id, hour, app_id, route_id, provider, model,
              requests, input_tokens, output_tokens, cost_usd)
           SELECT org_id,
                  date_trunc('hour', created_at) AS hour,
                  app_id, route_id, provider, model,
                  count(*), sum(input_tokens), sum(output_tokens), sum(cost_usd)
             FROM usage_events
            WHERE org_id = $1 AND created_at >= date_trunc('hour', $2::timestamptz)
            GROUP BY org_id, date_trunc('hour', created_at), app_id, route_id, provider, model`,
    values: [orgId, sinceHourIso],
  };
}
