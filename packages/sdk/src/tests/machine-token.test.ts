/**
 * Client-credentials token source. Tested against a fake `fetch` like the rest of the SDK: what
 * matters is the grant we put on the wire and how the cache behaves around it.
 */
import { describe, expect, it, vi } from 'vitest';
import { Relay, machineTokenSource, RelayTokenError, RelayConnectionError } from '../index.js';

const LOGTO = 'https://auth.test';
const OPTIONS = {
  endpoint: LOGTO,
  clientId: 'client-1',
  clientSecret: 'secret-1',
  organizationId: 'org-abc',
};

function tokenResponse(token: string, expiresIn = 3600): Response {
  return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('machineTokenSource', () => {
  it('posts a client-credentials grant with Basic auth, the org and the resource', async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse('tok-1'));
    const source = machineTokenSource({ ...OPTIONS, fetch: fetchMock });

    expect(await source()).toBe('tok-1');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${LOGTO}/oidc/token`);
    expect(init.method).toBe('POST');
    // The secret rides in the Authorization header, never the body.
    expect(init.headers.authorization).toBe(`Basic ${btoa('client-1:secret-1')}`);
    const body = new URLSearchParams(init.body as URLSearchParams);
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('organization_id')).toBe('org-abc');
    expect(body.get('resource')).toBe('https://relay.gateway/api');
    expect(body.get('scope')).toContain('apps:write');
  });

  it('caches the token instead of minting one per call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse('tok-1'));
    const source = machineTokenSource({ ...OPTIONS, fetch: fetchMock });

    await source();
    await source();
    await source();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-mints once the token is inside the refresh skew', async () => {
    // 30s of life against a 60s skew: already due for replacement when it arrives.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse('tok-1', 30))
      .mockResolvedValueOnce(tokenResponse('tok-2', 3600));
    const source = machineTokenSource({ ...OPTIONS, fetch: fetchMock });

    expect(await source()).toBe('tok-1');
    expect(await source()).toBe('tok-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent first calls into one grant', async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse('tok-1'));
    const source = machineTokenSource({ ...OPTIONS, fetch: fetchMock });

    const tokens = await Promise.all([source(), source(), source(), source()]);

    expect(tokens).toEqual(['tok-1', 'tok-1', 'tok-1', 'tok-1']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('recovers after a failed mint rather than caching the failure forever', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('nope', { status: 401 }))
      .mockResolvedValueOnce(tokenResponse('tok-1'));
    const source = machineTokenSource({ ...OPTIONS, fetch: fetchMock });

    await expect(source()).rejects.toBeInstanceOf(RelayTokenError);
    expect(await source()).toBe('tok-1');
  });

  it('reports an unreachable Logto as a connection error, not a token error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const source = machineTokenSource({ ...OPTIONS, fetch: fetchMock });

    await expect(source()).rejects.toBeInstanceOf(RelayConnectionError);
  });
});

describe('admin(tokenSource)', () => {
  it('attaches the minted token and refreshes without rebuilding the client', async () => {
    let minted = 0;
    const source = () => Promise.resolve(`tok-${++minted}`);
    // A fresh Response per call — a body can only be read once, so a shared instance would fail the
    // second request for a reason that has nothing to do with the token.
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ object: 'list', data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const admin = new Relay({
      baseUrl: 'https://relay.test',
      apiKey: 'rk_live_a.b',
      fetch: fetchMock,
    }).admin(source);

    await admin.apps.list();
    await admin.apps.list();

    expect(fetchMock.mock.calls[0]![1].headers.authorization).toBe('Bearer tok-1');
    expect(fetchMock.mock.calls[1]![1].headers.authorization).toBe('Bearer tok-2');
  });

  it('still accepts a plain token string', async () => {
    // A fresh Response per call — a body can only be read once, so a shared instance would fail the
    // second request for a reason that has nothing to do with the token.
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ object: 'list', data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const admin = new Relay({
      baseUrl: 'https://relay.test',
      apiKey: 'rk_live_a.b',
      fetch: fetchMock,
    }).admin('static-token');

    await admin.apps.list();

    expect(fetchMock.mock.calls[0]![1].headers.authorization).toBe('Bearer static-token');
  });
});
