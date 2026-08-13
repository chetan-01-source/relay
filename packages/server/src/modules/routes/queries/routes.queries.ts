/**
 * Routes SQL — the ONLY place this module contains query text. Every user value is bound as a
 * parameter ($1, $2, …); nothing is interpolated. All queries run inside `withTenant`, so RLS scopes
 * reads/writes to the caller's org, and every INSERT carries an explicit `org_id` to satisfy the
 * tenant_isolation WITH CHECK.
 */
import type { SqlQuery } from '../../../platform/db.js';
import type { RoutingStrategy, TargetInput } from '../types/routes.types.js';

/** List routes with a summary of their active version (ordinal, strategy, target count). */
export function listRoutesQuery(): SqlQuery {
  return {
    text: `SELECT r.id,
                  r.model_name,
                  r.app_id,
                  r.cache_enabled,
                  r.active_version_id,
                  r.created_at,
                  av.version AS active_version,
                  av.strategy AS active_strategy,
                  (SELECT count(*)::int FROM route_versions rv WHERE rv.route_id = r.id)
                    AS version_count,
                  (SELECT count(*)::int FROM route_targets rt WHERE rt.route_version_id = r.active_version_id)
                    AS target_count
             FROM routes r
        LEFT JOIN route_versions av ON av.id = r.active_version_id
         ORDER BY r.model_name ASC`,
    values: [],
  };
}

export function getRouteQuery(id: string): SqlQuery {
  return {
    text: `SELECT id, model_name, app_id, cache_enabled, active_version_id, created_at
             FROM routes WHERE id = $1`,
    values: [id],
  };
}

/**
 * The route serving `modelName` in ONE scope. `appId` null means the org-wide route; a value means
 * that application's own. Both sides are collapsed through COALESCE because Postgres compares NULLs
 * as distinct — `app_id = NULL` matches nothing, so a plain equality test would report "no duplicate"
 * for every org-wide route and let a second one through the uniqueness check.
 */
export function getRouteByModelQuery(modelName: string, appId: string | null): SqlQuery {
  return {
    text: `SELECT id, model_name, app_id, cache_enabled, active_version_id, created_at
             FROM routes
            WHERE model_name = $1
              AND COALESCE(app_id, '00000000-0000-0000-0000-000000000000'::uuid)
                = COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
    values: [modelName, appId],
  };
}

export function listVersionsQuery(routeId: string): SqlQuery {
  return {
    text: `SELECT id, route_id, version, strategy, created_at
             FROM route_versions WHERE route_id = $1 ORDER BY version DESC`,
    values: [routeId],
  };
}

/** Targets for a set of versions, left-joined to model_catalog so the service can flag unknown
 * (provider, model) pairs for the capability-lint badge. `= ANY($1)` keeps the id list parametrized. */
export function listTargetsQuery(versionIds: string[]): SqlQuery {
  return {
    text: `SELECT rt.id,
                  rt.route_version_id,
                  rt.credential_id,
                  rt.provider,
                  rt.model,
                  rt.priority,
                  rt.weight,
                  (mc.model IS NOT NULL) AS known_model
             FROM route_targets rt
        LEFT JOIN model_catalog mc ON mc.provider = rt.provider AND mc.model = rt.model
            WHERE rt.route_version_id = ANY($1::uuid[])
         ORDER BY rt.priority ASC, rt.created_at ASC`,
    values: [versionIds],
  };
}

export function getVersionQuery(versionId: string): SqlQuery {
  return {
    text: `SELECT id, route_id, version, strategy, created_at
             FROM route_versions WHERE id = $1`,
    values: [versionId],
  };
}

export function maxVersionQuery(routeId: string): SqlQuery {
  return {
    text: `SELECT COALESCE(max(version), 0)::int AS max FROM route_versions WHERE route_id = $1`,
    values: [routeId],
  };
}

export function insertRouteQuery(
  orgId: string,
  modelName: string,
  cacheEnabled: boolean,
  appId: string | null,
): SqlQuery {
  return {
    text: `INSERT INTO routes (org_id, model_name, cache_enabled, app_id)
           VALUES ($1, $2, $3, $4::uuid)
        RETURNING id, model_name, app_id, cache_enabled, active_version_id, created_at`,
    values: [orgId, modelName, cacheEnabled, appId],
  };
}

export function insertVersionQuery(
  orgId: string,
  routeId: string,
  version: number,
  strategy: RoutingStrategy,
): SqlQuery {
  return {
    text: `INSERT INTO route_versions (org_id, route_id, version, strategy)
           VALUES ($1, $2, $3, $4)
        RETURNING id, route_id, version, strategy, created_at`,
    values: [orgId, routeId, version, strategy],
  };
}

export function insertTargetQuery(orgId: string, versionId: string, t: TargetInput): SqlQuery {
  return {
    text: `INSERT INTO route_targets
             (org_id, route_version_id, credential_id, provider, model, priority, weight)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    values: [
      orgId,
      versionId,
      t.credential_id,
      t.provider,
      t.model,
      t.priority ?? 100,
      t.weight ?? 1,
    ],
  };
}

export function setActiveVersionQuery(routeId: string, versionId: string): SqlQuery {
  return {
    text: `UPDATE routes SET active_version_id = $2, updated_at = now() WHERE id = $1`,
    values: [routeId, versionId],
  };
}

export function setCacheEnabledQuery(routeId: string, enabled: boolean): SqlQuery {
  return {
    text: `UPDATE routes SET cache_enabled = $2, updated_at = now() WHERE id = $1`,
    values: [routeId, enabled],
  };
}

export function deleteRouteQuery(routeId: string): SqlQuery {
  return { text: `DELETE FROM routes WHERE id = $1`, values: [routeId] };
}
