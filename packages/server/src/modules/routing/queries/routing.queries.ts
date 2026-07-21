/**
 * Routing SQL — the ONLY place this module contains query text. Every value is bound as a
 * parameter, and the query runs inside withTenant so RLS limits results to the caller's org.
 */
import type { SqlQuery } from '../../../platform/db.js';

export function listActiveRouteTargetsQuery(model: string): SqlQuery {
  return {
    text: `SELECT r.id AS route_id,
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
            WHERE r.model_name = $1
              AND pc.status = 'active'
         ORDER BY rt.priority ASC, pc.health_score DESC, rt.created_at ASC`,
    values: [model],
  };
}
