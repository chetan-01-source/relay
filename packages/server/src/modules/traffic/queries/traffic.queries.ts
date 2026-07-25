/**
 * Traffic SQL — the ONLY place this module contains query text. Every value is bound as a parameter
 * and each query runs inside withTenant so RLS limits rows to the caller's org. `status` is bound as
 * a value (never interpolated); the controller validates it against the allowlisted enum first.
 */
import type { SqlQuery } from '../../../platform/db.js';
import type { ListTrafficOptions } from '../types/traffic.types.js';

const COLUMNS = `id, app_id, key_id, route_id, request_id, provider, model,
                 input_tokens, output_tokens, cost_usd::text AS cost_usd, status,
                 latency_ms, created_at`;

/** Most-recent events first, optionally filtered by status. `limit` is bound, not interpolated. */
export function listRecentQuery(opts: ListTrafficOptions): SqlQuery {
  if (opts.status) {
    return {
      text: `SELECT ${COLUMNS} FROM usage_events
              WHERE status = $1 ORDER BY created_at DESC LIMIT $2`,
      values: [opts.status, opts.limit],
    };
  }
  return {
    text: `SELECT ${COLUMNS} FROM usage_events ORDER BY created_at DESC LIMIT $1`,
    values: [opts.limit],
  };
}

/** All events sharing a request/trace id (a request may be metered more than once, e.g. cache + call). */
export function getByRequestIdQuery(requestId: string): SqlQuery {
  return {
    text: `SELECT ${COLUMNS} FROM usage_events
            WHERE request_id = $1 ORDER BY created_at ASC`,
    values: [requestId],
  };
}
