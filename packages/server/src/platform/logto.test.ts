import { describe, it, expect, vi, afterEach } from 'vitest';
import { bootstrapLogto } from './logto.js';

const cfg = { endpoint: 'http://logto', m2mAppId: 'id', m2mAppSecret: 'secret' };

// The scopes bootstrap ensures on the Relay API resource (must mirror RELAY_SCOPES in logto.ts).
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
];
const MEMBER_SCOPES = RELAY_SCOPES.filter((s) => s !== 'platform:admin');
const asScopes = (names: string[]) => names.map((name) => ({ id: `sc-${name}`, name }));

/** Route a fake fetch by URL+method so we can simulate Logto's list-then-create flow. */
function fakeFetch(handlers: Record<string, () => unknown>) {
  return vi.fn((url: string, init?: { method?: string }) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    const handler = handlers[key] ?? handlers[url];
    if (!handler) throw new Error(`unexpected fetch: ${key}`);
    const value = handler();
    // Headers included because api() reads the content type to decide whether a success carries a
    // JSON body at all — some Logto writes answer 201 with the plain string "Created".
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(value),
    });
  });
}

/** Distinct id per created organization role, so the two are told apart in the assertion. */
function orgRoleFactory() {
  let n = 0;
  return () => ({ id: `orole-${++n}`, name: 'x' });
}

afterEach(() => vi.unstubAllGlobals());

describe('bootstrapLogto', () => {
  it('creates the API resource and roles when none exist', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        'POST http://logto/oidc/token': () => ({ access_token: 'tok' }),
        'GET http://logto/api/resources': () => [],
        'POST http://logto/api/resources': () => ({ id: 'res1', name: 'Relay Gateway API' }),
        'GET http://logto/api/roles': () => [],
        'POST http://logto/api/roles': () => ({ id: 'role1', name: 'x' }),
        // No scopes on the fresh resource/roles yet → bootstrap creates + grants them all.
        'GET http://logto/api/resources/res1/scopes': () => [],
        'POST http://logto/api/resources/res1/scopes': () => ({ id: 'sc-new', name: 'x' }),
        'GET http://logto/api/roles/role1/scopes': () => [],
        'POST http://logto/api/roles/role1/scopes': () => ({}),
        'GET http://logto/api/organization-roles': () => [],
        'POST http://logto/api/organization-roles': orgRoleFactory(),
      }),
    );
    const result = await bootstrapLogto(cfg);
    expect(result.apiResourceId).toBe('res1');
    expect(result.created).toContain('resource:Relay Gateway API');
    expect(result.created).toContain('role:relay_admin');
    expect(result.created).toContain('role:relay_member');
    // The org role an accepted invitation assigns — without it an invitee joins with no scopes.
    expect(result.created).toContain('org-role:relay_org_member');
    expect(result.created).toContain('org-role:relay_org_admin');
    // The machine role, without which no headless service account can hold scopes inside an org.
    expect(result.created).toContain('org-role:relay_org_machine');
    expect(result.orgRoleIds).toEqual({
      relay_org_member: 'orole-1',
      relay_org_admin: 'orole-2',
      relay_org_machine: 'orole-3',
    });
  });

  it('types the machine org role for applications, not users', async () => {
    const fetchMock = fakeFetch({
      'POST http://logto/oidc/token': () => ({ access_token: 'tok' }),
      'GET http://logto/api/resources': () => [
        { id: 'res1', indicator: 'https://relay.gateway/api' },
      ],
      'GET http://logto/api/roles': () => [
        { id: 'r-admin', name: 'relay_admin' },
        { id: 'r-member', name: 'relay_member', isDefault: true },
      ],
      'GET http://logto/api/resources/res1/scopes': () => asScopes(RELAY_SCOPES),
      'GET http://logto/api/roles/r-admin/scopes': () => asScopes(RELAY_SCOPES),
      'GET http://logto/api/roles/r-member/scopes': () => asScopes(MEMBER_SCOPES),
      'GET http://logto/api/organization-roles': () => [
        { id: 'orole1', name: 'relay_org_member' },
        { id: 'orole2', name: 'relay_org_admin' },
      ],
      'PUT http://logto/api/organization-roles/orole1/resource-scopes': () => ({}),
      'PUT http://logto/api/organization-roles/orole2/resource-scopes': () => ({}),
      'POST http://logto/api/organization-roles': orgRoleFactory(),
    });
    vi.stubGlobal('fetch', fetchMock);

    await bootstrapLogto(cfg);

    const create = fetchMock.mock.calls.find(
      ([url, init]) => url === 'http://logto/api/organization-roles' && init?.method === 'POST',
    );
    // Logto refuses to assign a `User`-typed organization role to an application, so getting this
    // wrong would leave the role in place and every service account unable to hold it.
    expect(JSON.parse((create![1] as { body: string }).body)).toMatchObject({
      name: 'relay_org_machine',
      type: 'MachineToMachine',
    });
  });

  it('is idempotent — creates nothing when everything already exists', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        'POST http://logto/oidc/token': () => ({ access_token: 'tok' }),
        'GET http://logto/api/resources': () => [
          { id: 'res1', indicator: 'https://relay.gateway/api' },
        ],
        'GET http://logto/api/roles': () => [
          { id: 'r-admin', name: 'relay_admin' },
          // relay_member is Logto's default role — that is how a fresh account can hold a token for
          // the Relay resource at all, which the invitation-accept endpoint depends on.
          { id: 'r-member', name: 'relay_member', isDefault: true },
        ],
        // Every scope already exists on the resource and is already granted to each role → no writes.
        'GET http://logto/api/resources/res1/scopes': () => asScopes(RELAY_SCOPES),
        'GET http://logto/api/roles/r-admin/scopes': () => asScopes(RELAY_SCOPES),
        'GET http://logto/api/roles/r-member/scopes': () => asScopes(MEMBER_SCOPES),
        'GET http://logto/api/organization-roles': () => [
          { id: 'orole1', name: 'relay_org_member' },
          { id: 'orole2', name: 'relay_org_admin' },
          { id: 'orole3', name: 'relay_org_machine' },
        ],
        // Re-syncing each org role's resource scopes is a PUT (replace) — idempotent, always runs.
        'PUT http://logto/api/organization-roles/orole1/resource-scopes': () => ({}),
        'PUT http://logto/api/organization-roles/orole2/resource-scopes': () => ({}),
        'PUT http://logto/api/organization-roles/orole3/resource-scopes': () => ({}),
      }),
    );
    const result = await bootstrapLogto(cfg);
    expect(result.apiResourceId).toBe('res1');
    expect(result.roleIds).toEqual({ relay_admin: 'r-admin', relay_member: 'r-member' });
    expect(result.orgRoleIds).toEqual({
      relay_org_member: 'orole1',
      relay_org_admin: 'orole2',
      relay_org_machine: 'orole3',
    });
    expect(result.created).toEqual([]); // nothing created on re-run
  });

  it('promotes relay_member to Logto’s default role when a prior run left it unset', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        'POST http://logto/oidc/token': () => ({ access_token: 'tok' }),
        'GET http://logto/api/resources': () => [
          { id: 'res1', indicator: 'https://relay.gateway/api' },
        ],
        'GET http://logto/api/roles': () => [
          { id: 'r-admin', name: 'relay_admin' },
          { id: 'r-member', name: 'relay_member', isDefault: false },
        ],
        'PATCH http://logto/api/roles/r-member': () => ({}),
        'GET http://logto/api/resources/res1/scopes': () => asScopes(RELAY_SCOPES),
        'GET http://logto/api/roles/r-admin/scopes': () => asScopes(RELAY_SCOPES),
        'GET http://logto/api/roles/r-member/scopes': () => asScopes(MEMBER_SCOPES),
        'GET http://logto/api/organization-roles': () => [
          { id: 'orole1', name: 'relay_org_member' },
          { id: 'orole2', name: 'relay_org_admin' },
          { id: 'orole3', name: 'relay_org_machine' },
        ],
        'PUT http://logto/api/organization-roles/orole1/resource-scopes': () => ({}),
        'PUT http://logto/api/organization-roles/orole2/resource-scopes': () => ({}),
        'PUT http://logto/api/organization-roles/orole3/resource-scopes': () => ({}),
      }),
    );
    const result = await bootstrapLogto(cfg);
    expect(result.created).toEqual(['role:relay_member(isDefault=true)']);
  });

  it('throws a clear error when the token request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({ ok: false, status: 401, text: () => Promise.resolve('bad creds') }),
      ),
    );
    await expect(bootstrapLogto(cfg)).rejects.toThrow(/logto token failed: 401/);
  });
});
