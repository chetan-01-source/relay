/**
 * Tenancy repository (DEVELOPMENT.md §2) — data access only. Runs the parametrized queries against
 * the caller's transaction (a Queryable produced by withTenant), so a multi-step onboarding or
 * suspend commits atomically. Contains NO query text and NO business logic.
 */
import {
  insertOrgQuery,
  getOrgByIdQuery,
  listOrgsQuery,
  updateOrgStatusQuery,
  updateOnboardingStateQuery,
  upsertOrgFeatureQuery,
  listOrgFeaturesQuery,
} from '../queries/tenancy.queries.js';
import type { OrgFeatureRow, OrgRow, TenancyRepository } from '../types/tenancy.types.js';

export function createTenancyRepository(): TenancyRepository {
  return {
    async createOrg(tx, input) {
      const rows = await tx.run<OrgRow>(insertOrgQuery(input.logtoOrgId, input.name));
      return rows[0]!;
    },
    async getOrg(tx, orgId) {
      const rows = await tx.run<OrgRow>(getOrgByIdQuery(orgId));
      return rows[0] ?? null;
    },
    listOrgs(tx) {
      return tx.run<OrgRow>(listOrgsQuery());
    },
    async setStatus(tx, orgId, status) {
      await tx.run(updateOrgStatusQuery(orgId, status));
    },
    async setOnboardingState(tx, orgId, state) {
      await tx.run(updateOnboardingStateQuery(orgId, state));
    },
    async upsertFeatures(tx, orgId, features) {
      // One upsert per flag — the set is tiny (a handful of keys) and stays readable + parametrized.
      for (const [key, value] of Object.entries(features)) {
        await tx.run(upsertOrgFeatureQuery(orgId, key, value));
      }
    },
    listFeatures(tx, orgId) {
      return tx.run<OrgFeatureRow>(listOrgFeaturesQuery(orgId));
    },
  };
}
