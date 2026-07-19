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

/** GET a control-plane path with the caller's Logto token attached. Throws on a non-2xx response. */
async function apiGet<T>(path: string): Promise<T> {
  const token = await getAccessToken(logtoConfig, RELAY_API_RESOURCE);
  const res = await fetch(`${API_BASE_URL}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`GET ${path} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

/** The authenticated caller's tenant context, straight from the gateway. */
export function getMe(): Promise<MeResponse> {
  return apiGet<MeResponse>('/api/v1/me');
}
