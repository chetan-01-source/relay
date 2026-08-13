/**
 * Routing SQL — the ONLY place this module contains query text. Every value is bound as a
 * parameter, and the query runs inside withTenant so RLS limits results to the caller's org.
 */
import type { SqlQuery } from '../../../platform/db.js';

/**
 * Targets of the active version of the route that serves `model` for `appId`.
 *
 * Two routes can now answer to one model name: the application's own, and the org-wide default.
 * The app's wins — `ORDER BY (r.app_id IS NULL) LIMIT 1` puts the app-scoped row first (false sorts
 * before true) and the org row second, so an app without an override still resolves. Picking the
 * route in a scalar subquery rather than filtering the join keeps "exactly one route" a property of
 * the query instead of something the caller has to enforce after the fact.
 */
export function listActiveRouteTargetsQuery(model: string, appId: string | null): SqlQuery {
  return {
    text: `WITH selected AS (
             SELECT r.id
               FROM routes r
              WHERE r.model_name = $1
                AND (r.app_id IS NULL OR r.app_id = $2::uuid)
              ORDER BY (r.app_id IS NULL)
              LIMIT 1
           )
           SELECT r.id AS route_id,
                  r.cache_enabled,
                  rv.id AS route_version_id,
                  rv.strategy,
                  rt.id AS target_id,
                  rt.credential_id,
                  rt.provider,
                  rt.model,
                  rt.priority,
                  rt.weight,
                  pc.base_url,
                  pc.health_score,
                  pc.ciphertext,
                  pc.iv,
                  pc.auth_tag,
                  pc.wrapped_dek,
                  COALESCE(mc.capabilities, '{}'::jsonb) AS capabilities,
                  rc.input_usd_per_1k::text,
                  rc.output_usd_per_1k::text
             FROM routes r
             JOIN route_versions rv ON rv.id = r.active_version_id
             JOIN route_targets rt ON rt.route_version_id = rv.id
             JOIN provider_credentials pc ON pc.id = rt.credential_id
        LEFT JOIN model_catalog mc ON mc.provider = rt.provider AND mc.model = rt.model
        LEFT JOIN rate_cards rc ON rc.provider = rt.provider AND rc.model = rt.model
            WHERE r.id = (SELECT id FROM selected)
              AND pc.status = 'active'
         ORDER BY rt.priority ASC, pc.health_score DESC, rt.created_at ASC`,
    values: [model, appId],
  };
}
