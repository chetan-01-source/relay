/**
 * Control-plane org resolver — the bridge between Logto's tenant identity and ours.
 *
 * A verified control-plane JWT carries `organization_id`, which is **Logto's** org id. Every tenant
 * table FKs to `organizations.id` (a uuid) and the RLS policy is
 * `org_id = current_setting('app.current_org')::uuid`, so passing the claim through untranslated
 * raises `invalid input syntax for type uuid` on the first query. This service performs that
 * translation once per org and caches it.
 *
 * Only the **id** is cached, and that is what makes a plain LRU sound here: `logto_org_id` is
 * assigned at onboarding and never rewritten (it carries a UNIQUE constraint), so the mapping is
 * immutable and a hit cannot go stale. Mutable state — org status in particular — is intentionally
 * not cached and not gated on here; the control plane has never suspended on this path, and adding
 * it would need the ≤1s push-invalidation the data-plane resolver uses.
 */
import type { SnapshotCache } from '../lib/snapshot-cache.js';
import type { IdentityRepository } from '../types/identity.types.js';

export interface OrgResolver {
  /** Map a Logto org id to our `organizations.id`, or null when no org matches the claim. */
  resolve(logtoOrgId: string): Promise<string | null>;
  /** Drop a cached mapping (an org was deleted). */
  invalidate(logtoOrgId: string): void;
}

export interface OrgResolverDeps {
  repo: IdentityRepository;
  cache: SnapshotCache<string>;
}

export function createOrgResolver(deps: OrgResolverDeps): OrgResolver {
  const { repo, cache } = deps;

  return {
    async resolve(logtoOrgId) {
      if (!logtoOrgId) return null;

      const cached = cache.get(logtoOrgId);
      if (cached !== undefined) return cached;

      const found = await repo.resolveOrgByLogtoId(logtoOrgId);
      // A miss is NOT cached: an org onboarded a moment after this lookup must resolve on the very
      // next request, not after an eviction.
      if (!found) return null;

      cache.set(logtoOrgId, found.id);
      return found.id;
    },

    invalidate(logtoOrgId) {
      cache.delete(logtoOrgId);
    },
  };
}
