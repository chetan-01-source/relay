/**
 * Identity SQL — the ONLY file in this module with query text. Every export returns a parametrized
 * SqlQuery ({ text, values }); the key_id is bound as $1, never interpolated, so the lookup is
 * injection-safe by construction (DEVELOPMENT.md §3.4). Runs inside the resolver's platform-scoped
 * transaction (RLS platform_admin_access) because a presented key names no org until it is resolved.
 */
import type { SqlQuery } from '../../../platform/db.js';

/**
 * Resolve a key by its public selector, joined to the org status. O(1) via the unique index on
 * virtual_keys.key_id. Returns the stored secret verifier so the resolver can verify the presented
 * secret timing-safely; the plaintext secret is never stored.
 */
export function resolveVirtualKeyByKeyIdQuery(keyId: string): SqlQuery {
  return {
    text: `SELECT vk.id, vk.org_id, vk.app_id, vk.key_id, vk.key_sha256,
                  vk.environment, vk.status, vk.grace_until, vk.revoked_at,
                  o.status AS org_status
             FROM virtual_keys vk
             JOIN organizations o ON o.id = vk.org_id
            WHERE vk.key_id = $1`,
    values: [keyId],
  };
}

/**
 * Resolve a control-plane token's `organization_id` claim to our tenant key.
 *
 * Logto mints that claim as ITS org id (a 12-char string), but every tenant table FKs to
 * `organizations.id` (a uuid) and the RLS policy casts `app.current_org` to uuid — so handing the
 * Logto id straight to withTenant() raises `invalid input syntax for type uuid`. This is the join
 * that closes that gap.
 *
 * The `id::text = $1` arm accepts a claim that already carries our uuid, which is what the seeded
 * fixtures and integration tests mint. `$1` is bound, never interpolated, so a non-uuid value is
 * compared as text rather than blowing up the cast.
 */
export function resolveOrgByLogtoIdQuery(logtoOrgId: string): SqlQuery {
  return {
    text: `SELECT id, status FROM organizations WHERE logto_org_id = $1 OR id::text = $1 LIMIT 1`,
    values: [logtoOrgId],
  };
}

/**
 * The role a user holds in one org, or no row when they hold none.
 *
 * A missing row is NOT an error and NOT an admin: callers read it as 'member'. That default is what
 * makes the feature safe to deploy against orgs that predate this table — every existing member keeps
 * working, nobody is silently promoted, and a platform admin grants the first admin explicitly.
 */
export function getOrgMemberRoleQuery(orgId: string, userId: string): SqlQuery {
  return {
    text: `SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2`,
    values: [orgId, userId],
  };
}

/** The org's entitlement flags, folded into the snapshot. org_id is bound as $1. */
export function listOrgFeaturesQuery(orgId: string): SqlQuery {
  return {
    text: `SELECT feature_key, value FROM org_features WHERE org_id = $1`,
    values: [orgId],
  };
}

export function listRateLimitPolicyQuery(orgId: string): SqlQuery {
  return {
    text: `SELECT scope, rpm, tpm
             FROM rate_limits
            WHERE org_id = $1
         ORDER BY CASE scope WHEN 'key' THEN 0 ELSE 1 END
            LIMIT 1`,
    values: [orgId],
  };
}

/**
 * Every spend ceiling that applies to one virtual key: the org-wide rows (`app_id IS NULL`) plus the
 * rows scoped to the key's own application.
 *
 * This used to `LIMIT 1` with monthly winning, which quietly ignored a daily ceiling an operator had
 * set — and had no notion of a per-app ceiling at all. All applicable rows are returned now and the
 * policy service reserves against each, so nothing an operator configures is silently dropped.
 */
export function listBudgetPolicyQuery(orgId: string, appId: string): SqlQuery {
  return {
    text: `SELECT app_id, period, limit_usd::text, hard_cutoff
             FROM budgets
            WHERE org_id = $1
              AND (app_id IS NULL OR app_id = $2)
         ORDER BY app_id NULLS FIRST, period`,
    values: [orgId, appId],
  };
}
