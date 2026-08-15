/**
 * Models SQL — the ONLY file in this module that contains query text. Every export returns a
 * parametrized SqlQuery ({ text, values }); user-supplied values are ALWAYS passed as $-params,
 * never string-interpolated, so these statements are injection-safe by construction (playbook §9).
 * Services and controllers import repositories, never this file.
 */
import type { SqlQuery } from '../../../platform/db.js';

const COLUMNS = 'provider, model, capabilities';
const TABLE = 'model_catalog';

/** All catalog models, stable order. */
export function listModelsQuery(): SqlQuery {
  return {
    text: `SELECT ${COLUMNS} FROM ${TABLE} ORDER BY provider, model`,
    values: [],
  };
}

/** One model by its id. `model` is bound as $1 — safe against injection. */
export function getModelQuery(model: string): SqlQuery {
  return {
    text: `SELECT ${COLUMNS} FROM ${TABLE} WHERE model = $1`,
    values: [model],
  };
}

/**
 * Catalog search for the console's model pickers.
 *
 * `provider` and `search` are both optional, so the predicate is built with SQL `IS NULL` guards
 * rather than by concatenating clauses in JavaScript — the shape of the statement is then fixed and
 * every value stays a bound parameter (§3.4), which is what keeps a user-typed search string from
 * ever reaching the planner as SQL.
 */
export function searchCatalogQuery(
  provider: string | undefined,
  search: string | undefined,
  limit: number,
): SqlQuery {
  return {
    text: `SELECT ${COLUMNS} FROM ${TABLE}
            WHERE ($1::text IS NULL OR provider = $1)
              AND ($2::text IS NULL OR model ILIKE '%' || $2 || '%')
         ORDER BY provider, model
            LIMIT $3`,
    values: [provider ?? null, search ?? null, limit],
  };
}

/** Models per provider — the console shows a hint when a provider's catalog looks unpopulated. */
export function countModelsByProviderQuery(): SqlQuery {
  return {
    text: `SELECT provider, count(*)::int AS count FROM ${TABLE} GROUP BY provider ORDER BY provider`,
    values: [],
  };
}
