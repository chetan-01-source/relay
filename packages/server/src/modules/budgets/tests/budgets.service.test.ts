import { describe, it, expect, vi } from 'vitest';
import { RelayError } from 'relay-shared';
import { createBudgetsService } from '../services/budgets.service.js';
import type { BudgetRow, BudgetsRepository } from '../types/budgets.types.js';
import type { Database, Queryable } from '../../../platform/db.js';
import type { AuditRepository } from '../../audit/index.js';
import type { EventBus } from '../../../platform/eventbus.js';

const ORG = '0744ded6-30b6-4990-a3df-3f2ce74d632c';

function row(over: Partial<BudgetRow> = {}): BudgetRow {
  return {
    id: 'b1',
    org_id: ORG,
    app_id: null,
    period: 'monthly',
    limit_usd: '50.0000',
    hard_cutoff: true,
    created_at: '2026-08-09T00:00:00Z',
    updated_at: '2026-08-09T00:00:00Z',
    ...over,
  };
}

/** A db whose withTenant just runs the callback — the transaction itself isn't under test here. */
function fakeDb(): Database {
  return {
    withTenant: <T>(_org: string, _scope: unknown, fn: (tx: Queryable) => Promise<T>) =>
      fn({} as Queryable),
  } as unknown as Database;
}

function subject(opts: { existing?: BudgetRow | null; bus?: EventBus } = {}) {
  const appended: { action: string; data?: unknown }[] = [];
  const audit = {
    appendWithTx: (_tx: unknown, _org: string, event: { action: string; data?: unknown }) => {
      appended.push(event);
      return Promise.resolve({ seq: 1 });
    },
  } as unknown as AuditRepository;

  const saved: BudgetRow[] = [];
  const removed: string[] = [];
  const repo: BudgetsRepository = {
    list: () => Promise.resolve([row()]),
    get: () => Promise.resolve(opts.existing ?? null),
    upsert: (_tx, _org, appId, period, input) => {
      const next = row({
        app_id: appId,
        period,
        limit_usd: input.limitUsd.toFixed(4),
        hard_cutoff: input.hardCutoff,
      });
      saved.push(next);
      return Promise.resolve(next);
    },
    remove: (_tx, _org, _appId, period) => {
      removed.push(period);
      return Promise.resolve(true);
    },
  };

  const service = createBudgetsService({
    db: fakeDb(),
    repo,
    audit,
    ...(opts.bus ? { bus: opts.bus } : {}),
  });
  return { service, appended, saved, removed };
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err instanceof RelayError ? err.code : 'unknown';
  }
}

describe('setBudget validation', () => {
  it('rejects a non-positive limit and points at the parameter', async () => {
    const { service } = subject();
    expect(
      await codeOf(() =>
        service.setBudget('u1', ORG, null, 'monthly', { limitUsd: 0, hardCutoff: true }),
      ),
    ).toBe('invalid_request');
    expect(
      await codeOf(() =>
        service.setBudget('u1', ORG, null, 'monthly', { limitUsd: -5, hardCutoff: true }),
      ),
    ).toBe('invalid_request');
  });

  it('rejects a non-finite limit instead of letting the driver 500', async () => {
    const { service } = subject();
    expect(
      await codeOf(() =>
        service.setBudget('u1', ORG, null, 'monthly', { limitUsd: Number.NaN, hardCutoff: true }),
      ),
    ).toBe('invalid_request');
  });

  it('rejects a limit the numeric(12,4) column cannot hold', async () => {
    const { service } = subject();
    expect(
      await codeOf(() =>
        service.setBudget('u1', ORG, null, 'monthly', { limitUsd: 1e12, hardCutoff: true }),
      ),
    ).toBe('invalid_request');
  });

  it('accepts a normal limit', async () => {
    const { service, saved } = subject();
    const budget = await service.setBudget('u1', ORG, null, 'monthly', {
      limitUsd: 50,
      hardCutoff: true,
    });
    expect(budget.limit_usd).toBe(50);
    expect(budget.object).toBe('budget');
    expect(saved).toHaveLength(1);
  });
});

describe('setBudget auditing', () => {
  it('records a create when no budget existed', async () => {
    const { service, appended } = subject({ existing: null });
    await service.setBudget('u1', ORG, null, 'monthly', { limitUsd: 50, hardCutoff: true });
    expect(appended[0]?.action).toBe('budget.create');
  });

  it('records an update carrying the previous ceiling, so a change is readable after the fact', async () => {
    const { service, appended } = subject({ existing: row({ limit_usd: '10.0000' }) });
    await service.setBudget('u1', ORG, null, 'monthly', { limitUsd: 500, hardCutoff: false });
    expect(appended[0]?.action).toBe('budget.update');
    expect(appended[0]?.data).toMatchObject({
      limit_usd: 500,
      previous_limit_usd: 10,
      hard_cutoff: false,
    });
  });
});

describe('invalidation', () => {
  it('publishes so workers drop cached snapshots — a lowered ceiling must bite at once', async () => {
    const publish = vi.fn().mockResolvedValue(1);
    const bus = { publish } as unknown as EventBus;
    const { service } = subject({ bus });

    await service.setBudget('u1', ORG, null, 'monthly', { limitUsd: 5, hardCutoff: true });
    expect(publish).toHaveBeenCalledWith('org.policy.updated', expect.stringContaining(ORG));
  });

  it('publishes on delete too — removing a ceiling has to propagate as well', async () => {
    const publish = vi.fn().mockResolvedValue(1);
    const bus = { publish } as unknown as EventBus;
    const { service } = subject({ existing: row(), bus });

    await service.deleteBudget('u1', ORG, null, 'monthly');
    expect(publish).toHaveBeenCalledWith('org.policy.updated', expect.stringContaining(ORG));
  });

  it('works without a bus (the offline OpenAPI dump has none)', async () => {
    const { service } = subject({ existing: row() });
    await expect(service.deleteBudget('u1', ORG, null, 'monthly')).resolves.toBeUndefined();
  });
});

describe('deleteBudget', () => {
  it('404s when there is no budget for that period, rather than silently succeeding', async () => {
    const { service, removed } = subject({ existing: null });
    expect(await codeOf(() => service.deleteBudget('u1', ORG, null, 'daily'))).toBe('not_found');
    expect(removed).toEqual([]);
  });

  it('audits the removal with the ceiling that was lifted', async () => {
    const { service, appended } = subject({ existing: row({ limit_usd: '25.0000' }) });
    await service.deleteBudget('u1', ORG, null, 'monthly');
    expect(appended[0]?.action).toBe('budget.delete');
    expect(appended[0]?.data).toMatchObject({ period: 'monthly', limit_usd: 25 });
  });
});

describe('listBudgets', () => {
  it('converts pg numeric text into a JSON number', async () => {
    const { service } = subject();
    const [budget] = await service.listBudgets(ORG);
    expect(budget?.limit_usd).toBe(50);
    expect(typeof budget?.limit_usd).toBe('number');
  });
});
