import { describe, it, expect } from 'vitest';
import type { Database, Queryable } from '../../../platform/db.js';
import { canonicalize, computeAuditHash } from '../lib/hash-chain.js';
import { createAuditService } from '../services/audit.service.js';
import type {
  AuditChainRow,
  AuditListOptions,
  AuditListRow,
  AuditReadRepository,
} from '../types/audit.types.js';

function fakeDb(): {
  db: Database;
  calls: { orgId: string; isPlatformAdmin: boolean | undefined }[];
} {
  const calls: { orgId: string; isPlatformAdmin: boolean | undefined }[] = [];
  const db = {
    withTenant: async (
      orgId: string,
      scope: { isPlatformAdmin?: boolean },
      fn: (tx: Queryable) => Promise<unknown>,
    ) => {
      calls.push({ orgId, isPlatformAdmin: scope.isPlatformAdmin });
      return fn({ run: async () => [] });
    },
  } as unknown as Database;
  return { db, calls };
}

function listRow(over: Partial<AuditListRow> = {}): AuditListRow {
  return {
    id: 'id-1',
    seq: '1',
    actor: 'user-1',
    action: 'org.create',
    target: 't1',
    hash: 'deadbeef',
    created_at: '2026-07-24T00:00:00Z',
    ...over,
  };
}

/** A read-repo fake that records the list options it was called with and serves canned data. */
function fakeRepo(opts: {
  listRows?: AuditListRow[];
  chains?: Record<string, AuditChainRow[]>;
  orgs?: string[];
}): AuditReadRepository & { listOpts: AuditListOptions[] } {
  const listOpts: AuditListOptions[] = [];
  return {
    listOpts,
    async listWithTx(_tx, _orgId, o) {
      listOpts.push(o);
      return opts.listRows ?? [];
    },
    async readChainWithTx(_tx, orgId) {
      return opts.chains?.[orgId] ?? [];
    },
    async listOrgsWithTx() {
      return opts.orgs ?? [];
    },
  };
}

/** Build a real chain row (parsed jsonb payload + bytea hash) as verify reads it back. */
function chainRow(
  seq: number,
  payload: Record<string, unknown>,
  prev: Buffer | null,
): AuditChainRow {
  const withSeq = { seq, ...payload };
  return {
    seq: String(seq),
    canonical_json: withSeq,
    hash: computeAuditHash(prev, canonicalize(withSeq)),
  };
}

describe('audit service — list', () => {
  it('reads inside the caller org tenant tx (RLS on) and maps rows to views', async () => {
    const { db, calls } = fakeDb();
    const repo = fakeRepo({ listRows: [listRow({ seq: '7' })] });
    const svc = createAuditService({ db, repo });

    const out = await svc.list('org-1', { limit: 50 });

    expect(calls).toEqual([{ orgId: 'org-1', isPlatformAdmin: false }]);
    expect(out[0]).toEqual({
      object: 'audit.record',
      id: 'id-1',
      seq: 7,
      actor: 'user-1',
      action: 'org.create',
      target: 't1',
      hash: 'deadbeef',
      created_at: '2026-07-24T00:00:00Z',
    });
  });

  it('clamps the limit to [1, 200] and forwards the before cursor', async () => {
    const { db } = fakeDb();
    const repo = fakeRepo({});
    const svc = createAuditService({ db, repo });

    await svc.list('org-1', { limit: 9999, before: 42 });
    await svc.list('org-1', { limit: 0 });

    expect(repo.listOpts[0]).toEqual({ limit: 200, before: 42 });
    expect(repo.listOpts[1]).toEqual({ limit: 1 });
  });
});

describe('audit service — verify', () => {
  it('reports a valid chain', async () => {
    const { db } = fakeDb();
    const g = chainRow(1, { action: 'a' }, null);
    const two = chainRow(2, { action: 'b' }, g.hash);
    const svc = createAuditService({ db, repo: fakeRepo({ chains: { 'org-1': [g, two] } }) });

    expect(await svc.verify('org-1')).toEqual({ orgId: 'org-1', count: 2, valid: true });
  });

  it('reports the break seq on a tampered chain', async () => {
    const { db } = fakeDb();
    const g = chainRow(1, { action: 'a' }, null);
    const tampered: AuditChainRow = { ...g, canonical_json: { seq: 1, action: 'HACKED' } };
    const svc = createAuditService({ db, repo: fakeRepo({ chains: { 'org-1': [tampered] } }) });

    expect(await svc.verify('org-1')).toEqual({
      orgId: 'org-1',
      count: 1,
      valid: false,
      brokenAtSeq: 1,
    });
  });

  it('verifyAll walks every org (listed as platform admin) and returns one result each', async () => {
    const { db, calls } = fakeDb();
    const a = chainRow(1, { action: 'a' }, null);
    const b = chainRow(1, { action: 'b' }, null);
    const svc = createAuditService({
      db,
      repo: fakeRepo({ orgs: ['org-a', 'org-b'], chains: { 'org-a': [a], 'org-b': [b] } }),
    });

    const results = await svc.verifyAll();

    expect(calls[0]?.isPlatformAdmin).toBe(true); // the org-listing read
    expect(results.map((r) => r.orgId).sort()).toEqual(['org-a', 'org-b']);
    expect(results.every((r) => r.valid)).toBe(true);
  });
});
