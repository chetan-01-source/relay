import { describe, it, expect } from 'vitest';
import { createOrgResolver } from '../services/org-resolver.js';
import { createLruCache } from '../lib/snapshot-cache.js';
import type { IdentityRepository, OrgIdentity } from '../types/identity.types.js';

const RELAY_UUID = '0744ded6-30b6-4990-a3df-3f2ce74d632c';
const LOGTO_ID = '9rfrjhfmx0hk';

/** A fake repository that counts reads, so caching is provable rather than assumed. */
function fakeRepo(orgs: Record<string, OrgIdentity>) {
  const reads = { count: 0 };
  const repo: IdentityRepository = {
    resolveByKeyId: () => Promise.resolve(null),
    getOrgMemberRole: () => Promise.resolve('member' as const),
    resolveOrgByLogtoId(logtoOrgId) {
      reads.count += 1;
      return Promise.resolve(orgs[logtoOrgId] ?? null);
    },
  };
  return { repo, reads };
}

function subject(orgs: Record<string, OrgIdentity>) {
  const { repo, reads } = fakeRepo(orgs);
  return { resolver: createOrgResolver({ repo, cache: createLruCache<string>(10) }), reads };
}

describe('createOrgResolver', () => {
  it('translates a Logto org id to our tenant uuid', async () => {
    // This is the whole point: RLS casts app.current_org to uuid, so Logto's id cannot be passed
    // through — it would raise `invalid input syntax for type uuid` on the first tenant query.
    const { resolver } = subject({ [LOGTO_ID]: { id: RELAY_UUID, status: 'active' } });
    await expect(resolver.resolve(LOGTO_ID)).resolves.toBe(RELAY_UUID);
  });

  it('caches the mapping — a second resolve does not hit the database', async () => {
    const { resolver, reads } = subject({ [LOGTO_ID]: { id: RELAY_UUID, status: 'active' } });
    await resolver.resolve(LOGTO_ID);
    await resolver.resolve(LOGTO_ID);
    expect(reads.count).toBe(1);
  });

  it('returns null for a claim naming an org we do not know', async () => {
    const { resolver } = subject({});
    await expect(resolver.resolve('someone-elses-org')).resolves.toBeNull();
  });

  it('does not cache a miss, so a newly onboarded org resolves on the next request', async () => {
    const orgs: Record<string, OrgIdentity> = {};
    const { repo, reads } = fakeRepo(orgs);
    const resolver = createOrgResolver({ repo, cache: createLruCache<string>(10) });

    await expect(resolver.resolve(LOGTO_ID)).resolves.toBeNull();
    orgs[LOGTO_ID] = { id: RELAY_UUID, status: 'active' }; // onboarded a moment later
    await expect(resolver.resolve(LOGTO_ID)).resolves.toBe(RELAY_UUID);
    expect(reads.count).toBe(2);
  });

  it('resolves an empty claim to null without touching the database', async () => {
    const { resolver, reads } = subject({});
    await expect(resolver.resolve('')).resolves.toBeNull();
    expect(reads.count).toBe(0);
  });

  it('re-reads after invalidate', async () => {
    const { resolver, reads } = subject({ [LOGTO_ID]: { id: RELAY_UUID, status: 'active' } });
    await resolver.resolve(LOGTO_ID);
    resolver.invalidate(LOGTO_ID);
    await resolver.resolve(LOGTO_ID);
    expect(reads.count).toBe(2);
  });
});
