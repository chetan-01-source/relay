import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { Database, Queryable } from '../../../platform/db.js';
import { createTrafficService } from '../services/traffic.service.js';
import type { TrafficEvent, TrafficEventRow, TrafficRepository } from '../types/traffic.types.js';
import { trafficChannel } from '../types/traffic.types.js';

const fakeDb = {
  withTenant: <T>(_o: string, _s: unknown, fn: (tx: Queryable) => Promise<T>) =>
    fn({} as Queryable),
} as unknown as Database;

function row(over: Partial<TrafficEventRow> = {}): TrafficEventRow {
  return {
    id: 'e1',
    app_id: 'app-1',
    key_id: 'key-1',
    route_id: 'route-1',
    request_id: 'trace-1',
    provider: 'openai',
    model: 'gpt-4o',
    input_tokens: 10,
    output_tokens: 20,
    cost_usd: '0.001234', // numeric arrives as a string
    status: 'ok',
    latency_ms: 42,
    created_at: '2026-07-25T00:00:00Z',
    ...over,
  };
}

function fakeRepo(rows: TrafficEventRow[]): TrafficRepository {
  return {
    listLogs: () => Promise.resolve([]),
    listRecent: () => Promise.resolve(rows),
    getByRequestId: (_tx, requestId) =>
      Promise.resolve(rows.filter((r) => r.request_id === requestId)),
  };
}

describe('traffic service · reads', () => {
  it('listRecent coerces cost_usd to a number and tags the object', async () => {
    const svc = createTrafficService({ db: fakeDb, repo: fakeRepo([row()]) });
    const [event] = await svc.listRecent('org-1', { limit: 50 });
    expect(event!.object).toBe('traffic.event');
    expect(event!.cost_usd).toBe(0.001234);
    expect(typeof event!.cost_usd).toBe('number');
  });

  it('getTrace returns only the events sharing the request id', async () => {
    const svc = createTrafficService({
      db: fakeDb,
      repo: fakeRepo([row(), row({ id: 'e2', request_id: 'other' })]),
    });
    const events = await svc.getTrace('org-1', 'trace-1');
    expect(events).toHaveLength(1);
    expect(events[0]!.request_id).toBe('trace-1');
  });
});

describe('traffic service · live feed', () => {
  it('is a no-op (unsubscribe still callable) when no Valkey client is configured', () => {
    const svc = createTrafficService({ db: fakeDb, repo: fakeRepo([]) });
    const off = svc.subscribe('org-1', () => {});
    expect(() => off()).not.toThrow();
  });

  it('subscribes on a dedicated connection and delivers only its channel, parsed', () => {
    let handler: ((ch: string, msg: string) => void) | undefined;
    const sub = {
      subscribe: vi.fn(() => Promise.resolve()),
      on: vi.fn((_ev: string, fn: (ch: string, msg: string) => void) => {
        handler = fn;
      }),
      quit: vi.fn(() => Promise.resolve()),
    };
    const duplicate = vi.fn(() => sub);
    const client = { duplicate } as unknown as Redis;
    const svc = createTrafficService({ db: fakeDb, repo: fakeRepo([]), client });

    const seen: TrafficEvent[] = [];
    const off = svc.subscribe('org-1', (e) => seen.push(e));
    expect(duplicate).toHaveBeenCalledOnce();
    expect(sub.subscribe).toHaveBeenCalledWith(trafficChannel('org-1'));

    const evt = { object: 'traffic.event', id: 'x' };
    handler!('other-channel', JSON.stringify(evt)); // wrong channel → ignored
    handler!(trafficChannel('org-1'), 'not json'); // malformed → ignored, no throw
    handler!(trafficChannel('org-1'), JSON.stringify(evt)); // delivered
    expect(seen).toHaveLength(1);
    expect(seen[0]!.id).toBe('x');

    off();
    expect(sub.quit).toHaveBeenCalledOnce();
  });
});
