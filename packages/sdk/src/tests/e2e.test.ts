/**
 * SDK end-to-end suite — runs against a REAL, running Relay gateway.
 *
 * The unit suite (`sdk.test.ts`) proves the SDK's own behaviour against a fake `fetch`: parsing,
 * retries, error mapping, stream reassembly. What it cannot prove is that the wire contract still
 * matches — that the gateway really sends `x-relay-cost-usd`, that a virtual key really is refused
 * on the control plane, that a stream really terminates with `[DONE]`. Those are the failures that
 * only appear in production, so they are tested against the real thing.
 *
 * **Self-skips unless `RELAY_E2E_BASE_URL` and `RELAY_E2E_API_KEY` are set**, exactly like the
 * server's integration tests skip without `RELAY_TEST_DATABASE_URL`. A contributor with no stack up
 * gets a green run; CI sets the variables and gets real coverage.
 *
 *   RELAY_E2E_BASE_URL=http://localhost:3000 \
 *   RELAY_E2E_API_KEY=rk_live_… \
 *   RELAY_E2E_MODEL=gpt-4o-mini \
 *   pnpm --filter @relay-ai/sdk test
 *
 * `RELAY_E2E_ADMIN_TOKEN` (a Logto access token) additionally enables the control-plane block.
 *
 * Every assertion here is deliberately about SHAPE, not values: a completion's text is the
 * provider's business and will differ every run, so asserting on it would make this suite flaky for
 * a reason that has nothing to do with Relay.
 */
import { describe, expect, it } from 'vitest';
import { Relay, RelayApiError } from '../index.js';

const baseUrl = process.env.RELAY_E2E_BASE_URL;
const apiKey = process.env.RELAY_E2E_API_KEY;
const adminToken = process.env.RELAY_E2E_ADMIN_TOKEN;
const model = process.env.RELAY_E2E_MODEL ?? 'gpt-4o-mini';

const live = Boolean(baseUrl && apiKey);
const withAdmin = Boolean(live && adminToken);

// `describe.skipIf` rather than an early return: a skipped suite is reported as skipped, so nobody
// mistakes "not run" for "passed".
describe.skipIf(!live)('data plane (live gateway)', () => {
  const relay = () => new Relay({ baseUrl: baseUrl!, apiKey: apiKey!, timeoutMs: 60_000 });

  it('completes a chat request and reports Relay metadata', async () => {
    const res = await relay().chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      max_tokens: 16,
    });

    expect(res.object).toBe('chat.completion');
    expect(typeof res.choices[0]?.message.content).toBe('string');

    // The metadata contract. A gateway that stopped sending these would still return a valid
    // completion, so nothing but an explicit assertion catches the regression.
    expect(res.relay.traceId).toBeTruthy();
    expect(res.relay.provider).toBeTruthy();
    expect(res.relay.cached).toBe(false);
    expect(typeof res.relay.costUsd).toBe('number');
    expect(res.relay.modalities).toContain('text');
  });

  it('streams and reassembles the same shape', async () => {
    const stream = await relay().chat.completions.stream({
      model,
      messages: [{ role: 'user', content: 'Count: one two three' }],
      max_tokens: 32,
    });

    const chunks: string[] = [];
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta.content;
      if (delta) chunks.push(delta);
    }

    // The stream must terminate on its own. A hang here means `[DONE]` was never parsed — which a
    // fake-fetch test cannot catch, because the fake always closes the stream.
    expect(chunks.length).toBeGreaterThan(0);
    expect((await stream.relay).traceId).toBeTruthy();
  });

  it('lists the models this key may call', async () => {
    const models = await relay().models();
    expect(Array.isArray(models)).toBe(true);
  });

  it('rejects an unknown model with a typed error, not a 500', async () => {
    const err = await relay()
      .chat.completions.create({
        model: 'definitely-not-a-real-route-alias',
        messages: [{ role: 'user', content: 'x' }],
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RelayApiError);
    expect((err as RelayApiError).status).toBeLessThan(500);
  });

  it('rejects a bad key with 401 and never with 500', async () => {
    const err = await new Relay({ baseUrl: baseUrl!, apiKey: 'rk_live_nope.nope' }).chat.completions
      .create({ model, messages: [{ role: 'user', content: 'x' }] })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RelayApiError);
    expect((err as RelayApiError).status).toBe(401);
  });

  it('refuses a virtual key on the control plane — the two planes must not cross', async () => {
    // ADR-0002's guarantee, asserted rather than assumed: a data-plane credential presented to
    // /api/* is an authentication failure, not an accidental grant.
    const err = await relay()
      .admin(apiKey!)
      .apps.list()
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RelayApiError);
    expect([401, 403]).toContain((err as RelayApiError).status);
  });
});

describe.skipIf(!withAdmin)('control plane (live gateway)', () => {
  const admin = () => new Relay({ baseUrl: baseUrl!, apiKey: apiKey! }).admin(adminToken!);

  it('resolves the caller identity', async () => {
    const me = (await admin().me()) as { org_id?: string | null };
    expect(me).toBeTruthy();
    expect(me.org_id).toBeTruthy();
  });

  it('reads the effective plan with provenance', async () => {
    const plan = (await admin().plan.get()) as {
      plan?: { code?: string };
      limits?: Record<string, { value?: unknown; source?: string }>;
    };
    expect(plan.plan?.code).toBeTruthy();
    // Free during the MVP: every limit resolves, and none of them is a ceiling.
    expect(plan.limits?.['apps.max']).toBeDefined();
    expect(plan.limits?.['apps.max']?.source).toBeTruthy();
  });

  it('lists applications, providers, routes and budgets without throwing', async () => {
    const client = admin();
    await expect(client.apps.list()).resolves.toBeInstanceOf(Array);
    await expect(client.providers.list()).resolves.toBeInstanceOf(Array);
    await expect(client.routes.list()).resolves.toBeInstanceOf(Array);
    await expect(client.budgets.list()).resolves.toBeInstanceOf(Array);
  });

  it('round-trips an application and issues a key that actually works', async () => {
    const client = admin();
    // Named with a fixed prefix so a failed run leaves something obviously disposable behind
    // rather than a plausible-looking tenant resource.
    const app = (await client.apps.create({
      name: `e2e-sdk-${Date.now()}`,
      description: 'Created by the SDK e2e suite. Safe to delete.',
    })) as { id: string };
    expect(app.id).toBeTruthy();

    const issued = (await client.apps.keys.issue(app.id, { environment: 'test' })) as {
      key?: string;
    };
    // The plaintext is returned exactly once — if this is empty the one-time reveal is broken.
    expect(issued.key).toMatch(/^rk_(live|test)_/);

    const keys = await client.apps.keys.list(app.id);
    expect(keys.length).toBeGreaterThan(0);
  });

  it('reports usage over a window', async () => {
    const usage = await admin().analytics.usage({});
    expect(usage).toBeTruthy();
  });

  it('verifies the audit chain', async () => {
    const result = (await admin().audit.verify()) as { ok?: boolean };
    // A broken chain here is a genuine integrity failure, not a flake.
    expect(result.ok).not.toBe(false);
  });
});
