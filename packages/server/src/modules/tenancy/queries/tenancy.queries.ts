/**
 * Tenancy SQL — the ONLY file in this module with query text. Every user-supplied value is bound as
 * a $-param (never string-interpolated), so these statements are injection-safe by construction
 * (DEVELOPMENT.md §3.4). Feature values are passed as JSON text and cast to jsonb by the column.
 */
import type { SqlQuery } from '../../../platform/db.js';
import type { OnboardingState, OrgStatus } from '../types/tenancy.types.js';

const ORG_COLUMNS = 'id, logto_org_id, name, status, onboarding_state, created_at, updated_at';

/** Insert a new org. May raise unique_violation (23505) on logto_org_id — the service maps it to 409. */
export function insertOrgQuery(logtoOrgId: string, name: string): SqlQuery {
  return {
    text: `INSERT INTO organizations (logto_org_id, name) VALUES ($1, $2) RETURNING ${ORG_COLUMNS}`,
    values: [logtoOrgId, name],
  };
}

export function getOrgByIdQuery(orgId: string): SqlQuery {
  return {
    text: `SELECT ${ORG_COLUMNS} FROM organizations WHERE id = $1`,
    values: [orgId],
  };
}

/** All orgs, newest first — a platform-admin listing (RLS platform_admin_all makes every row visible). */
export function listOrgsQuery(): SqlQuery {
  return {
    text: `SELECT ${ORG_COLUMNS} FROM organizations ORDER BY created_at DESC`,
    values: [],
  };
}

export function updateOrgStatusQuery(orgId: string, status: OrgStatus): SqlQuery {
  return {
    text: `UPDATE organizations SET status = $2, updated_at = now() WHERE id = $1`,
    values: [orgId, status],
  };
}

export function updateOnboardingStateQuery(orgId: string, state: OnboardingState): SqlQuery {
  return {
    text: `UPDATE organizations SET onboarding_state = $2, updated_at = now() WHERE id = $1`,
    values: [orgId, state],
  };
}

/** Upsert a single entitlement flag. value is bound as JSON text and cast to jsonb. */
export function upsertOrgFeatureQuery(orgId: string, featureKey: string, value: unknown): SqlQuery {
  return {
    text: `INSERT INTO org_features (org_id, feature_key, value)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (org_id, feature_key)
           DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    values: [orgId, featureKey, JSON.stringify(value)],
  };
}

export function listOrgFeaturesQuery(orgId: string): SqlQuery {
  return {
    text: `SELECT feature_key, value FROM org_features WHERE org_id = $1 ORDER BY feature_key`,
    values: [orgId],
  };
}
