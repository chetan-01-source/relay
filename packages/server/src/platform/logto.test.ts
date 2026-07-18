import { describe, it, expect, vi, afterEach } from 'vitest';
import { bootstrapLogto } from './logto.js';

const cfg = { endpoint: 'http://logto', m2mAppId: 'id', m2mAppSecret: 'secret' };

/** Route a fake fetch by URL+method so we can simulate Logto's list-then-create flow. */
function fakeFetch(handlers: Record<string, () => unknown>) {
  return vi.fn((url: string, init?: { method?: string }) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    const handler = handlers[key] ?? handlers[url];
    if (!handler) throw new Error(`unexpected fetch: ${key}`);
    const value = handler();
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(value) });
  });
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
      }),
    );
    const result = await bootstrapLogto(cfg);
    expect(result.apiResourceId).toBe('res1');
    expect(result.created).toContain('resource:Relay Gateway API');
    expect(result.created).toContain('role:relay_admin');
    expect(result.created).toContain('role:relay_member');
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
          { id: 'r-member', name: 'relay_member' },
        ],
      }),
    );
    const result = await bootstrapLogto(cfg);
    expect(result.apiResourceId).toBe('res1');
    expect(result.roleIds).toEqual({ relay_admin: 'r-admin', relay_member: 'r-member' });
    expect(result.created).toEqual([]); // nothing created on re-run
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
