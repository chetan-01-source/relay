/**
 * Identity repository (DEVELOPMENT.md §2) — data access only. Executes the parametrized queries
 * against the DB singleton. Unlike a normal tenant repository it receives the full Database (not a
 * Queryable) because the virtual-key lookup MUST cross the org boundary: a presented key names no
 * org until it is resolved. It therefore reads as a platform admin inside a short transaction — the
 * one cross-org read on the data path, and only on a snapshot miss. Contains NO query text.
 */
import type { Database } from '../../../platform/db.js';
import {
  resolveVirtualKeyByKeyIdQuery,
  listOrgFeaturesQuery,
} from '../queries/identity.queries.js';
import type { IdentityRepository, VirtualKeyRow } from '../types/identity.types.js';

// A syntactically valid but never-issued org id. Under platform-admin scope, tenant_isolation
// (org_id = current_org) matches nothing while platform_admin_access grants the read — so the NIL
// id is safe and makes the intent explicit: this read is not scoped to any single tenant.
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export function createIdentityRepository(db: Database): IdentityRepository {
  return {
    resolveByKeyId(keyId) {
      return db.withTenant(NIL_UUID, { isPlatformAdmin: true }, async (tx) => {
        const rows = await tx.run<VirtualKeyRow>(resolveVirtualKeyByKeyIdQuery(keyId));
        const row = rows[0];
        if (!row) return null;

        const features = await tx.run<{ feature_key: string; value: unknown }>(
          listOrgFeaturesQuery(row.org_id),
        );
        const entitlements: Record<string, unknown> = {};
        for (const feature of features) entitlements[feature.feature_key] = feature.value;

        return { row, entitlements };
      });
    },
  };
}
