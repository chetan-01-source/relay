/**
 * Routes module interfaces (Week 3 Day 13) — the control-plane CRUD over the routing tables the
 * Day-9 library module (modules/routing) reads on the hot path. A route is the client-facing `model`
 * alias; each has ordered/weighted versions of targets, and "rollback" is activating an older version.
 *
 * Layering (DEVELOPMENT.md §2): routes → controller → service → repository → queries. All writes run
 * inside `withTenant` so RLS isolates them; this module owns NO hot-path code.
 */
import type { Queryable } from '../../../platform/db.js';

export type RoutingStrategy = 'priority' | 'weighted';

// ── DB row shapes ────────────────────────────────────────────────────────────
export interface RouteRow {
  id: string;
  model_name: string;
  cache_enabled: boolean;
  active_version_id: string | null;
  created_at: string;
}

export interface RouteListRow extends RouteRow {
  active_version: number | null; // the active version's ordinal, or null when none is active
  active_strategy: RoutingStrategy | null;
  version_count: number;
  target_count: number; // targets in the active version
}

export interface RouteVersionRow {
  id: string;
  route_id: string;
  version: number;
  strategy: RoutingStrategy;
  created_at: string;
}

export interface RouteTargetRow {
  id: string;
  route_version_id: string;
  credential_id: string;
  provider: string;
  model: string;
  priority: number;
  weight: number;
  known_model: boolean; // true when (provider, model) is present in model_catalog (capability lint)
}

// ── API input shapes ─────────────────────────────────────────────────────────
export interface TargetInput {
  credential_id: string;
  provider: string;
  model: string;
  priority?: number;
  weight?: number;
}

export interface CreateRouteInput {
  model_name: string;
  strategy?: RoutingStrategy;
  cache_enabled?: boolean;
  targets?: TargetInput[];
}

export interface CreateVersionInput {
  strategy?: RoutingStrategy;
  targets: TargetInput[];
}

// ── API output shapes ────────────────────────────────────────────────────────
export interface RouteTarget {
  object: 'route.target';
  id: string;
  credential_id: string;
  provider: string;
  model: string;
  priority: number;
  weight: number;
  known_model: boolean;
}

export interface RouteVersion {
  object: 'route.version';
  id: string;
  version: number;
  strategy: RoutingStrategy;
  is_active: boolean;
  created_at: string;
  targets: RouteTarget[];
}

export interface Route {
  object: 'route';
  id: string;
  model_name: string;
  cache_enabled: boolean;
  active_version_id: string | null;
  active_version: number | null;
  version_count: number;
  target_count: number;
  created_at: string;
}

export interface RouteDetail {
  object: 'route';
  id: string;
  model_name: string;
  cache_enabled: boolean;
  active_version_id: string | null;
  created_at: string;
  versions: RouteVersion[];
}

// ── layer contracts ──────────────────────────────────────────────────────────
export interface RoutesRepository {
  listRoutes(tx: Queryable): Promise<RouteListRow[]>;
  getRoute(tx: Queryable, id: string): Promise<RouteRow | null>;
  getRouteByModel(tx: Queryable, modelName: string): Promise<RouteRow | null>;
  listVersions(tx: Queryable, routeId: string): Promise<RouteVersionRow[]>;
  listTargets(tx: Queryable, versionIds: string[]): Promise<RouteTargetRow[]>;
  getVersion(tx: Queryable, versionId: string): Promise<RouteVersionRow | null>;
  maxVersion(tx: Queryable, routeId: string): Promise<number>;
  insertRoute(
    tx: Queryable,
    orgId: string,
    input: { modelName: string; cacheEnabled: boolean },
  ): Promise<RouteRow>;
  insertVersion(
    tx: Queryable,
    orgId: string,
    input: { routeId: string; version: number; strategy: RoutingStrategy },
  ): Promise<RouteVersionRow>;
  insertTarget(tx: Queryable, orgId: string, versionId: string, t: TargetInput): Promise<void>;
  setActiveVersion(tx: Queryable, routeId: string, versionId: string): Promise<void>;
  setCacheEnabled(tx: Queryable, routeId: string, enabled: boolean): Promise<void>;
  deleteRoute(tx: Queryable, routeId: string): Promise<void>;
}

export interface RoutesService {
  listRoutes(orgId: string): Promise<Route[]>;
  getRoute(orgId: string, id: string): Promise<RouteDetail | null>;
  createRoute(actor: string, orgId: string, input: CreateRouteInput): Promise<RouteDetail>;
  addVersion(
    actor: string,
    orgId: string,
    routeId: string,
    input: CreateVersionInput,
  ): Promise<RouteDetail>;
  activateVersion(
    actor: string,
    orgId: string,
    routeId: string,
    versionId: string,
  ): Promise<RouteDetail>;
  setCacheEnabled(
    actor: string,
    orgId: string,
    routeId: string,
    enabled: boolean,
  ): Promise<RouteDetail>;
  deleteRoute(actor: string, orgId: string, routeId: string): Promise<void>;
}
