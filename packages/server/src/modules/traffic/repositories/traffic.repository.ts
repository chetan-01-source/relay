/**
 * Traffic repository — data access only. Executes the parametrized query builders through the
 * Queryable supplied by the service's tenant transaction. No business logic, no query text.
 */
import { listRecentQuery, getByRequestIdQuery } from '../queries/traffic.queries.js';
import type { TrafficEventRow, TrafficRepository } from '../types/traffic.types.js';

export function createTrafficRepository(): TrafficRepository {
  return {
    listRecent(tx, opts) {
      return tx.run<TrafficEventRow>(listRecentQuery(opts));
    },
    getByRequestId(tx, requestId) {
      return tx.run<TrafficEventRow>(getByRequestIdQuery(requestId));
    },
  };
}
