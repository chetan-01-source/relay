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

/** The org's entitlement flags, folded into the snapshot. org_id is bound as $1. */
export function listOrgFeaturesQuery(orgId: string): SqlQuery {
  return {
    text: `SELECT feature_key, value FROM org_features WHERE org_id = $1`,
    values: [orgId],
  };
}
