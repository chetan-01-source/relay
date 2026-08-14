/**
 * Routes service (Week 3 Day 13) — business logic of the routes editor. Orchestrates the repository
 * inside `withTenant` transactions and appends an audit record per mutation; contains NO SQL and no
 * HTTP types. A route mutation that spans rows (create route + version + targets, or activate a
 * version) runs in a single transaction so the invariant "a route's active_version_id always points
 * at one of its own versions" can never half-apply.
 */
import { RelayError } from 'relay-shared';
import type { Database, Queryable } from '../../../platform/db.js';
import type { AuditRepository } from '../../audit/index.js';
import type { PlansService } from '../../plans/index.js';
import type {
  CreateRouteInput,
  CreateVersionInput,
  Route,
  RouteDetail,
  RouteRow,
  RoutesRepository,
  RoutesService,
  RouteTarget,
  RouteVersion,
  RoutingStrategy,
} from '../types/routes.types.js';

export interface RoutesServiceDeps {
  db: Database;
  repo: RoutesRepository;
  audit: AuditRepository;
  /** Plan quotas. Absent ⇒ unbounded (offline spec dump, unit tests). */
  plans?: PlansService;
}

const DEFAULT_STRATEGY: RoutingStrategy = 'priority';

export function createRoutesService(deps: RoutesServiceDeps): RoutesService {
  const { db, repo, audit, plans } = deps;

  function listRoutes(orgId: string): Promise<Route[]> {
    return db.withTenant(orgId, { isPlatformAdmin: false }, async (tx) => {
      const rows = await repo.listRoutes(tx);
      return rows.map((r) => ({
        object: 'route' as const,
        id: r.id,
        model_name: r.model_name,
        app_id: r.app_id,
        cache_enabled: r.cache_enabled,
        active_version_id: r.active_version_id,
        active_version: r.active_version,
        version_count: r.version_count,
        target_count: r.target_count,
        created_at: r.created_at,
      }));
    });
  }

  function getRoute(orgId: string, id: string): Promise<RouteDetail | null> {
    return db.withTenant(orgId, { isPlatformAdmin: false }, async (tx) => {
      const route = await repo.getRoute(tx, id);
      return route ? buildDetail(tx, route) : null;
    });
  }

  async function createRoute(
    actor: string,
    orgId: string,
    input: CreateRouteInput,
  ): Promise<RouteDetail> {
    const targets = input.targets ?? [];
    return db.withTenant(orgId, { isPlatformAdmin: false }, async (tx) => {
      // Inside the insert transaction, so concurrent creates cannot both slip past the ceiling.
      await plans?.assertQuota(tx, orgId, 'routes.max');
      // Uniqueness is per SCOPE: an application may define its own route for a model the org
      // already routes, which is the whole point of the override. Only a second route in the SAME
      // scope is a conflict, and the message says which scope so the operator is not left guessing.
      const appId = input.app_id ?? null;
      const existing = await repo.getRouteByModel(tx, input.model_name, appId);
      if (existing) {
        throw new RelayError('conflict', {
          message: appId
            ? `This application already has a route for model '${input.model_name}'.`
            : `An organization-wide route for model '${input.model_name}' already exists.`,
          param: 'model_name',
        });
      }
      const route = await repo.insertRoute(tx, orgId, {
        modelName: input.model_name,
        cacheEnabled: input.cache_enabled ?? false,
        appId,
      });
      if (targets.length > 0) {
        const version = await repo.insertVersion(tx, orgId, {
          routeId: route.id,
          version: 1,
          strategy: input.strategy ?? DEFAULT_STRATEGY,
        });
        for (const t of targets) await repo.insertTarget(tx, orgId, version.id, t);
        await repo.setActiveVersion(tx, route.id, version.id);
        route.active_version_id = version.id;
      }
      await audit.appendWithTx(tx, orgId, {
        actor,
        action: 'route.create',
        target: route.id,
        data: { model_name: input.model_name, app_id: appId, targets: targets.length },
      });
      return buildDetail(tx, route);
    });
  }

  async function addVersion(
    actor: string,
    orgId: string,
    routeId: string,
    input: CreateVersionInput,
  ): Promise<RouteDetail> {
    if (input.targets.length === 0) {
      throw new RelayError('invalid_request', {
        message: 'A route version needs at least one target.',
        param: 'targets',
      });
    }
    return db.withTenant(orgId, { isPlatformAdmin: false }, async (tx) => {
      const route = await requireRoute(tx, routeId);
      const next = (await repo.maxVersion(tx, routeId)) + 1;
      const version = await repo.insertVersion(tx, orgId, {
        routeId,
        version: next,
        strategy: input.strategy ?? DEFAULT_STRATEGY,
      });
      for (const t of input.targets) await repo.insertTarget(tx, orgId, version.id, t);
      await audit.appendWithTx(tx, orgId, {
        actor,
        action: 'route.version.create',
        target: routeId,
        data: { version: next, targets: input.targets.length },
      });
      return buildDetail(tx, route);
    });
  }

  async function activateVersion(
    actor: string,
    orgId: string,
    routeId: string,
    versionId: string,
  ): Promise<RouteDetail> {
    return db.withTenant(orgId, { isPlatformAdmin: false }, async (tx) => {
      const route = await requireRoute(tx, routeId);
      const version = await repo.getVersion(tx, versionId);
      if (!version || version.route_id !== routeId) {
        throw new RelayError('not_found', {
          message: `Version '${versionId}' does not belong to route '${routeId}'.`,
        });
      }
      await repo.setActiveVersion(tx, routeId, versionId);
      route.active_version_id = versionId;
      await audit.appendWithTx(tx, orgId, {
        actor,
        action: 'route.activate',
        target: routeId,
        data: { version: version.version },
      });
      return buildDetail(tx, route);
    });
  }

  async function setCacheEnabled(
    actor: string,
    orgId: string,
    routeId: string,
    enabled: boolean,
  ): Promise<RouteDetail> {
    return db.withTenant(orgId, { isPlatformAdmin: false }, async (tx) => {
      const route = await requireRoute(tx, routeId);
      await repo.setCacheEnabled(tx, routeId, enabled);
      route.cache_enabled = enabled;
      await audit.appendWithTx(tx, orgId, {
        actor,
        action: 'route.cache.updated',
        target: routeId,
        data: { cache_enabled: enabled },
      });
      return buildDetail(tx, route);
    });
  }

  async function deleteRoute(actor: string, orgId: string, routeId: string): Promise<void> {
    await db.withTenant(orgId, { isPlatformAdmin: false }, async (tx) => {
      await requireRoute(tx, routeId);
      await audit.appendWithTx(tx, orgId, { actor, action: 'route.delete', target: routeId });
      await repo.deleteRoute(tx, routeId);
    });
  }

  /** Load a route inside the current tx or throw 404 — every mutation fails loud + early. */
  async function requireRoute(tx: Queryable, routeId: string): Promise<RouteRow> {
    const route = await repo.getRoute(tx, routeId);
    if (!route) throw new RelayError('not_found', { message: `Route '${routeId}' not found.` });
    return route;
  }

  /** Assemble the full detail view: versions (newest first) each with their ordered targets. */
  async function buildDetail(tx: Queryable, route: RouteRow): Promise<RouteDetail> {
    const versions = await repo.listVersions(tx, route.id);
    const targets = await repo.listTargets(
      tx,
      versions.map((v) => v.id),
    );
    const byVersion = new Map<string, RouteTarget[]>();
    for (const t of targets) {
      const list = byVersion.get(t.route_version_id) ?? [];
      list.push({
        object: 'route.target',
        id: t.id,
        credential_id: t.credential_id,
        provider: t.provider,
        model: t.model,
        priority: t.priority,
        weight: t.weight,
        known_model: t.known_model,
      });
      byVersion.set(t.route_version_id, list);
    }
    const versionViews: RouteVersion[] = versions.map((v) => ({
      object: 'route.version',
      id: v.id,
      version: v.version,
      strategy: v.strategy,
      is_active: v.id === route.active_version_id,
      created_at: v.created_at,
      targets: byVersion.get(v.id) ?? [],
    }));
    return {
      object: 'route',
      id: route.id,
      model_name: route.model_name,
      app_id: route.app_id,
      cache_enabled: route.cache_enabled,
      active_version_id: route.active_version_id,
      created_at: route.created_at,
      versions: versionViews,
    };
  }

  return {
    listRoutes,
    getRoute,
    createRoute,
    addVersion,
    activateVersion,
    setCacheEnabled,
    deleteRoute,
  };
}
