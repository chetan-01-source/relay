/**
 * Typed control-plane API client (Week 2 Day 6 · FE-1). Runs server-side (RSC / server actions):
 * it fetches the caller's Logto access token for the Relay API resource and attaches it as a bearer
 * token on every /api/* request. Response/request shapes come from app/lib/api-types.ts, which is
 * generated from the gateway's OpenAPI spec by `pnpm gen:api` (wired into `make generate`) — so the
 * client cannot drift from the server contract.
 */
import { cache } from 'react';
import { getAccessTokenRSC, getLogtoContext } from '@logto/next/server-actions';
import { logtoConfig } from './logto';
import { pickOrgId } from './org';
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
type InvitationsList =
  paths['/api/v1/platform/orgs/{orgId}/invitations']['get']['responses']['200']['content']['application/json'];
export type Invitation = NonNullable<InvitationsList['data']>[number];
/** What the invitee sees before joining — names the org, and only ever reaches the invited address. */
export type InvitationOffer =
  paths['/api/v1/invitations/{invitationId}']['get']['responses']['200']['content']['application/json'];
export type AcceptedInvitation =
  paths['/api/v1/invitations/{invitationId}/accept']['post']['responses']['200']['content']['application/json'];
export type TrafficList =
  paths['/api/v1/traffic']['get']['responses']['200']['content']['application/json'];
export type TrafficEvent = NonNullable<TrafficList['data']>[number];

// ── Plans (ADR-0014) ─────────────────────────────────────────────────────────────────────────────
export type EffectivePlan =
  paths['/api/v1/plan']['get']['responses']['200']['content']['application/json'];
type PlanCatalog = paths['/api/v1/plans']['get']['responses']['200']['content']['application/json'];
export type PlanCatalogEntry = NonNullable<PlanCatalog['data']>[number];
export type Subscription =
  paths['/api/v1/plan/change']['post']['responses']['200']['content']['application/json'];

// ── Data-plane shapes (model discovery + the chat hot path) ──────────────────────────────────────
type ModelsList = paths['/v1/models']['get']['responses']['200']['content']['application/json'];
export type ModelObject = NonNullable<ModelsList['data']>[number];
export type ChatCompletionInput =
  paths['/v1/chat/completions']['post']['requestBody']['content']['application/json'];

/** The onboarding states the platform state machine accepts (the `created` seed is not settable). */
export type OnboardingState = NonNullable<
  paths['/api/v1/platform/orgs/{orgId}/onboarding/advance']['post']['requestBody']['content']['application/json']
>['state'];

/**
 * The org this request acts as, or null when the user belongs to none (a platform admin with no
 * membership is legitimate — the admin screens need no tenant).
 *
 * Wrapped in React's `cache` so the session cookie is decrypted once per request even though every
 * API call on the page asks for a bearer token.
 */
const currentOrgId = cache(async (): Promise<string | null> => {
  try {
    const { claims } = await getLogtoContext(logtoConfig);
    return pickOrgId(claims?.organizations);
  } catch {
    // No/invalid session: the caller is about to be redirected by requireUser anyway.
    return null;
  }
});

async function bearer(): Promise<string> {
  // RSC-safe: the console reads run inside React Server Components, where the SDK cannot write the
  // session cookie. getAccessTokenRSC uses ignoreCookieChange, so refreshing/minting the resource
  // token doesn't throw "Cookies can only be modified in a Server Action or Route Handler".
  //
  // The third argument is what makes the control plane work at all. The gateway resolves the tenant
  // from the token's `organization_id` claim, and Logto sets that ONLY on an organization-scoped
  // grant — asking for the resource alone yields a token with no tenant, so every org-scoped page
  // would see `org_id: null` and redirect home. Undefined for a user with no membership (a platform
  // admin is still valid without one), which falls back to a plain resource token.
  const orgId = await currentOrgId();
  return `Bearer ${await getAccessTokenRSC(logtoConfig, RELAY_API_RESOURCE, orgId ?? undefined)}`;
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
  // `content-type` is set ONLY when there is a body to describe. Sending it on a bodyless request
  // (delete a route, revoke a key, suspend an org) makes Fastify try to parse an empty payload as
  // JSON and reject the request before it ever reaches a handler — which is why every bodyless
  // mutation used to fail.
  const hasBody = body !== undefined;
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      authorization: await bearer(),
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
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

/** Advance the org's onboarding state machine to `state`. The gateway requires the target state in
 * the body (it validates the transition), so the caller passes the next step explicitly. */
export function advanceOnboarding(orgId: string, state: OnboardingState): Promise<Org> {
  return apiSend<Org>('POST', `/api/v1/platform/orgs/${orgId}/onboarding/advance`, { state });
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
/** One credential's metadata (never the secret) — the provider detail page. */
export function getProvider(id: string): Promise<Provider> {
  return apiGet<Provider>(`/api/v1/providers/${id}`);
}
export function deleteProvider(id: string): Promise<void> {
  return apiSend<void>('DELETE', `/api/v1/providers/${id}`);
}

// ── Analytics + audit (read model) ───────────────────────────────────────────────────────────────
export function getUsage(params?: UsageQuery): Promise<UsageSummary> {
  return apiGet<UsageSummary>(`/api/v1/analytics/usage${usageQs(params)}`);
}

/** Cross-org spend summary (platform-admin only). Same UsageSummary shape, keyed by org_id. */
export function getPlatformUsage(params?: { from?: string; to?: string }): Promise<UsageSummary> {
  return apiGet<UsageSummary>(`/api/v1/platform/analytics/usage${usageQs(params)}`);
}

/** Query string for the two usage endpoints, shared so the JSON and CSV readers cannot diverge. */
export interface UsageQuery {
  group_by?: 'app' | 'route' | 'model' | 'day';
  from?: string;
  to?: string;
}

function usageQs(params: UsageQuery | undefined, extra?: Record<string, string>): string {
  const qs = new URLSearchParams();
  if (params?.group_by) qs.set('group_by', params.group_by);
  if (params?.from) qs.set('from', params.from);
  if (params?.to) qs.set('to', params.to);
  for (const [key, value] of Object.entries(extra ?? {})) qs.set(key, value);
  return qs.toString() ? `?${qs.toString()}` : '';
}

/** Fetch a usage report as CSV (`format=csv`). Returns the raw body so a route handler can stream it
 * to the browser as a download — the gateway, not the console, owns the CSV shape. */
export async function getUsageCsv(scope: 'org' | 'platform', params?: UsageQuery): Promise<string> {
  const base =
    scope === 'platform' ? '/api/v1/platform/analytics/usage' : '/api/v1/analytics/usage';
  // The cross-org report is always grouped by org — it takes no group_by, so drop it there.
  const query: UsageQuery | undefined =
    scope === 'platform'
      ? {
          ...(params?.from ? { from: params.from } : {}),
          ...(params?.to ? { to: params.to } : {}),
        }
      : params;
  const res = await fetch(`${API_BASE_URL}${base}${usageQs(query, { format: 'csv' })}`, {
    headers: { authorization: await bearer(), accept: 'text/csv' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`usage CSV export failed: ${res.status}`);
  return res.text();
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

// ── Budgets (org-scoped spend ceilings the data plane enforces) ─────────────────────────────────
type BudgetsList =
  paths['/api/v1/budgets']['get']['responses']['200']['content']['application/json'];
export type Budget = NonNullable<BudgetsList['data']>[number];
export type BudgetPeriod = NonNullable<Budget['period']>;
export type SetBudgetInput =
  paths['/api/v1/budgets/{period}']['put']['requestBody']['content']['application/json'];

export function listBudgets(): Promise<BudgetsList> {
  return apiGet<BudgetsList>('/api/v1/budgets');
}
/**
 * Create or replace a ceiling. Idempotent — `(scope, period)` is the resource's key.
 *
 * `appId` null targets the ORG-wide ceiling; an id scopes it to that application. The two are
 * independent and both apply: a request must fit inside its application's ceiling *and* its org's.
 */
export function setBudget(
  appId: string | null,
  period: BudgetPeriod,
  input: SetBudgetInput,
): Promise<Budget> {
  const path = appId ? `/api/v1/apps/${appId}/budgets/${period}` : `/api/v1/budgets/${period}`;
  return apiSend<Budget>('PUT', path, input);
}

/** Remove a ceiling; the data plane stops enforcing that one (others still apply). */
export function deleteBudget(appId: string | null, period: BudgetPeriod): Promise<void> {
  const path = appId ? `/api/v1/apps/${appId}/budgets/${period}` : `/api/v1/budgets/${period}`;
  return apiSend<void>('DELETE', path);
}

// ── Notifications (per-tenant channels, preferences, delivery log) ──────────────────────────────
type ChannelsList =
  paths['/api/v1/notifications/channels']['get']['responses']['200']['content']['application/json'];
export type NotificationChannel = NonNullable<ChannelsList['data']>[number];
export type SetChannelInput =
  paths['/api/v1/notifications/channels/{type}']['put']['requestBody']['content']['application/json'];
export type ChannelTestResult =
  paths['/api/v1/notifications/channels/{type}/test']['post']['responses']['200']['content']['application/json'];
/** The delivery channels a tenant can configure. Email is a mailbox; the other two are webhooks. */
export type ChannelType = 'email_smtp' | 'slack_webhook' | 'msteams_webhook';
type PreferencesList =
  paths['/api/v1/notifications/preferences']['get']['responses']['200']['content']['application/json'];
export type NotificationPreference = NonNullable<PreferencesList['data']>[number];
type NotificationsList =
  paths['/api/v1/notifications']['get']['responses']['200']['content']['application/json'];
export type NotificationEntry = NonNullable<NotificationsList['data']>[number];

/** Every channel the org has configured. Absent kinds simply have no row. */
export function listNotificationChannels(): Promise<ChannelsList> {
  return apiGet<ChannelsList>('/api/v1/notifications/channels');
}
/**
 * Configure one channel. Omit the secret (`password` for SMTP, `webhook_url` for Slack/Teams) to
 * keep the stored one — the gateway never returns it, so the form cannot round-trip it.
 */
export function setNotificationChannel(
  type: ChannelType,
  input: SetChannelInput,
): Promise<NotificationChannel> {
  return apiSend<NotificationChannel>('PUT', `/api/v1/notifications/channels/${type}`, input);
}
export function deleteNotificationChannel(type: ChannelType): Promise<void> {
  return apiSend<void>('DELETE', `/api/v1/notifications/channels/${type}`);
}
/** Send a real message through the channel now, and report what the provider said. */
export function testNotificationChannel(type: ChannelType): Promise<ChannelTestResult> {
  return apiSend<ChannelTestResult>('POST', `/api/v1/notifications/channels/${type}/test`);
}
export function listNotificationPreferences(): Promise<PreferencesList> {
  return apiGet<PreferencesList>('/api/v1/notifications/preferences');
}
export function setNotificationPreference(
  event: string,
  enabled: boolean,
  recipients: string[],
): Promise<NotificationPreference> {
  return apiSend<NotificationPreference>('PUT', `/api/v1/notifications/preferences/${event}`, {
    enabled,
    recipients,
  });
}
export function listNotifications(limit = 50): Promise<NotificationsList> {
  return apiGet<NotificationsList>(`/api/v1/notifications?limit=${limit}`);
}

// ── Org members (platform-admin, via Logto) ────────────────────────────────────────────────────
export function listMembers(orgId: string): Promise<MembersList> {
  return apiGet<MembersList>(`/api/v1/platform/orgs/${orgId}/members`);
}
export function removeMember(orgId: string, userId: string): Promise<void> {
  return apiSend<void>('DELETE', `/api/v1/platform/orgs/${orgId}/members/${userId}`);
}
/**
 * Promote or demote a member. Org administration is granted from OUTSIDE the org (this is a
 * platform-admin endpoint), so a tenant cannot appoint its own first admin or lock its operator out.
 */
export function setMemberRole(
  orgId: string,
  userId: string,
  role: 'admin' | 'member',
): Promise<Member> {
  return apiSend<Member>('PUT', `/api/v1/platform/orgs/${orgId}/members/${userId}/role`, { role });
}

// ── Invitations ─────────────────────────────────────────────────────────────────────────────────
// Two audiences: the first three are tenant administration (platform-admin), the last two are the
// invitee acting on their own invitation — those work for a caller who belongs to no org yet.
export function listInvitations(orgId: string): Promise<InvitationsList> {
  return apiGet<InvitationsList>(`/api/v1/platform/orgs/${orgId}/invitations`);
}
/** Invite an address and send the mail. The gateway 409s a duplicate pending invitation. */
export function inviteMember(
  orgId: string,
  email: string,
  role: 'admin' | 'member' = 'member',
): Promise<Invitation> {
  return apiSend<Invitation>('POST', `/api/v1/platform/orgs/${orgId}/invitations`, { email, role });
}
export function resendInvitation(orgId: string, invitationId: string): Promise<Invitation> {
  return apiSend<Invitation>(
    'POST',
    `/api/v1/platform/orgs/${orgId}/invitations/${invitationId}/resend`,
  );
}
export function revokeInvitation(orgId: string, invitationId: string): Promise<void> {
  return apiSend<void>('DELETE', `/api/v1/platform/orgs/${orgId}/invitations/${invitationId}`);
}
export function getInvitation(invitationId: string): Promise<InvitationOffer> {
  return apiGet<InvitationOffer>(`/api/v1/invitations/${invitationId}`);
}
export function acceptInvitation(invitationId: string): Promise<AcceptedInvitation> {
  return apiSend<AcceptedInvitation>('POST', `/api/v1/invitations/${invitationId}/accept`);
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

// ── Data plane: model discovery + the chat hot path ─────────────────────────────────────────────
// These are the OpenAI-compatible surface, not the control plane. `/v1/models` is unauthenticated by
// design (discovery), so it carries no bearer. `/v1/chat/completions` takes a **virtual key**, which
// the console never holds — the caller supplies one, and the playground route handler forwards it.

/** The gateway's model catalogue. Unauthenticated — deliberately no Logto bearer attached. */
export async function listModels(): Promise<ModelsList> {
  const res = await fetch(`${API_BASE_URL}/v1/models`, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`GET /v1/models failed: ${res.status}`);
  return (await res.json()) as ModelsList;
}

/** The `x-relay-*` response headers the gateway stamps on every proxied completion. Documented in
 * docs/response-headers.md — this is the contract the playground surfaces to the user. */
export interface RelayHeaders {
  traceId: string | null;
  provider: string | null;
  cache: string | null;
  failover: string | null;
  costUsd: string | null;
  modalities: string | null;
}

export interface ChatCompletionResult {
  status: number;
  headers: RelayHeaders;
  latencyMs: number;
  body: unknown;
}

/** Call the data plane with a caller-supplied virtual key and return the response alongside the
 * `x-relay-*` headers. Runs server-side (a route handler): the key never reaches a cross-origin
 * request from the browser, and the gateway needs no CORS allowance for the console. */
export async function chatCompletion(
  virtualKey: string,
  input: ChatCompletionInput,
): Promise<ChatCompletionResult> {
  const startedAt = Date.now();
  const res = await fetch(`${API_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${virtualKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(input),
    cache: 'no-store',
  });
  const latencyMs = Date.now() - startedAt;
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text; // a non-JSON upstream error (e.g. an HTML 502) is still worth showing verbatim
  }
  return {
    status: res.status,
    latencyMs,
    body,
    headers: {
      traceId: res.headers.get('x-relay-trace-id'),
      provider: res.headers.get('x-relay-provider'),
      cache: res.headers.get('x-relay-cache'),
      failover: res.headers.get('x-relay-failover'),
      costUsd: res.headers.get('x-relay-cost-usd'),
      modalities: res.headers.get('x-relay-modalities'),
    },
  };
}

// ── Plans ────────────────────────────────────────────────────────────────────────────────────────

/** This org's effective limits, with provenance and current usage. Renders the plan page. */
export function getPlan(): Promise<EffectivePlan> {
  return apiGet<EffectivePlan>('/api/v1/plan');
}

/**
 * The purchasable catalog.
 *
 * Unauthenticated on the gateway — a price list is public information, and the marketing page renders
 * it with no session — so this deliberately does NOT attach a bearer token. It is also the one call
 * that must not throw: the catalog is empty in the self-hosted edition, and a pricing section that
 * 500s a page because nothing is for sale would be worse than one that renders nothing.
 */
export async function listPlans(): Promise<PlanCatalogEntry[]> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/v1/plans`, { cache: 'no-store' });
    if (!res.ok) return [];
    const body = (await res.json()) as PlanCatalog;
    return body.data ?? [];
  } catch {
    return [];
  }
}

/** Move this org to another public plan. Org-admin only; takes effect on the data plane in ~1s. */
export function changePlan(planCode: string): Promise<Subscription> {
  return apiSend<Subscription>('POST', '/api/v1/plan/change', { plan_code: planCode });
}
