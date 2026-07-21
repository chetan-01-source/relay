/**
 * Routing repository — data access only. It executes parametrized query builders through the
 * Queryable supplied by the service's tenant transaction.
 */
import type { Queryable } from '../../../platform/db.js';
import { listActiveRouteTargetsQuery } from '../queries/routing.queries.js';
import type { RoutingRepository, RoutingTargetRow } from '../types/routing.types.js';

export function createRoutingRepository(tx: Queryable): RoutingRepository {
  return {
    listActiveTargets(model) {
      return tx.run<RoutingTargetRow>(listActiveRouteTargetsQuery(model));
    },
  };
}
