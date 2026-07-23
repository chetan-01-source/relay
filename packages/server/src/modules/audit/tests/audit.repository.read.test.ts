import { describe, it, expect } from 'vitest';
import type { Queryable, SqlQuery } from '../../../platform/db.js';
import { createAuditRepository } from '../repositories/audit.repository.js';

/** Fake Queryable capturing each executed query, returning canned rows by call order. */
function fakeTx(results: unknown[][]): { tx: Queryable; queries: SqlQuery[] } {
  const queries: SqlQuery[] = [];
  let i = 0;
  return {
    queries,
    tx: {
      async run<R>(query: SqlQuery): Promise<R[]> {
        queries.push(query);
        return (results[i++] ?? []) as R[];
      },
    },
  };
}

describe('audit repository — read side', () => {
  it('listWithTx binds org + limit, and adds the before cursor only when given', async () => {
    const repo = createAuditRepository();

    const a = fakeTx([[]]);
    await repo.listWithTx(a.tx, 'org-1', { limit: 50 });
    expect(a.queries[0]?.values).toEqual(['org-1', 50]);
    expect(a.queries[0]?.text).not.toContain('seq <');

    const b = fakeTx([[]]);
    await repo.listWithTx(b.tx, 'org-1', { limit: 50, before: 10 });
    expect(b.queries[0]?.values).toEqual(['org-1', 10, 50]);
    expect(b.queries[0]?.text).toContain('seq < $2');
  });

  it('readChainWithTx selects the chain in ascending seq order for one org', async () => {
    const repo = createAuditRepository();
    const { tx, queries } = fakeTx([[{ seq: '1' }]]);
    await repo.readChainWithTx(tx, 'org-1');
    expect(queries[0]?.values).toEqual(['org-1']);
    expect(queries[0]?.text).toContain('ORDER BY seq ASC');
  });

  it('listOrgsWithTx returns the distinct org ids', async () => {
    const repo = createAuditRepository();
    const { tx } = fakeTx([[{ org_id: 'org-a' }, { org_id: 'org-b' }]]);
    expect(await repo.listOrgsWithTx(tx)).toEqual(['org-a', 'org-b']);
  });
});
