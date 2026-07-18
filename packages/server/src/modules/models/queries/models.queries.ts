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
