/**
 * Traffic service (Week 3 Day 13) — business logic of the request feed. Reads are tenant-scoped via
 * withTenant (RLS isolates them); the live feed subscribes to the org's Valkey channel on a dedicated
 * connection so one SSE client's disconnect never affects another. Contains no SQL and no HTTP types.
 */
import type { Redis } from 'ioredis';
import type { Database, Queryable } from '../../../platform/db.js';
import type {
  ListTrafficOptions,
  TrafficEvent,
  TrafficEventRow,
  TrafficRepository,
  TrafficService,
} from '../types/traffic.types.js';
import { trafficChannel } from '../types/traffic.types.js';

export interface TrafficServiceDeps {
  db: Database;
  repo: TrafficRepository;
  /** The shared Valkey client; absent (offline spec dump / no bus) → the live feed is a no-op. */
  client?: Redis;
}

export function createTrafficService(deps: TrafficServiceDeps): TrafficService {
  const { db, repo, client } = deps;

  function listRecent(orgId: string, opts: ListTrafficOptions): Promise<TrafficEvent[]> {
    return db.withTenant(orgId, { isPlatformAdmin: false }, async (tx: Queryable) => {
      const rows = await repo.listRecent(tx, opts);
      return rows.map(toApi);
    });
  }

  function getTrace(orgId: string, requestId: string): Promise<TrafficEvent[]> {
    return db.withTenant(orgId, { isPlatformAdmin: false }, async (tx: Queryable) => {
      const rows = await repo.getByRequestId(tx, requestId);
      return rows.map(toApi);
    });
  }

  function subscribe(orgId: string, onEvent: (event: TrafficEvent) => void): () => void {
    if (!client) return () => {};
    const channel = trafficChannel(orgId);
    // A dedicated subscriber connection: a Redis client in subscribe mode can't run other commands,
    // so each SSE stream gets its own, torn down when the client disconnects.
    const sub = client.duplicate();
    void sub.subscribe(channel).catch(() => {});
    sub.on('message', (ch: string, msg: string) => {
      if (ch !== channel) return;
      try {
        onEvent(JSON.parse(msg) as TrafficEvent);
      } catch {
        // ignore malformed payloads — the feed is best-effort
      }
    });
    return () => {
      void sub.quit().catch(() => {});
    };
  }

  return { listRecent, getTrace, subscribe };
}

/** Coerce a DB row to the API shape (numeric cost arrives as a string). */
function toApi(row: TrafficEventRow): TrafficEvent {
  return {
    object: 'traffic.event',
    id: row.id,
    app_id: row.app_id,
    key_id: row.key_id,
    route_id: row.route_id,
    request_id: row.request_id,
    provider: row.provider,
    model: row.model,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cost_usd: Number(row.cost_usd),
    status: row.status,
    latency_ms: row.latency_ms,
    created_at: row.created_at,
  };
}
