/**
 * Model-catalogue view model — PURE, so it is unit-tested without a gateway.
 *
 * `GET /v1/models` returns the deployment-wide catalogue (OpenAI-shaped: `id` = the model, `owned_by`
 * = the upstream provider). On its own that is a flat list; what an operator actually needs to know is
 * which of those models their org can *reach*, which is a route question. These helpers join the two
 * reads the console already makes so the page can say "routable" vs "no route" per model.
 */
import type { ModelObject, RouteSummary } from './api';

export interface ModelGroup {
  owner: string; // owned_by — the upstream provider
  models: ModelObject[];
}

/** Group the catalogue by provider, providers and models each in stable alphabetical order. */
export function groupByOwner(models: readonly ModelObject[]): ModelGroup[] {
  const groups = new Map<string, ModelObject[]>();
  for (const model of models) {
    const owner = model.owned_by ?? 'unknown';
    const bucket = groups.get(owner);
    if (bucket) bucket.push(model);
    else groups.set(owner, [model]);
  }
  return [...groups.entries()]
    .map(([owner, list]) => ({
      owner,
      models: [...list].sort((a, b) => (a.id ?? '').localeCompare(b.id ?? '')),
    }))
    .sort((a, b) => a.owner.localeCompare(b.owner));
}

/** The client-facing model names this org has a route for. A request only reaches an upstream if a
 * route claims the name, so this is what "usable right now" means for the caller. */
export function routedModelNames(routes: readonly RouteSummary[]): Set<string> {
  return new Set(routes.map((route) => route.model_name).filter((name): name is string => !!name));
}
