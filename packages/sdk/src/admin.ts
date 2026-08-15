/**
 * The control plane — applications, keys, providers, routes, budgets, analytics, audit, traffic and
 * the plan.
 *
 * Every request/response type on this client is projected out of `generated/api-types.ts`, which
 * `pnpm gen:api` regenerates from the gateway's own OpenAPI document. Nothing here is hand-typed, so
 * the client cannot drift from the server; CI fails if the checked-in types differ from a fresh
 * generation.
 *
 * A SEPARATE client from the data plane, on purpose. It is authenticated with a Logto access token,
 * not a virtual key (ADR-0002's two auth planes), and making that a type-level distinction means you
 * cannot accidentally ship an admin token into browser code that only needed to send a completion.
 */
import type { paths } from './generated/api-types.js';
import { Http, type RetryOptions, type TokenSource } from './http.js';

/** `GET /x` → its 200 JSON body. */
type Get<P extends keyof paths> = paths[P] extends {
  get: { responses: { 200: { content: { 'application/json': infer R } } } };
}
  ? R
  : never;

/** `POST /x` → its 200/201 JSON body. */
type Created<P extends keyof paths> = paths[P] extends {
  post: { responses: infer R };
}
  ? R extends { 201: { content: { 'application/json': infer B } } }
    ? B
    : R extends { 200: { content: { 'application/json': infer B } } }
      ? B
      : never
  : never;

/** `POST /x` → its request body. */
type PostBody<P extends keyof paths> = paths[P] extends {
  post: { requestBody: { content: { 'application/json': infer B } } };
}
  ? B
  : never;

/** `PUT /x` → its request body. */
type PutBody<P extends keyof paths> = paths[P] extends {
  put: { requestBody: { content: { 'application/json': infer B } } };
}
  ? B
  : never;

/** Unwrap a `{ object: 'list', data: T[] }` envelope to `T`. */
type Item<L> = L extends { data?: (infer T)[] } ? T : never;

export type Application = Created<'/api/v1/apps'>;
export type CreateApplicationInput = PostBody<'/api/v1/apps'>;
export type IssuedKey = Created<'/api/v1/apps/{appId}/keys'>;
export type IssueKeyInput = PostBody<'/api/v1/apps/{appId}/keys'>;
export type VirtualKey = Item<Get<'/api/v1/apps/{appId}/keys'>>;
export type Provider = Created<'/api/v1/providers'>;
export type CreateProviderInput = PostBody<'/api/v1/providers'>;
export type Route = Item<Get<'/api/v1/routes'>>;
export type CreateRouteInput = PostBody<'/api/v1/routes'>;
export type RouteDetail = Get<'/api/v1/routes/{routeId}'>;
export type Budget = Item<Get<'/api/v1/budgets'>>;
export type SetBudgetInput = PutBody<'/api/v1/budgets/{period}'>;
export type UsageSummary = Get<'/api/v1/analytics/usage'>;
export type TrafficEvent = Item<Get<'/api/v1/traffic'>>;
export type AuditEntry = Item<Get<'/api/v1/audit'>>;
export type EffectivePlan = Get<'/api/v1/plan'>;
export type PlanCatalogEntry = Item<Get<'/api/v1/plans'>>;
export type Subscription = Created<'/api/v1/plan/change'>;
export type Identity = Get<'/api/v1/me'>;

export type BudgetPeriod = 'daily' | 'monthly';

export interface AdminClientOptions {
  baseUrl: string;
  /**
   * A Logto access token for the Relay API resource, or a function returning one. Pass a function
   * for anything long-running: tokens expire in about an hour, and `machineTokenSource()` mints and
   * refreshes them from a client id/secret with no human in the loop.
   */
  token: string | TokenSource;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retry?: RetryOptions;
  fetch?: typeof fetch;
}

export function createAdminClient(options: AdminClientOptions) {
  const http = new Http({
    baseUrl: options.baseUrl,
    token: options.token,
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.retry ? { retry: options.retry } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  const get = async <T>(path: string, query?: Record<string, string | number | undefined>) =>
    (await http.json<T>({ path, ...(query ? { query } : {}) })).data;
  const post = async <T>(path: string, body?: unknown) =>
    (await http.json<T>({ method: 'POST', path, ...(body !== undefined ? { body } : {}) })).data;
  const put = async <T>(path: string, body: unknown) =>
    (await http.json<T>({ method: 'PUT', path, body })).data;
  const del = async (path: string) => {
    await http.json<void>({ method: 'DELETE', path });
  };
  const listOf = async <T>(path: string, query?: Record<string, string | number | undefined>) =>
    (await get<{ data?: T[] }>(path, query)).data ?? [];

  return {
    /** Who this token is, which org it is scoped to, and whether it administers that org. */
    me: () => get<Identity>('/api/v1/me'),

    apps: {
      list: () => listOf<Application>('/api/v1/apps'),
      create: (input: CreateApplicationInput) => post<Application>('/api/v1/apps', input),
      get: (appId: string) => get<Application>(`/api/v1/apps/${enc(appId)}`),
      keys: {
        list: (appId: string) => listOf<VirtualKey>(`/api/v1/apps/${enc(appId)}/keys`),
        /**
         * Mint a key. `key` on the result is the ONLY time the plaintext exists — Relay stores a
         * verifier, not the secret, so it can never be read back. Persist it here or lose it.
         */
        issue: (appId: string, input: IssueKeyInput = {}) =>
          post<IssuedKey>(`/api/v1/apps/${enc(appId)}/keys`, input),
        /** Mint a successor and put the predecessor into its grace window. */
        rotate: (keyId: string) => post<IssuedKey>(`/api/v1/keys/${enc(keyId)}/rotate`),
        /** Immediate: every worker drops the key within about a second. */
        revoke: (keyId: string) => post<VirtualKey>(`/api/v1/keys/${enc(keyId)}/revoke`),
      },
    },

    providers: {
      list: () => listOf<Provider>('/api/v1/providers'),
      /** The upstream key is sealed on write and never readable again — not here, not in the console. */
      create: (input: CreateProviderInput) => post<Provider>('/api/v1/providers', input),
      get: (id: string) => get<Provider>(`/api/v1/providers/${enc(id)}`),
      delete: (id: string) => del(`/api/v1/providers/${enc(id)}`),
    },

    routes: {
      list: () => listOf<Route>('/api/v1/routes'),
      create: (input: CreateRouteInput) => post<RouteDetail>('/api/v1/routes', input),
      get: (routeId: string) => get<RouteDetail>(`/api/v1/routes/${enc(routeId)}`),
      /** Versions are immutable; rolling back is activating an older one. */
      createVersion: (routeId: string, input: PostBody<'/api/v1/routes/{routeId}/versions'>) =>
        post<RouteDetail>(`/api/v1/routes/${enc(routeId)}/versions`, input),
      activateVersion: (routeId: string, versionId: string) =>
        post<RouteDetail>(`/api/v1/routes/${enc(routeId)}/versions/${enc(versionId)}/activate`),
    },

    budgets: {
      list: () => listOf<Budget>('/api/v1/budgets'),
      set: (period: BudgetPeriod, input: SetBudgetInput) =>
        put<Budget>(`/api/v1/budgets/${period}`, input),
      remove: (period: BudgetPeriod) => del(`/api/v1/budgets/${period}`),
      /** An application ceiling applies IN ADDITION to any org-wide one. */
      setForApp: (appId: string, period: BudgetPeriod, input: SetBudgetInput) =>
        put<Budget>(`/api/v1/apps/${enc(appId)}/budgets/${period}`, input),
      removeForApp: (appId: string, period: BudgetPeriod) =>
        del(`/api/v1/apps/${enc(appId)}/budgets/${period}`),
    },

    analytics: {
      usage: (query: { from?: string; to?: string; group_by?: string } = {}) =>
        get<UsageSummary>('/api/v1/analytics/usage', query),
    },

    traffic: {
      list: (query: { limit?: number; before?: string; status?: string } = {}) =>
        listOf<TrafficEvent>('/api/v1/traffic', query),
      get: (requestId: string) => get<TrafficEvent>(`/api/v1/traffic/${enc(requestId)}`),
    },

    audit: {
      list: (query: { limit?: number; before?: string } = {}) =>
        listOf<AuditEntry>('/api/v1/audit', query),
      /** Recompute the hash chain and report the first entry that does not verify, if any. */
      verify: () => post<{ ok?: boolean; checked?: number }>('/api/v1/audit/verify'),
    },

    plan: {
      /**
       * Effective limits with provenance and current usage — the same payload the console's plan
       * page renders, so a customer's dashboard and their provisioning script agree by construction.
       */
      get: () => get<EffectivePlan>('/api/v1/plan'),
      /** The purchasable catalog. Empty in the self-hosted edition, where nothing is for sale. */
      catalog: () => listOf<PlanCatalogEntry>('/api/v1/plans'),
      change: (planCode: string) =>
        post<Subscription>('/api/v1/plan/change', { plan_code: planCode }),
    },
  };
}

export type AdminClient = ReturnType<typeof createAdminClient>;

/** Path segments are ids, not free text — but encoding them is a one-line habit worth keeping. */
function enc(segment: string): string {
  return encodeURIComponent(segment);
}
