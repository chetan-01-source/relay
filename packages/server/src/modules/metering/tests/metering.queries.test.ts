/**
 * Metering SQL. Usage events are what every invoice and every budget decision is computed from, so
 * these queries decide whether spend is attributed to the right tenant and whether pruning deletes
 * the rows it meant to.
 */
import { describe, expect, it } from 'vitest';
import {
  deleteRollupsForOrgSinceQuery,
  insertUsageEventsQuery,
  listOrgsWithUsageQuery,
  listOrgsWithUsageSinceQuery,
  pruneUsageEventsQuery,
  rebuildRollupsForOrgSinceQuery,
} from '../queries/metering.queries.js';
import type { UsageEvent } from '../types/metering.types.js';

const ORG = '11111111-1111-1111-1111-111111111111';
const SINCE = '2026-08-15T00:00:00.000Z';

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    orgId: ORG,
    appId: 'app-1',
    keyId: null,
    routeId: null,
    requestId: 'req-1',
    provider: 'openai',
    model: 'gpt-4o',
    inputTokens: 10,
    outputTokens: 20,
    costUsd: 0.0003,
    status: 'ok',
    latencyMs: 120,
    ...overrides,
  };
}

describe('insertUsageEventsQuery', () => {
  it('binds one row as twelve parameters', () => {
    const query = insertUsageEventsQuery([event()]);
    expect(query.text).toContain('INSERT INTO usage_events');
    expect(query.text).toContain('($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)');
    expect(query.values).toHaveLength(12);
    expect(query.values[0]).toBe(ORG);
  });

  /**
   * The flush path batches, so the placeholder offset per row has to be right. Getting it wrong
   * would not error — it would silently attribute one org's tokens and cost to another.
   */
  it('offsets placeholders per row so batched values stay aligned', () => {
    const query = insertUsageEventsQuery([
      event({ requestId: 'req-1' }),
      event({ orgId: 'org-2', requestId: 'req-2' }),
    ]);
    expect(query.text).toContain('($13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)');
    expect(query.values).toHaveLength(24);
    expect(query.values[12]).toBe('org-2');
    expect(query.values[16]).toBe('req-2');
  });

  it('keeps an absent key or route as a bound null, not an empty string', () => {
    // A cached hit has no key or route; the columns are nullable and must receive real nulls.
    const query = insertUsageEventsQuery([event()]);
    expect(query.values[2]).toBeNull();
    expect(query.values[3]).toBeNull();
  });
});

describe('rollup queries', () => {
  it('lists orgs with usage since an hour, excluding orphaned events', () => {
    const query = listOrgsWithUsageSinceQuery(SINCE);
    // usage_events has no FK, so a deleted org can leave rows behind; rebuilding those would fail.
    expect(query.text).toContain('organizations');
    expect(query.values).toEqual([SINCE]);
  });

  it('scopes a rollup delete to one org and one window', () => {
    const query = deleteRollupsForOrgSinceQuery(ORG, SINCE);
    expect(query.text).toContain('DELETE');
    expect(query.values).toEqual([ORG, SINCE]);
  });

  it('rebuilds rollups for one org from the raw events', () => {
    const query = rebuildRollupsForOrgSinceQuery(ORG, SINCE);
    expect(query.text).toContain('usage_rollups_hourly');
    expect(query.values).toEqual([ORG, SINCE]);
  });

  it('lists every org with usage, taking no parameters', () => {
    expect(listOrgsWithUsageQuery().values).toEqual([]);
  });
});

describe('pruneUsageEventsQuery', () => {
  it('binds the org, retention window and batch size', () => {
    const query = pruneUsageEventsQuery(ORG, 90, 1000);
    expect(query.values).toEqual([ORG, 90, 1000]);
  });

  /**
   * usage_events is RANGE partitioned, and a ctid is only unique WITHIN a partition — matching on
   * one would delete the wrong rows as soon as the table spans more than a single partition.
   */
  it('matches rows on the full primary key rather than ctid', () => {
    const query = pruneUsageEventsQuery(ORG, 90, 1000);
    expect(query.text).not.toContain('ctid');
    expect(query.text).toContain('ue.id = d.id AND ue.created_at = d.created_at');
  });

  it('bounds each pass with a LIMIT so a prune cannot lock the table indefinitely', () => {
    expect(pruneUsageEventsQuery(ORG, 90, 1000).text).toContain('LIMIT $3');
  });
});
