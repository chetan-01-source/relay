/**
 * Traffic SQL — the ONLY place this module contains query text. Every value is bound as a parameter
 * and each query runs inside withTenant so RLS limits rows to the caller's org. `status` is bound as
 * a value (never interpolated); the controller validates it against the allowlisted enum first.
 */
import type { SqlQuery } from '../../../platform/db.js';
import type { ListLogsOptions, ListTrafficOptions } from '../types/traffic.types.js';

const COLUMNS = `id, app_id, key_id, route_id, request_id, provider, model,
                 input_tokens, output_tokens, cost_usd::text AS cost_usd, status,
                 latency_ms, created_at`;

/**
 * The log view: most-recent first, every filter optional, keyset-paginated.
 *
 * One statement with `IS NULL` guards rather than clauses concatenated in JavaScript, so the shape
 * is fixed and every value stays a bound parameter (§3.4) — `search` in particular arrives straight
 * from a text box.
 *
 * Paging is KEYSET, not OFFSET. `usage_events` is append-heavy and RANGE partitioned; `OFFSET 5000`
 * makes Postgres walk and discard 5,000 rows on every page, and a row inserted mid-browse shifts the
 * window so an event can be shown twice or skipped. Comparing against the last row's
 * `(created_at, id)` — the table's own primary key order — is stable under concurrent inserts and
 * costs the same on page 50 as on page 1.
 */
export function listLogsQuery(opts: ListLogsOptions): SqlQuery {
  return {
    text: `SELECT ${COLUMNS} FROM usage_events
            WHERE ($1::text IS NULL OR status = $1)
              AND ($2::text IS NULL OR model = $2)
              AND ($3::text IS NULL OR provider = $3)
              AND ($4::uuid IS NULL OR app_id = $4)
              AND ($5::timestamptz IS NULL OR created_at >= $5)
              AND ($6::timestamptz IS NULL OR created_at < $6)
              AND ($7::text IS NULL OR request_id ILIKE '%' || $7 || '%' OR model ILIKE '%' || $7 || '%')
              AND ($8::timestamptz IS NULL OR (created_at, id) < ($8, $9::uuid))
         ORDER BY created_at DESC, id DESC
            LIMIT $10`,
    values: [
      opts.status ?? null,
      opts.model ?? null,
      opts.provider ?? null,
      opts.appId ?? null,
      opts.from ?? null,
      opts.to ?? null,
      opts.search ?? null,
      opts.beforeCreatedAt ?? null,
      opts.beforeId ?? null,
      opts.limit,
    ],
  };
}

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
