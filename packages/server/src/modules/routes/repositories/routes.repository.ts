/**
 * Routes repository — data access only. Executes the parametrized query builders through the
 * Queryable supplied by the service's tenant transaction (withTenant). No business logic, no query
 * text. Every method takes the `tx` so a whole route mutation runs as one atomic transaction.
 */
import {
  listRoutesQuery,
  getRouteQuery,
  getRouteByModelQuery,
  listVersionsQuery,
  listTargetsQuery,
  getVersionQuery,
  maxVersionQuery,
  insertRouteQuery,
  insertVersionQuery,
  insertTargetQuery,
  setActiveVersionQuery,
  setCacheEnabledQuery,
  deleteRouteQuery,
} from '../queries/routes.queries.js';
import type {
  RouteListRow,
  RouteRow,
  RoutesRepository,
  RouteTargetRow,
  RouteVersionRow,
} from '../types/routes.types.js';

export function createRoutesRepository(): RoutesRepository {
  return {
    listRoutes(tx) {
      return tx.run<RouteListRow>(listRoutesQuery());
    },
    async getRoute(tx, id) {
      const rows = await tx.run<RouteRow>(getRouteQuery(id));
      return rows[0] ?? null;
    },
    async getRouteByModel(tx, modelName) {
      const rows = await tx.run<RouteRow>(getRouteByModelQuery(modelName));
      return rows[0] ?? null;
    },
    listVersions(tx, routeId) {
      return tx.run<RouteVersionRow>(listVersionsQuery(routeId));
    },
    listTargets(tx, versionIds) {
      if (versionIds.length === 0) return Promise.resolve([]);
      return tx.run<RouteTargetRow>(listTargetsQuery(versionIds));
    },
    async getVersion(tx, versionId) {
      const rows = await tx.run<RouteVersionRow>(getVersionQuery(versionId));
      return rows[0] ?? null;
    },
    async maxVersion(tx, routeId) {
      const rows = await tx.run<{ max: number }>(maxVersionQuery(routeId));
      return rows[0]?.max ?? 0;
    },
    async insertRoute(tx, orgId, input) {
      const rows = await tx.run<RouteRow>(
        insertRouteQuery(orgId, input.modelName, input.cacheEnabled),
      );
      return rows[0]!;
    },
    async insertVersion(tx, orgId, input) {
      const rows = await tx.run<RouteVersionRow>(
        insertVersionQuery(orgId, input.routeId, input.version, input.strategy),
      );
      return rows[0]!;
    },
    async insertTarget(tx, orgId, versionId, t) {
      await tx.run(insertTargetQuery(orgId, versionId, t));
    },
    async setActiveVersion(tx, routeId, versionId) {
      await tx.run(setActiveVersionQuery(routeId, versionId));
    },
    async setCacheEnabled(tx, routeId, enabled) {
      await tx.run(setCacheEnabledQuery(routeId, enabled));
    },
    async deleteRoute(tx, routeId) {
      await tx.run(deleteRouteQuery(routeId));
    },
  };
}
