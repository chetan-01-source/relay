/**
 * Typed control-plane API client (Week 2 Day 6 · FE-1). Runs server-side (RSC / server actions):
 * it fetches the caller's Logto access token for the Relay API resource and attaches it as a bearer
 * token on every /api/* request. Response/request shapes come from app/lib/api-types.ts, which is
 * generated from the gateway's OpenAPI spec by `pnpm gen:api` (wired into `make generate`) — so the
 * client cannot drift from the server contract.
 */
import { getAccessToken } from '@logto/next/server-actions';
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
type EntitlementsResponse =
  paths['/api/v1/platform/orgs/{orgId}/entitlements']['get']['responses']['200']['content']['application/json'];

async function bearer(): Promise<string> {
  return `Bearer ${await getAccessToken(logtoConfig, RELAY_API_RESOURCE)}`;
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

/** Send a body-bearing control-plane request (POST/PUT). Surfaces the server's error message. */
async function apiSend<T>(method: 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
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
  return (await res.json()) as T;
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
