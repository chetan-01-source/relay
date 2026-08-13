/**
 * Plans SQL — the ONLY file in this module with query text. Every value is bound as a $-param and
 * never interpolated (DEVELOPMENT.md §3.4).
 *
 * Two scopes are in play, and the difference matters:
 *   • `plans` is PLATFORM data (no org_id, `catalog_read` allows SELECT to anyone) — readable from
 *     inside a tenant transaction without any platform-admin flag.
 *   • `org_subscriptions` is TENANT data — read inside the caller's own tenant transaction, where
 *     RLS scopes it, or under platform-admin scope for the control-plane read.
 */
import type { SqlQuery } from '../../../platform/db.js';

const PLAN_COLUMNS = `code, name, description, tier, limits,
                      price_monthly_usd::text AS price_monthly_usd,
                      price_yearly_usd::text  AS price_yearly_usd,
                      public, active`;

const SUBSCRIPTION_COLUMNS = `id, org_id, plan_code, status, trial_ends_at, grace_until,
                              current_period_start, current_period_end, overrides,
                              provider, provider_ref, created_at, updated_at`;

export function getPlanQuery(code: string): SqlQuery {
  return { text: `SELECT ${PLAN_COLUMNS} FROM plans WHERE code = $1`, values: [code] };
}

/** The purchasable catalog, cheapest first. Retired (`active = false`) plans stay assignable to the
 * orgs already on them but are never offered. */
export function listPublicPlansQuery(): SqlQuery {
  return {
    text: `SELECT ${PLAN_COLUMNS} FROM plans
            WHERE public = true AND active = true
         ORDER BY tier`,
    values: [],
  };
}

export function getSubscriptionQuery(orgId: string): SqlQuery {
  return {
    text: `SELECT ${SUBSCRIPTION_COLUMNS} FROM org_subscriptions WHERE org_id = $1`,
    values: [orgId],
  };
}

/**
 * Assign or update the org's subscription. `org_id` is UNIQUE, so this is an idempotent upsert.
 *
 * Every optional field uses COALESCE($n, existing) so a partial write (a platform admin extending a
 * trial) cannot blank out the billing linkage or the period it did not mention. Passing an explicit
 * `null` to clear a field is therefore not possible through this statement — which is the intent:
 * clearing is rare and should be deliberate, not an accident of an omitted key.
 */
export function upsertSubscriptionQuery(
  orgId: string,
  input: {
    planCode: string;
    status: string | null;
    trialEndsAt: string | null;
    graceUntil: string | null;
    currentPeriodEnd: string | null;
    overrides: string | null;
    provider: string | null;
    providerRef: string | null;
  },
): SqlQuery {
  return {
    text: `INSERT INTO org_subscriptions
             (org_id, plan_code, status, trial_ends_at, grace_until, current_period_end,
              overrides, provider, provider_ref)
           VALUES ($1, $2, COALESCE($3, 'active'), $4, $5, $6,
                   COALESCE($7::jsonb, '{}'::jsonb), $8, $9)
           ON CONFLICT (org_id) DO UPDATE
             SET plan_code            = EXCLUDED.plan_code,
                 status               = COALESCE($3, org_subscriptions.status),
                 trial_ends_at        = COALESCE($4, org_subscriptions.trial_ends_at),
                 grace_until          = COALESCE($5, org_subscriptions.grace_until),
                 current_period_end   = COALESCE($6, org_subscriptions.current_period_end),
                 overrides            = COALESCE($7::jsonb, org_subscriptions.overrides),
                 provider             = COALESCE($8, org_subscriptions.provider),
                 provider_ref         = COALESCE($9, org_subscriptions.provider_ref),
                 updated_at           = now()
           RETURNING ${SUBSCRIPTION_COLUMNS}`,
    values: [
      orgId,
      input.planCode,
      input.status,
      input.trialEndsAt,
      input.graceUntil,
      input.currentPeriodEnd,
      input.overrides,
      input.provider,
      input.providerRef,
    ],
  };
}

/** The org's entitlement flags — the highest-precedence layer, and where provenance comes from. */
export function listOrgFeaturesQuery(orgId: string): SqlQuery {
  return {
    text: `SELECT feature_key, value FROM org_features WHERE org_id = $1`,
    values: [orgId],
  };
}

/**
 * Every countable quota in ONE round trip.
 *
 * Scalar subqueries rather than five statements because this runs inside the transaction that is
 * about to insert a row — the fewer round trips that transaction holds a connection for, the better,
 * and a quota check on the write path should not cost five.
 *
 * `keys_in_app` counts only ACTIVE keys: a revoked key consumes no capacity, and counting it would
 * mean rotating a key eventually locks an app out of issuing one.
 */
export function usageCountsQuery(orgId: string, appId: string | null): SqlQuery {
  return {
    text: `SELECT
             (SELECT count(*) FROM applications         WHERE org_id = $1)                    AS apps,
             (SELECT count(*) FROM provider_credentials WHERE org_id = $1)                    AS providers,
             (SELECT count(*) FROM routes               WHERE org_id = $1)                    AS routes,
             (SELECT count(*) FROM org_members          WHERE org_id = $1)                    AS members,
             (SELECT count(*) FROM virtual_keys
               WHERE org_id = $1 AND status = 'active'
                 AND ($2::uuid IS NULL OR app_id = $2::uuid))                                 AS keys_in_app`,
    values: [orgId, appId],
  };
}
