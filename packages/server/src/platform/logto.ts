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
  orgRoleIds: Record<string, string>; // organization roles (assigned when an invitation is accepted)
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
  'budgets:read',
  'budgets:write',
  'notifications:read',
  'notifications:write',
  'analytics:read',
  'audit:read',
  'platform:admin',
] as const;
const MEMBER_SCOPES = RELAY_SCOPES.filter((s) => s !== 'platform:admin');

/**
 * The ORGANIZATION role an invited member receives when they accept. Organization roles are a
 * separate namespace from the tenant-level roles above — they carry API-resource scopes that apply
 * *within* one organization, which is what an org-scoped grant needs. It deliberately excludes
 * `platform:admin`: joining a tenant must never make somebody an operator of the platform.
 */
const ORG_MEMBER_ROLE = 'relay_org_member';

/**
 * The ORGANIZATION role for a tenant's administrators. It carries the same API-resource scopes as
 * the member role — what an admin may additionally do (move budgets, store provider credentials) is
 * enforced by Relay against `org_members`, not by a Logto scope. This role exists so the INVITATION
 * can carry the intended role across the accept round trip, which is the only place Logto is in the
 * loop. It still excludes `platform:admin`: administering a tenant is not operating the platform.
 */
const ORG_ADMIN_ROLE = 'relay_org_admin';

/**
 * The ORGANIZATION role a headless service account holds inside one tenant. Logto types organization
 * roles by principal, and a role of type `User` cannot be assigned to an application at all — so
 * without this role there is no way for a machine to hold control-plane scopes within an org, and
 * every non-interactive integration is forced to either drive a browser or hold a human's token.
 *
 * It carries the member scope set, and the same reasoning applies as for the two roles above:
 * `platform:admin` is excluded, and whether this principal may move budgets or swap provider
 * credentials is decided by Relay's own `org_members` table, not by anything Logto can assert.
 */
const ORG_MACHINE_ROLE = 'relay_org_machine';

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

/**
 * A failed Logto Management API call, carrying enough to react to it.
 *
 * The status and Logto's own error code are kept as fields rather than flattened into the message:
 * a caller has to be able to tell "the caller asked for something impossible" (a duplicate invite)
 * from "our integration is broken", and string-matching a message to decide that is not a contract.
 * Previously this threw a bare Error, so every Logto rejection — including ones the user caused —
 * surfaced as a generic 500.
 */
export class LogtoApiError extends Error {
  readonly status: number;
  /** Logto's machine-readable code, e.g. `entity.unique_integrity_violation`. */
  readonly logtoCode: string | undefined;

  constructor(method: string, path: string, status: number, bodyText: string) {
    super(`logto ${method} ${path}: ${status} ${bodyText}`);
    this.name = 'LogtoApiError';
    this.status = status;
    let code: string | undefined;
    try {
      code = (JSON.parse(bodyText) as { code?: string }).code;
    } catch {
      code = undefined; // non-JSON body (a proxy error page); the status still classifies it
    }
    this.logtoCode = code;
  }
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
  if (!res.ok) throw new LogtoApiError(method, path, res.status, await res.text());
  // Not every success carries JSON. 204 has no body at all, and some Logto writes answer 201 with
  // the plain string "Created" — parsing that as JSON throws on a call that actually succeeded, so
  // the content type decides rather than the status alone.
  const isJson = res.headers.get('content-type')?.includes('application/json') ?? false;
  return (res.status === 204 || !isJson ? null : await res.json()) as T;
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

  // Base roles. `relay_member` is Logto's DEFAULT role: every user who signs up receives it, and
  // therefore receives an access token the gateway can verify for the Relay API resource. Without a
  // default role a brand-new account holds no scope on the resource, Logto refuses to mint a token
  // for it ("token could not be resolved"), and the invitee could not even call the endpoint that
  // accepts their organization invitation. Membership — not this role — is what grants access to a
  // tenant's data: `relay_member` carries no `platform:admin`, and every org-scoped route rejects a
  // token whose `organization_id` is absent.
  const roleIds: Record<string, string> = {};
  const orgRoleIds: Record<string, string> = {};
  const roles: [string, string, boolean][] = [
    ['relay_admin', 'Relay platform admin', false],
    ['relay_member', 'Relay organization member', true],
  ];
  const existingRoles = await api<(Named & { isDefault?: boolean })[]>(cfg, token, 'GET', '/roles');
  for (const [name, description, isDefault] of roles) {
    const found = existingRoles.find((r) => r.name === name);
    if (!found) {
      const made = await api<Named>(cfg, token, 'POST', '/roles', { name, description, isDefault });
      roleIds[name] = made.id;
      created.push(`role:${name}`);
      continue;
    }
    roleIds[name] = found.id;
    if (Boolean(found.isDefault) !== isDefault) {
      await api(cfg, token, 'PATCH', `/roles/${found.id}`, { isDefault });
      created.push(`role:${name}(isDefault=${isDefault})`);
    }
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

  // The organization role invitations assign on acceptance. Its resource scopes are kept in sync on
  // every run (PUT replaces the set) so adding a scope to MEMBER_SCOPES reaches existing deployments.
  const memberScopeIds = MEMBER_SCOPES.map((n) => scopeIdByName[n]!);
  const orgRoles = await api<Named[]>(cfg, token, 'GET', '/organization-roles');
  for (const [name, description, type] of [
    [ORG_MEMBER_ROLE, 'Relay member of one organization', 'User'],
    [ORG_ADMIN_ROLE, 'Relay administrator of one organization', 'User'],
    [ORG_MACHINE_ROLE, 'Relay service account inside one organization', 'MachineToMachine'],
  ] as const) {
    const existingOrgRole = orgRoles.find((r) => r.name === name);
    if (existingOrgRole) {
      orgRoleIds[name] = existingOrgRole.id;
      await api(cfg, token, 'PUT', `/organization-roles/${existingOrgRole.id}/resource-scopes`, {
        scopeIds: memberScopeIds,
      });
    } else {
      const made = await api<Named>(cfg, token, 'POST', '/organization-roles', {
        name,
        description,
        type,
        organizationScopeIds: [],
        resourceScopeIds: memberScopeIds,
      });
      orgRoleIds[name] = made.id;
      created.push(`org-role:${name}`);
    }
  }

  return { apiResourceId, roleIds, orgRoleIds, created };
}

export interface MachineAppRequest {
  /** Display name in Logto. Also the idempotency key — re-running returns the same application. */
  name: string;
  /** The Logto organization id this service account acts within. */
  organizationId: string;
}

export interface MachineAppResult {
  clientId: string;
  /** The client secret. Readable from Logto on every run, so re-running re-prints it. */
  clientSecret: string;
  /** True when this run created the application rather than finding an existing one. */
  createdNow: boolean;
}

/**
 * Provision a machine-to-machine application and make it a member of one organization — the
 * non-interactive half of the control plane.
 *
 * The gateway resolves a caller's tenant from the token's `organization_id` claim, and Logto emits
 * that claim only for a client that is a MEMBER of the organization it names. So a service account
 * is two facts, not one: an application exists, and it belongs to a tenant with a role. Creating the
 * app alone yields credentials that mint tokens the gateway will reject as tenant-less — the failure
 * looks like a broken token and is really a missing membership.
 *
 * Idempotent throughout: the application is looked up by name, adding an existing member is a no-op
 * to Logto, and roles are PUT (replace) rather than POST (append), so re-running converges instead
 * of accumulating.
 */
export async function provisionMachineApp(
  cfg: LogtoConfig,
  request: MachineAppRequest,
): Promise<MachineAppResult> {
  const token = await getToken(cfg);

  interface RawApp {
    id: string;
    name: string;
    type: string;
    secret: string;
  }
  const apps = await api<RawApp[]>(cfg, token, 'GET', '/applications');
  const existing = apps.find((a) => a.name === request.name && a.type === 'MachineToMachine');

  const app =
    existing ??
    (await api<RawApp>(cfg, token, 'POST', '/applications', {
      name: request.name,
      type: 'MachineToMachine',
      description: 'Relay control-plane service account',
    }));

  // Membership first, then the role: Logto rejects a role assignment for a principal that is not
  // yet a member, so the order here is a requirement rather than a preference.
  await api<null>(cfg, token, 'POST', `/organizations/${request.organizationId}/applications`, {
    applicationIds: [app.id],
  });

  const orgRoles = await api<Named[]>(cfg, token, 'GET', '/organization-roles');
  const machineRole = orgRoles.find((r) => r.name === ORG_MACHINE_ROLE);
  if (!machineRole) {
    throw new Error(
      `Logto has no "${ORG_MACHINE_ROLE}" organization role — run seed-auth first to create it.`,
    );
  }
  await api<null>(
    cfg,
    token,
    'PUT',
    `/organizations/${request.organizationId}/applications/${app.id}/roles`,
    { organizationRoleIds: [machineRole.id] },
  );

  return { clientId: app.id, clientSecret: app.secret, createdNow: !existing };
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

/** A Logto organization invitation, projected to the fields Relay surfaces. */
export interface OrgInvitation {
  id: string;
  organizationId: string;
  invitee: string;
  status: 'Pending' | 'Accepted' | 'Expired' | 'Revoked';
  createdAt: number;
  expiresAt: number;
  /**
   * The role the invitee will hold once they accept. Carried ON the invitation because that is the
   * only durable place it can live between "an admin decided" and "the person accepted" — Relay has
   * no row of its own until the membership exists.
   */
  role: OrgMemberRole;
}

/** Role within one organization, as Relay enforces it. */
export type OrgMemberRole = 'admin' | 'member';

/** A Logto account, as much of it as the invitation flow needs. */
export interface LogtoUser {
  id: string;
  primaryEmail: string | null;
  name: string | null;
}

export interface LogtoOrgSync {
  /** Create a Logto organization; returns its id. */
  createOrganization(name: string): Promise<string>;
  /** Delete a Logto organization — used to compensate a failed onboarding transaction. */
  deleteOrganization(orgId: string): Promise<void>;
  /** List the users currently in the organization. */
  listMembers(orgId: string): Promise<OrgMember[]>;
  /** Remove a user from the organization (does not delete the Logto account). */
  removeMember(orgId: string, userId: string): Promise<void>;

  // ── Invitations ───────────────────────────────────────────────────────────────────────────────
  /**
   * Record an invitation for an email address. Sends NOTHING on its own — the acceptance link has to
   * carry the invitation id, and Logto only assigns that id here. The caller follows with
   * `sendInvitationMail(id, …)`, which is the same operation a "resend" performs.
   */
  createInvitation(orgId: string, email: string, role: OrgMemberRole): Promise<OrgInvitation>;
  /** Pending + historical invitations for one organization. */
  listInvitations(orgId: string): Promise<OrgInvitation[]>;
  /** One invitation by id, or null when it does not exist. */
  getInvitation(invitationId: string): Promise<OrgInvitation | null>;
  /**
   * Mail the invitation, pointing at `acceptUrl`. Logto renders it with the `OrganizationInvitation`
   * template through the configured email connector — with neither of those set up, no mail leaves
   * the building no matter what Relay does.
   */
  sendInvitationMail(invitationId: string, acceptUrl: string): Promise<void>;
  /** Revoke a pending invitation so the address can be invited again. */
  revokeInvitation(invitationId: string): Promise<void>;
  /** Mark an invitation accepted by `userId` — this is what actually creates the membership. */
  acceptInvitation(invitationId: string, userId: string): Promise<void>;
  /** Read one Logto account (used to verify the acceptor owns the invited address). */
  getUser(userId: string): Promise<LogtoUser | null>;
}

/** Logto's own invitation payload; mapped to `OrgInvitation` so callers never see extra fields. */
interface RawInvitation {
  id: string;
  organizationId: string;
  invitee: string;
  status: OrgInvitation['status'];
  createdAt: number;
  expiresAt: number;
  organizationRoles?: { id: string; name: string }[];
}

function toInvitation(raw: RawInvitation): OrgInvitation {
  return {
    id: raw.id,
    organizationId: raw.organizationId,
    invitee: raw.invitee,
    status: raw.status,
    createdAt: raw.createdAt,
    expiresAt: raw.expiresAt,
    // Anything that is not explicitly the admin role is a member. An invitation issued before this
    // feature existed carries no roles at all and must not be read as conferring administration.
    role: raw.organizationRoles?.some((r) => r.name === ORG_ADMIN_ROLE) ? 'admin' : 'member',
  };
}

export function createLogtoOrgSync(cfg: LogtoConfig): LogtoOrgSync {
  /**
   * The organization role assigned on acceptance, resolved by name and memoised for the process.
   * Bootstrap creates it; a deployment that has not re-run bootstrap simply gets an invitation with
   * no role rather than a failed invite, so upgrading never breaks inviting.
   */
  let orgRoleIdByName: Record<string, string> | undefined;
  async function roleIdsFor(token: string, role: OrgMemberRole): Promise<string[]> {
    if (!orgRoleIdByName) {
      const roles = await api<Named[]>(cfg, token, 'GET', '/organization-roles');
      orgRoleIdByName = Object.fromEntries(roles.map((r) => [r.name, r.id]));
    }
    const id = orgRoleIdByName[role === 'admin' ? ORG_ADMIN_ROLE : ORG_MEMBER_ROLE];
    return id ? [id] : [];
  }

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
    async createInvitation(orgId, email, role) {
      const token = await getToken(cfg);
      const raw = await api<RawInvitation>(cfg, token, 'POST', '/organization-invitations', {
        organizationId: orgId,
        invitee: email,
        expiresAt: Date.now() + INVITE_TTL_MS,
        organizationRoleIds: await roleIdsFor(token, role),
        messagePayload: false, // mailed separately — the link needs the id Logto assigns right here
      });
      return toInvitation(raw);
    },
    async listInvitations(orgId) {
      const token = await getToken(cfg);
      const raw = await api<RawInvitation[]>(
        cfg,
        token,
        'GET',
        `/organization-invitations?organizationId=${encodeURIComponent(orgId)}`,
      );
      return raw.map(toInvitation);
    },
    async getInvitation(invitationId) {
      const token = await getToken(cfg);
      try {
        const raw = await api<RawInvitation>(
          cfg,
          token,
          'GET',
          `/organization-invitations/${invitationId}`,
        );
        return toInvitation(raw);
      } catch (err) {
        if (err instanceof LogtoApiError && err.status === 404) return null;
        throw err;
      }
    },
    async sendInvitationMail(invitationId, acceptUrl) {
      const token = await getToken(cfg);
      await api<null>(cfg, token, 'POST', `/organization-invitations/${invitationId}/message`, {
        link: acceptUrl,
      });
    },
    async revokeInvitation(invitationId) {
      const token = await getToken(cfg);
      await api<null>(cfg, token, 'DELETE', `/organization-invitations/${invitationId}`);
    },
    async acceptInvitation(invitationId, userId) {
      const token = await getToken(cfg);
      await api<RawInvitation>(
        cfg,
        token,
        'PUT',
        `/organization-invitations/${invitationId}/status`,
        { status: 'Accepted', acceptedUserId: userId },
      );
    },
    async getUser(userId) {
      const token = await getToken(cfg);
      try {
        const user = await api<{ id: string; primaryEmail?: string | null; name?: string | null }>(
          cfg,
          token,
          'GET',
          `/users/${userId}`,
        );
        return { id: user.id, primaryEmail: user.primaryEmail ?? null, name: user.name ?? null };
      } catch (err) {
        if (err instanceof LogtoApiError && err.status === 404) return null;
        throw err;
      }
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
