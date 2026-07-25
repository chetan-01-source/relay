/**
 * Logto Management API client (PRD Day 5 · ADR-7: all Logto calls behind one interface).
 * Idempotent bootstrap of the primitives the gateway needs: the Relay API resource and the base
 * roles. Driven by a Machine-to-Machine app the operator creates once in the Logto Admin Console
 * (grant it "Logto Management API access"), then supplies via RELAY_LOGTO_M2M_APP_ID/SECRET.
 *
 * Kept deliberately small — org sync and richer entitlements land with the identity module (Day 6+).
 */

export interface LogtoConfig {
  endpoint: string;
  m2mAppId: string;
  m2mAppSecret: string;
}

export interface LogtoBootstrapResult {
  apiResourceId: string;
  roleIds: Record<string, string>;
  created: string[]; // human-readable list of things this run created (empty = already up-to-date)
}

// Logto's fixed Management-API resource indicator (self-hosted, default tenant).
const MANAGEMENT_RESOURCE = 'https://default.logto.app/api';
const RELAY_API_INDICATOR = 'https://relay.gateway/api';

// The permission scopes the gateway's requireScope() checks. They must exist on the Relay API
// resource and be granted to a role, or Logto issues no token carrying them (the console then gets
// "token could not be resolved"). relay_admin gets all; relay_member gets everything but platform:admin.
const RELAY_SCOPES = [
  'relay:read',
  'relay:write',
  'apps:read',
  'apps:write',
  'providers:read',
  'providers:write',
  'routes:read',
  'routes:write',
  'analytics:read',
  'audit:read',
  'platform:admin',
] as const;
const MEMBER_SCOPES = RELAY_SCOPES.filter((s) => s !== 'platform:admin');

interface Named {
  id: string;
  name: string;
}

async function getToken(cfg: LogtoConfig): Promise<string> {
  const basic = Buffer.from(`${cfg.m2mAppId}:${cfg.m2mAppSecret}`).toString('base64');
  const res = await fetch(`${cfg.endpoint}/oidc/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      resource: MANAGEMENT_RESOURCE,
      scope: 'all',
    }),
  });
  if (!res.ok) throw new Error(`logto token failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function api<T>(
  cfg: LogtoConfig,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${cfg.endpoint}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`logto ${method} ${path}: ${res.status} ${await res.text()}`);
  return (res.status === 204 ? null : await res.json()) as T;
}

/** Ensure a named resource exists (GET list → find → POST if missing). Returns id + whether created. */
async function ensureByName(
  cfg: LogtoConfig,
  token: string,
  path: string,
  name: string,
  create: Record<string, unknown>,
): Promise<{ id: string; created: boolean }> {
  const existing = await api<Named[]>(cfg, token, 'GET', path);
  const found = existing.find((x) => x.name === name);
  if (found) return { id: found.id, created: false };
  const made = await api<Named>(cfg, token, 'POST', path, create);
  return { id: made.id, created: true };
}

export async function bootstrapLogto(cfg: LogtoConfig): Promise<LogtoBootstrapResult> {
  const token = await getToken(cfg);
  const created: string[] = [];

  // Relay API resource — keyed by its indicator (name may differ)
  const resources = await api<{ id: string; indicator: string }[]>(cfg, token, 'GET', '/resources');
  let apiResourceId = resources.find((r) => r.indicator === RELAY_API_INDICATOR)?.id;
  if (!apiResourceId) {
    const made = await api<Named>(cfg, token, 'POST', '/resources', {
      name: 'Relay Gateway API',
      indicator: RELAY_API_INDICATOR,
    });
    apiResourceId = made.id;
    created.push('resource:Relay Gateway API');
  }

  // Base roles
  const roleIds: Record<string, string> = {};
  const roles: [string, string][] = [
    ['relay_admin', 'Relay platform admin'],
    ['relay_member', 'Relay organization member'],
  ];
  for (const [name, description] of roles) {
    const r = await ensureByName(cfg, token, '/roles', name, { name, description });
    roleIds[name] = r.id;
    if (r.created) created.push(`role:${name}`);
  }

  // Scopes on the Relay API resource — create any missing, keyed by name.
  const existingScopes = await api<Named[]>(
    cfg,
    token,
    'GET',
    `/resources/${apiResourceId}/scopes`,
  );
  const scopeIdByName: Record<string, string> = {};
  for (const s of existingScopes) scopeIdByName[s.name] = s.id;
  for (const name of RELAY_SCOPES) {
    if (!scopeIdByName[name]) {
      const made = await api<Named>(cfg, token, 'POST', `/resources/${apiResourceId}/scopes`, {
        name,
        description: name,
      });
      scopeIdByName[name] = made.id;
      created.push(`scope:${name}`);
    }
  }

  // Grant scopes to roles (only the ones not already granted — keeps the run idempotent).
  async function grantScopes(roleId: string, scopeNames: readonly string[]): Promise<void> {
    const have = await api<Named[]>(cfg, token, 'GET', `/roles/${roleId}/scopes`);
    const haveNames = new Set(have.map((s) => s.name));
    const missing = scopeNames.filter((n) => !haveNames.has(n)).map((n) => scopeIdByName[n]);
    if (missing.length > 0) {
      await api(cfg, token, 'POST', `/roles/${roleId}/scopes`, { scopeIds: missing });
      created.push(`grant:${roleId}(${missing.length})`);
    }
  }
  await grantScopes(roleIds.relay_admin!, RELAY_SCOPES);
  await grantScopes(roleIds.relay_member!, MEMBER_SCOPES);

  return { apiResourceId, roleIds, created };
}

// ── Organization sync (Week 2 Day 7 · tenancy module) ────────────────────────
// Runtime Logto operations the tenancy module performs at onboarding. Kept behind this one interface
// (ADR-7) so no module ever talks to Logto directly; the tenancy service depends on the interface and
// is unit-tested with a fake. Each call fetches a fresh M2M token — onboarding is low-frequency, so a
// per-call token keeps the surface simple and avoids caching an expiring credential.

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** A member of a Logto organization, projected to the fields the console renders. */
export interface OrgMember {
  id: string;
  name: string | null;
  email: string | null;
}

export interface LogtoOrgSync {
  /** Create a Logto organization; returns its id. */
  createOrganization(name: string): Promise<string>;
  /** Delete a Logto organization — used to compensate a failed onboarding transaction. */
  deleteOrganization(orgId: string): Promise<void>;
  /** Invite a user (by email) into the organization. Returns the invitation id. */
  inviteAdmin(orgId: string, email: string): Promise<string>;
  /** List the users currently in the organization. */
  listMembers(orgId: string): Promise<OrgMember[]>;
  /** Invite a user (by email) into the organization — same mechanism as inviteAdmin, named for the
   * members surface. Returns the invitation id. */
  inviteMember(orgId: string, email: string): Promise<string>;
  /** Remove a user from the organization (does not delete the Logto account). */
  removeMember(orgId: string, userId: string): Promise<void>;
}

export function createLogtoOrgSync(cfg: LogtoConfig): LogtoOrgSync {
  return {
    async createOrganization(name) {
      const token = await getToken(cfg);
      const org = await api<Named>(cfg, token, 'POST', '/organizations', { name });
      return org.id;
    },
    async deleteOrganization(orgId) {
      const token = await getToken(cfg);
      await api<null>(cfg, token, 'DELETE', `/organizations/${orgId}`);
    },
    async inviteAdmin(orgId, email) {
      return inviteToOrg(cfg, orgId, email);
    },
    async inviteMember(orgId, email) {
      return inviteToOrg(cfg, orgId, email);
    },
    async listMembers(orgId) {
      const token = await getToken(cfg);
      const users = await api<{ id: string; name?: string | null; primaryEmail?: string | null }[]>(
        cfg,
        token,
        'GET',
        `/organizations/${orgId}/users`,
      );
      return users.map((u) => ({
        id: u.id,
        name: u.name ?? null,
        email: u.primaryEmail ?? null,
      }));
    },
    async removeMember(orgId, userId) {
      const token = await getToken(cfg);
      await api<null>(cfg, token, 'DELETE', `/organizations/${orgId}/users/${userId}`);
    },
  };
}

/** Create an organization invitation for an email. Shared by inviteAdmin + inviteMember. */
async function inviteToOrg(cfg: LogtoConfig, orgId: string, email: string): Promise<string> {
  const token = await getToken(cfg);
  const invitation = await api<{ id: string }>(cfg, token, 'POST', '/organization-invitations', {
    organizationId: orgId,
    invitee: email,
    expiresAt: Date.now() + INVITE_TTL_MS,
  });
  return invitation.id;
}
