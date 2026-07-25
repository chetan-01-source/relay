/**
 * Typed control-plane API client (Week 2 Day 6 · FE-1). Runs server-side (RSC / server actions):
 * it fetches the caller's Logto access token for the Relay API resource and attaches it as a bearer
 * token on every /api/* request. Response/request shapes come from app/lib/api-types.ts, which is
 * generated from the gateway's OpenAPI spec by `pnpm gen:api` (wired into `make generate`) — so the
 * client cannot drift from the server contract.
 */
import { getAccessTokenRSC } from '@logto/next/server-actions';
import { logtoConfig } from './logto';
import type { paths } from './api-types';

// The Relay API resource indicator the gateway validates as the JWT audience (see seed-auth).
const RELAY_API_RESOURCE = process.env.RELAY_API_RESOURCE ?? 'https://relay.gateway/api';
// Base URL of the gateway's control plane.
const API_BASE_URL = process.env.RELAY_API_BASE_URL ?? 'http://localhost:3000';

type MeResponse = paths['/api/v1/me']['get']['responses']['200']['content']['application/json'];
type OrgsList =
  paths['/api/v1/platform/orgs']['get']['responses']['200']['content']['application/json'];
export type Organization =
  paths['/api/v1/platform/orgs']['post']['responses']['201']['content']['application/json'];
export type OnboardOrgInput =
  paths['/api/v1/platform/orgs']['post']['requestBody']['content']['application/json'];
export type Org =
  paths['/api/v1/platform/orgs/{orgId}']['get']['responses']['200']['content']['application/json'];
type EntitlementsResponse =
  paths['/api/v1/platform/orgs/{orgId}/entitlements']['get']['responses']['200']['content']['application/json'];

// ── Day-13 control-plane shapes (build + operate) ───────────────────────────────────────────────
type AppsList = paths['/api/v1/apps']['get']['responses']['200']['content']['application/json'];
export type Application =
  paths['/api/v1/apps']['post']['responses']['201']['content']['application/json'];
export type CreateAppInput =
  paths['/api/v1/apps']['post']['requestBody']['content']['application/json'];
type KeysList =
  paths['/api/v1/apps/{appId}/keys']['get']['responses']['200']['content']['application/json'];
export type IssuedKey =
  paths['/api/v1/apps/{appId}/keys']['post']['responses']['201']['content']['application/json'];
export type IssueKeyInput =
  paths['/api/v1/apps/{appId}/keys']['post']['requestBody']['content']['application/json'];
type ProvidersList =
  paths['/api/v1/providers']['get']['responses']['200']['content']['application/json'];
export type Provider =
  paths['/api/v1/providers']['post']['responses']['201']['content']['application/json'];
export type CreateProviderInput =
  paths['/api/v1/providers']['post']['requestBody']['content']['application/json'];
export type UsageSummary =
  paths['/api/v1/analytics/usage']['get']['responses']['200']['content']['application/json'];
type AuditList = paths['/api/v1/audit']['get']['responses']['200']['content']['application/json'];

// ── Day-13 (deferred-now-built): routes editor, members, live traffic ────────────────────────────
type RoutesList = paths['/api/v1/routes']['get']['responses']['200']['content']['application/json'];
export type RouteSummary = NonNullable<RoutesList['data']>[number];
export type RouteDetail =
  paths['/api/v1/routes/{routeId}']['get']['responses']['200']['content']['application/json'];
export type RouteVersion = NonNullable<RouteDetail['versions']>[number];
export type CreateRouteInput =
  paths['/api/v1/routes']['post']['requestBody']['content']['application/json'];
export type CreateVersionInput =
  paths['/api/v1/routes/{routeId}/versions']['post']['requestBody']['content']['application/json'];
type MembersList =
  paths['/api/v1/platform/orgs/{orgId}/members']['get']['responses']['200']['content']['application/json'];
export type Member = NonNullable<MembersList['data']>[number];
export type TrafficList =
  paths['/api/v1/traffic']['get']['responses']['200']['content']['application/json'];
export type TrafficEvent = NonNullable<TrafficList['data']>[number];

async function bearer(): Promise<string> {
  // RSC-safe: the console reads run inside React Server Components, where the SDK cannot write the
  // session cookie. getAccessTokenRSC uses ignoreCookieChange, so refreshing/minting the resource
  // token doesn't throw "Cookies can only be modified in a Server Action or Route Handler".
  return `Bearer ${await getAccessTokenRSC(logtoConfig, RELAY_API_RESOURCE)}`;
}

/** GET a control-plane path with the caller's Logto token attached. Throws on a non-2xx response. */
async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    headers: { authorization: await bearer() },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

/** Send a control-plane mutation (POST/PUT/DELETE). Surfaces the server's error message; tolerant of
 * an empty (204) response body. */
async function apiSend<T>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: { authorization: await bearer(), 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(detail?.error?.message ?? `${method} ${path} failed: ${res.status}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** The authenticated caller's tenant context, straight from the gateway. */
export function getMe(): Promise<MeResponse> {
  return apiGet<MeResponse>('/api/v1/me');
}

export function listOrgs(): Promise<OrgsList> {
  return apiGet<OrgsList>('/api/v1/platform/orgs');
}

export function onboardOrg(input: OnboardOrgInput): Promise<Organization> {
  return apiSend<Organization>('POST', '/api/v1/platform/orgs', input);
}

/** Retrieve one org's record (status + onboarding state) — the platform-admin detail page. */
export function getOrg(orgId: string): Promise<Org> {
  return apiGet<Org>(`/api/v1/platform/orgs/${orgId}`);
}

/** Suspend an org; the data plane rejects its keys ≤1s later (snapshot invalidation). */
export function suspendOrg(orgId: string): Promise<Org> {
  return apiSend<Org>('POST', `/api/v1/platform/orgs/${orgId}/suspend`);
}

/** Reactivate a suspended org. */
export function unsuspendOrg(orgId: string): Promise<Org> {
  return apiSend<Org>('POST', `/api/v1/platform/orgs/${orgId}/unsuspend`);
}

/** Advance the org's onboarding state machine one step (created → … → first_request). */
export function advanceOnboarding(orgId: string): Promise<Org> {
  return apiSend<Org>('POST', `/api/v1/platform/orgs/${orgId}/onboarding/advance`);
}

export function getEntitlements(orgId: string): Promise<EntitlementsResponse> {
  return apiGet<EntitlementsResponse>(`/api/v1/platform/orgs/${orgId}/entitlements`);
}

export function updateEntitlements(
  orgId: string,
  features: Record<string, unknown>,
): Promise<EntitlementsResponse> {
  return apiSend<EntitlementsResponse>('PUT', `/api/v1/platform/orgs/${orgId}/entitlements`, {
    features,
  });
}

// ── Applications ────────────────────────────────────────────────────────────────────────────────
export function listApps(): Promise<AppsList> {
  return apiGet<AppsList>('/api/v1/apps');
}
export function createApp(input: CreateAppInput): Promise<Application> {
  return apiSend<Application>('POST', '/api/v1/apps', input);
}

// ── Virtual keys ──────────────────────────────────────────────────────────────────────────────
export function listKeys(appId: string): Promise<KeysList> {
  return apiGet<KeysList>(`/api/v1/apps/${appId}/keys`);
}
/** Issue a key. The plaintext `key` is returned exactly ONCE here and is never re-fetchable. */
export function issueKey(appId: string, input: IssueKeyInput): Promise<IssuedKey> {
  return apiSend<IssuedKey>('POST', `/api/v1/apps/${appId}/keys`, input);
}
export function rotateKey(keyId: string): Promise<IssuedKey> {
  return apiSend<IssuedKey>('POST', `/api/v1/keys/${keyId}/rotate`);
}
export function revokeKey(keyId: string): Promise<IssuedKey> {
  return apiSend<IssuedKey>('POST', `/api/v1/keys/${keyId}/revoke`);
}

// ── Providers (write-only secrets) ───────────────────────────────────────────────────────────────
export function listProviders(): Promise<ProvidersList> {
  return apiGet<ProvidersList>('/api/v1/providers');
}
/** Store a provider credential. The secret is sealed on write and NEVER returned by any read. */
export function createProvider(input: CreateProviderInput): Promise<Provider> {
  return apiSend<Provider>('POST', '/api/v1/providers', input);
}
export function deleteProvider(id: string): Promise<void> {
  return apiSend<void>('DELETE', `/api/v1/providers/${id}`);
}

// ── Analytics + audit (read model) ───────────────────────────────────────────────────────────────
export function getUsage(params?: {
  group_by?: 'app' | 'route' | 'model' | 'day';
  from?: string;
  to?: string;
}): Promise<UsageSummary> {
  const qs = new URLSearchParams();
  if (params?.group_by) qs.set('group_by', params.group_by);
  if (params?.from) qs.set('from', params.from);
  if (params?.to) qs.set('to', params.to);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return apiGet<UsageSummary>(`/api/v1/analytics/usage${suffix}`);
}

/** Cross-org spend summary (platform-admin only). Same UsageSummary shape, keyed by org_id. */
export function getPlatformUsage(params?: { from?: string; to?: string }): Promise<UsageSummary> {
  const qs = new URLSearchParams();
  if (params?.from) qs.set('from', params.from);
  if (params?.to) qs.set('to', params.to);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return apiGet<UsageSummary>(`/api/v1/platform/analytics/usage${suffix}`);
}

export function listAudit(params?: { limit?: number; before?: number }): Promise<AuditList> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.before) qs.set('before', String(params.before));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return apiGet<AuditList>(`/api/v1/audit${suffix}`);
}

// ── Routes editor ────────────────────────────────────────────────────────────────────────────────
export function listRoutes(): Promise<RoutesList> {
  return apiGet<RoutesList>('/api/v1/routes');
}
export function getRoute(routeId: string): Promise<RouteDetail> {
  return apiGet<RouteDetail>(`/api/v1/routes/${routeId}`);
}
export function createRoute(input: CreateRouteInput): Promise<RouteDetail> {
  return apiSend<RouteDetail>('POST', '/api/v1/routes', input);
}
export function addRouteVersion(routeId: string, input: CreateVersionInput): Promise<RouteDetail> {
  return apiSend<RouteDetail>('POST', `/api/v1/routes/${routeId}/versions`, input);
}
export function activateRouteVersion(routeId: string, versionId: string): Promise<RouteDetail> {
  return apiSend<RouteDetail>('POST', `/api/v1/routes/${routeId}/activate`, {
    version_id: versionId,
  });
}
export function setRouteCache(routeId: string, enabled: boolean): Promise<RouteDetail> {
  return apiSend<RouteDetail>('PATCH', `/api/v1/routes/${routeId}/cache`, {
    cache_enabled: enabled,
  });
}
export function deleteRoute(routeId: string): Promise<void> {
  return apiSend<void>('DELETE', `/api/v1/routes/${routeId}`);
}

// ── Org members (platform-admin, via Logto) ────────────────────────────────────────────────────
export function listMembers(orgId: string): Promise<MembersList> {
  return apiGet<MembersList>(`/api/v1/platform/orgs/${orgId}/members`);
}
export function inviteMember(orgId: string, email: string): Promise<{ invitation_id: string }> {
  return apiSend<{ invitation_id: string }>('POST', `/api/v1/platform/orgs/${orgId}/members`, {
    email,
  });
}
export function removeMember(orgId: string, userId: string): Promise<void> {
  return apiSend<void>('DELETE', `/api/v1/platform/orgs/${orgId}/members/${userId}`);
}

// ── Live traffic + trace detail ──────────────────────────────────────────────────────────────────
export function listTraffic(params?: { limit?: number; status?: string }): Promise<TrafficList> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.status) qs.set('status', params.status);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return apiGet<TrafficList>(`/api/v1/traffic${suffix}`);
}
export function getTrace(requestId: string): Promise<TrafficList> {
  return apiGet<TrafficList>(`/api/v1/traffic/${encodeURIComponent(requestId)}`);
}

/** Fetch the caller's Relay API bearer + base URL for a server-side SSE proxy (the live-traffic feed;
 * a browser EventSource can't attach an Authorization header, so a Next route handler pipes it). */
export async function trafficStreamUpstream(): Promise<{ url: string; authorization: string }> {
  return { url: `${API_BASE_URL}/api/v1/traffic/stream`, authorization: await bearer() };
}
