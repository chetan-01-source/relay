/**
 * Identity repository (DEVELOPMENT.md §2) — data access only. Executes the parametrized queries
 * against the DB singleton. Unlike a normal tenant repository it receives the full Database (not a
 * Queryable) because the virtual-key lookup MUST cross the org boundary: a presented key names no
 * org until it is resolved. It therefore reads as a platform admin inside a short transaction — the
 * one cross-org read on the data path, and only on a snapshot miss. Contains NO query text.
 */
import type { Database } from '../../../platform/db.js';
import {
  listBudgetPolicyQuery,
  resolveVirtualKeyByKeyIdQuery,
  resolveOrgByLogtoIdQuery,
  getOrgMemberRoleQuery,
  listOrgFeaturesQuery,
  listRateLimitPolicyQuery,
} from '../queries/identity.queries.js';
import type {
  IdentityRepository,
  OrgIdentity,
  OrgRole,
  PlanCeilingsInput,
  PlanSource,
  VirtualKeyRow,
} from '../types/identity.types.js';

// A syntactically valid but never-issued org id. Under platform-admin scope, tenant_isolation
// (org_id = current_org) matches nothing while platform_admin_access grants the read — so the NIL
// id is safe and makes the intent explicit: this read is not scoped to any single tenant.
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Compose the plan's rate ceiling with the one the org set for itself: the TIGHTER of the two wins,
 * and `null` on either side means that side has no opinion.
 *
 * Minimum rather than maximum is what makes a downgrade safe. An org that configured 6000 rpm on a
 * larger plan and then moves to a smaller one does not need its configuration rewritten —
 * enforcement simply tightens, and the console shows both numbers with the binding one marked.
 */
function composeRateLimit(
  own: { rpm: number | null; tpm: number | null } | null,
  plan: PlanCeilingsInput | undefined,
): { rpm: number | null; tpm: number | null } | null {
  if (!plan) return own;
  const rpm = tighten(plan.rpm, own?.rpm ?? null);
  const tpm = tighten(plan.tpm, own?.tpm ?? null);
  return rpm === null && tpm === null ? null : { rpm, tpm };
}

function tighten(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/**
 * The plan's monthly spend cap, expressed as an ordinary org-wide budget so the policy service needs
 * to know nothing about plans — it reserves against this exactly as it does against a ceiling an
 * operator set. Always a hard cutoff: a plan cap that only warned would not be a cap.
 */
function planSpendCeiling(plan: PlanCeilingsInput | undefined): Array<{
  scope: 'org';
  appId: null;
  period: 'monthly';
  limitUsd: number;
  hardCutoff: true;
}> {
  if (!plan || plan.monthlySpendUsd === null) return [];
  return [
    {
      scope: 'org',
      appId: null,
      period: 'monthly',
      limitUsd: plan.monthlySpendUsd,
      hardCutoff: true,
    },
  ];
}

/**
 * `planSource` is optional so the offline `relay openapi` dump — and any deployment predating the
 * plan layer — builds snapshots exactly as before: the org's own flags, its own rate limit, its own
 * budgets, and a null plan code.
 */
export function createIdentityRepository(
  db: Database,
  planSource?: PlanSource,
): IdentityRepository {
  return {
    resolveOrgByLogtoId(logtoOrgId) {
      // Same cross-org read as resolveByKeyId, and for the same reason: the claim names no tenant of
      // ours until this lookup resolves it, so it cannot run under tenant scope.
      return db.withTenant(NIL_UUID, { isPlatformAdmin: true }, async (tx) => {
        const [row] = await tx.run<OrgIdentity>(resolveOrgByLogtoIdQuery(logtoOrgId));
        return row ?? null;
      });
    },

    getOrgMemberRole(orgId, userId) {
      // Runs INSIDE the tenant's scope: the row belongs to this org and tenant_isolation is the
      // guard we want here — unlike the two lookups above, the org is already known.
      return db.withTenant(orgId, { isPlatformAdmin: false }, async (tx) => {
        const [row] = await tx.run<{ role: OrgRole }>(getOrgMemberRoleQuery(orgId, userId));
        return row?.role ?? 'member';
      });
    },

    resolveByKeyId(keyId) {
      return db.withTenant(NIL_UUID, { isPlatformAdmin: true }, async (tx) => {
        const rows = await tx.run<VirtualKeyRow>(resolveVirtualKeyByKeyIdQuery(keyId));
        const row = rows[0];
        if (!row) return null;

        // The plan-derived layer, resolved in THIS transaction so the whole snapshot costs one
        // connection and one round of reads. Only paid on a snapshot miss (ADR-0014 §3).
        const plan = await planSource?.forOrg(tx, row.org_id);

        const features = await tx.run<{ feature_key: string; value: unknown }>(
          listOrgFeaturesQuery(row.org_id),
        );
        // Plan first, the org's own flags on top: most specific wins. `org_features` stays the
        // highest-precedence layer because it is the per-flag lever support reaches for, and keeping
        // it on top means the plan layer is purely additive for orgs that already had flags set.
        const entitlements: Record<string, unknown> = { ...(plan?.entitlements ?? {}) };
        for (const feature of features) entitlements[feature.feature_key] = feature.value;

        const [rateLimit] = await tx.run<{ rpm: number | null; tpm: number | null }>(
          listRateLimitPolicyQuery(row.org_id),
        );
        // Both the org's ceilings and this key's application's — the request must fit inside all.
        const budgets = await tx.run<{
          app_id: string | null;
          period: 'daily' | 'monthly';
          limit_usd: string;
          hard_cutoff: boolean;
        }>(listBudgetPolicyQuery(row.org_id, row.app_id));

        return {
          row,
          entitlements,
          planCode: plan?.planCode ?? null,
          policy: {
            rateLimit: composeRateLimit(rateLimit ?? null, plan),
            budgets: [
              ...budgets.map((budget) => ({
                scope: budget.app_id ? ('app' as const) : ('org' as const),
                appId: budget.app_id,
                period: budget.period,
                limitUsd: Number(budget.limit_usd),
                hardCutoff: budget.hard_cutoff,
              })),
              ...planSpendCeiling(plan),
            ],
          },
        };
      });
    },
  };
}
