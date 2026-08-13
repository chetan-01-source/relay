import { describe, it, expect, beforeEach } from 'vitest';
import { isRelayError } from '@relay-ai/shared';
import type { Database, Queryable } from '../../../platform/db.js';
import type { AuditEventInput, AuditRepository } from '../../audit/index.js';
import { createRoutesService } from '../services/routes.service.js';
import type {
  RouteRow,
  RouteTargetRow,
  RouteVersionRow,
  RoutesRepository,
  TargetInput,
} from '../types/routes.types.js';

const fakeDb = {
  withTenant: <T>(_o: string, _s: unknown, fn: (tx: Queryable) => Promise<T>) =>
    fn({} as Queryable),
} as unknown as Database;

// In-memory repository honoring the RoutesRepository contract, so the service's orchestration and
// invariants (active_version_id points at one of the route's own versions, version numbers increment)
// are exercised without a database.
function fakeRepo() {
  const routes = new Map<string, RouteRow>();
  const versions = new Map<string, RouteVersionRow>();
  const targets = new Map<string, RouteTargetRow>();
  let n = 0;
  const now = '2026-07-25T00:00:00Z';

  const repo: RoutesRepository = {
    listRoutes: () =>
      Promise.resolve(
        [...routes.values()].map((r) => {
          const vs = [...versions.values()].filter((v) => v.route_id === r.id);
          const active = vs.find((v) => v.id === r.active_version_id) ?? null;
          const targetCount = [...targets.values()].filter(
            (t) => t.route_version_id === r.active_version_id,
          ).length;
          return {
            ...r,
            active_version: active?.version ?? null,
            active_strategy: active?.strategy ?? null,
            version_count: vs.length,
            target_count: targetCount,
          };
        }),
      ),
    getRoute: (_tx, id) => Promise.resolve(routes.get(id) ?? null),
    // Scope-aware, like the SQL: a lookup for one app must not see the org-wide route, or the
    // service's duplicate check would refuse an override that the database would happily accept.
    getRouteByModel: (_tx, modelName, appId) =>
      Promise.resolve(
        [...routes.values()].find(
          (r) => r.model_name === modelName && (r.app_id ?? null) === (appId ?? null),
        ) ?? null,
      ),
    listVersions: (_tx, routeId) =>
      Promise.resolve(
        [...versions.values()]
          .filter((v) => v.route_id === routeId)
          .sort((a, b) => b.version - a.version),
      ),
    listTargets: (_tx, versionIds) =>
      Promise.resolve([...targets.values()].filter((t) => versionIds.includes(t.route_version_id))),
    getVersion: (_tx, versionId) => Promise.resolve(versions.get(versionId) ?? null),
    maxVersion: (_tx, routeId) =>
      Promise.resolve(
        [...versions.values()]
          .filter((v) => v.route_id === routeId)
          .reduce((max, v) => Math.max(max, v.version), 0),
      ),
    insertRoute: (_tx, orgId, input) => {
      const id = `route-${++n}`;
      const row: RouteRow = {
        id,
        model_name: input.modelName,
        app_id: input.appId,
        cache_enabled: input.cacheEnabled,
        active_version_id: null,
        created_at: now,
      };
      routes.set(id, row);
      return Promise.resolve(row);
    },
    insertVersion: (_tx, _orgId, input) => {
      const id = `ver-${++n}`;
      const row: RouteVersionRow = {
        id,
        route_id: input.routeId,
        version: input.version,
        strategy: input.strategy,
        created_at: now,
      };
      versions.set(id, row);
      return Promise.resolve(row);
    },
    insertTarget: (_tx, _orgId, versionId, t: TargetInput) => {
      const id = `tgt-${++n}`;
      targets.set(id, {
        id,
        route_version_id: versionId,
        credential_id: t.credential_id,
        provider: t.provider,
        model: t.model,
        priority: t.priority ?? 100,
        weight: t.weight ?? 1,
        known_model: true,
      });
      return Promise.resolve();
    },
    setActiveVersion: (_tx, routeId, versionId) => {
      routes.get(routeId)!.active_version_id = versionId;
      return Promise.resolve();
    },
    setCacheEnabled: (_tx, routeId, enabled) => {
      routes.get(routeId)!.cache_enabled = enabled;
      return Promise.resolve();
    },
    deleteRoute: (_tx, routeId) => {
      routes.delete(routeId);
      return Promise.resolve();
    },
  };
  return { repo, routes, versions, targets };
}

function fakeAudit() {
  const events: AuditEventInput[] = [];
  const audit: AuditRepository = {
    appendWithTx: (_tx, orgId, event) => {
      events.push(event);
      return Promise.resolve({
        id: 'a',
        orgId,
        seq: events.length,
        actor: event.actor,
        action: event.action,
        target: event.target ?? null,
        hash: Buffer.alloc(32),
      });
    },
  };
  return { audit, events };
}

const target: TargetInput = { credential_id: 'cred-1', provider: 'openai', model: 'gpt-4o' };

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (isRelayError(err)) return err.code;
    throw err;
  }
  throw new Error('expected a RelayError');
}

describe('routes service', () => {
  let repoBundle: ReturnType<typeof fakeRepo>;
  let auditBundle: ReturnType<typeof fakeAudit>;

  beforeEach(() => {
    repoBundle = fakeRepo();
    auditBundle = fakeAudit();
  });

  function build() {
    return createRoutesService({ db: fakeDb, repo: repoBundle.repo, audit: auditBundle.audit });
  }

  it('creates a bare route (no targets) with no active version', async () => {
    const detail = await build().createRoute('u', 'org-1', { model_name: 'fast' });
    expect(detail.model_name).toBe('fast');
    expect(detail.active_version_id).toBeNull();
    expect(detail.versions).toHaveLength(0);
    expect(auditBundle.events.some((e) => e.action === 'route.create')).toBe(true);
  });

  it('creates a route with targets → version 1 becomes active', async () => {
    const detail = await build().createRoute('u', 'org-1', {
      model_name: 'gpt-4o',
      targets: [target],
    });
    expect(detail.versions).toHaveLength(1);
    expect(detail.active_version_id).toBe(detail.versions[0]!.id);
    expect(detail.versions[0]!.is_active).toBe(true);
    expect(detail.versions[0]!.targets[0]!.provider).toBe('openai');
  });

  it('rejects a duplicate model_name (409 conflict)', async () => {
    const svc = build();
    await svc.createRoute('u', 'org-1', { model_name: 'dup' });
    expect(await codeOf(() => svc.createRoute('u', 'org-1', { model_name: 'dup' }))).toBe(
      'conflict',
    );
  });

  it('lets an application override the org-wide route for the same model name', async () => {
    const svc = build();
    const orgRoute = await svc.createRoute('u', 'org-1', { model_name: 'fast' });
    const appRoute = await svc.createRoute('u', 'org-1', { model_name: 'fast', app_id: 'app-1' });

    // Same alias, two scopes — this is the override, not a duplicate.
    expect(orgRoute.app_id).toBeNull();
    expect(appRoute.app_id).toBe('app-1');
    expect(appRoute.id).not.toBe(orgRoute.id);
  });

  it('still rejects a second route in the SAME application scope', async () => {
    const svc = build();
    await svc.createRoute('u', 'org-1', { model_name: 'fast', app_id: 'app-1' });
    expect(
      await codeOf(() => svc.createRoute('u', 'org-1', { model_name: 'fast', app_id: 'app-1' })),
    ).toBe('conflict');
    // …while a different application is free to define its own.
    const other = await svc.createRoute('u', 'org-1', { model_name: 'fast', app_id: 'app-2' });
    expect(other.app_id).toBe('app-2');
  });

  it('adds a version: increments the ordinal, keeps the old active version', async () => {
    const svc = build();
    const created = await svc.createRoute('u', 'org-1', { model_name: 'm', targets: [target] });
    const activeBefore = created.active_version_id;
    const after = await svc.addVersion('u', 'org-1', created.id, { targets: [target] });
    expect(after.versions).toHaveLength(2);
    expect(after.versions.map((v) => v.version).sort()).toEqual([1, 2]);
    // adding a version does NOT auto-activate it — rollback/activate is an explicit step
    expect(after.active_version_id).toBe(activeBefore);
  });

  it('refuses an empty-target version (400)', async () => {
    const svc = build();
    const r = await svc.createRoute('u', 'org-1', { model_name: 'm' });
    expect(await codeOf(() => svc.addVersion('u', 'org-1', r.id, { targets: [] }))).toBe(
      'invalid_request',
    );
  });

  it('activates a version = rollback; a foreign version 404s', async () => {
    const svc = build();
    const r = await svc.createRoute('u', 'org-1', { model_name: 'm', targets: [target] });
    const v2 = (await svc.addVersion('u', 'org-1', r.id, { targets: [target] })).versions.find(
      (v) => v.version === 2,
    )!;
    const rolled = await svc.activateVersion('u', 'org-1', r.id, v2.id);
    expect(rolled.active_version_id).toBe(v2.id);
    expect(rolled.versions.find((v) => v.id === v2.id)!.is_active).toBe(true);
    expect(auditBundle.events.some((e) => e.action === 'route.activate')).toBe(true);
    expect(await codeOf(() => svc.activateVersion('u', 'org-1', r.id, 'ghost'))).toBe('not_found');
  });

  it('toggles the per-route cache flag and audits it', async () => {
    const svc = build();
    const r = await svc.createRoute('u', 'org-1', { model_name: 'm' });
    expect(r.cache_enabled).toBe(false);
    const on = await svc.setCacheEnabled('u', 'org-1', r.id, true);
    expect(on.cache_enabled).toBe(true);
    expect(auditBundle.events.some((e) => e.action === 'route.cache.updated')).toBe(true);
  });

  it('deletes a route; deleting an unknown route 404s', async () => {
    const svc = build();
    const r = await svc.createRoute('u', 'org-1', { model_name: 'm' });
    await svc.deleteRoute('u', 'org-1', r.id);
    expect(await svc.getRoute('org-1', r.id)).toBeNull();
    expect(await codeOf(() => svc.deleteRoute('u', 'org-1', 'ghost'))).toBe('not_found');
  });

  it('lists routes with an active-version summary', async () => {
    const svc = build();
    await svc.createRoute('u', 'org-1', { model_name: 'a', targets: [target] });
    await svc.createRoute('u', 'org-1', { model_name: 'b' });
    const list = await svc.listRoutes('org-1');
    expect(list).toHaveLength(2);
    const a = list.find((r) => r.model_name === 'a')!;
    expect(a.version_count).toBe(1);
    expect(a.target_count).toBe(1);
    expect(a.active_version).toBe(1);
  });
});
