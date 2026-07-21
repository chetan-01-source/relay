import { describe, it, expect, vi } from 'vitest';
import { RelayError } from '@relay/shared';
import type { EventBus } from '../../../platform/eventbus.js';
import { createPolicyService } from '../services/policy.service.js';
import type { VirtualKeySnapshot } from '../../identity/index.js';
import type { CanonicalRequest, Target } from '../../proxy/index.js';

function identity(over: Partial<VirtualKeySnapshot['policy']> = {}): VirtualKeySnapshot {
  return {
    virtualKeyId: 'vk-1',
    keyId: 'kid-1',
    orgId: 'org-1',
    appId: 'app-1',
    environment: 'live',
    orgStatus: 'active',
    keyStatus: 'active',
    graceUntil: null,
    entitlements: {},
    policy: { rateLimit: null, budget: null, ...over },
  };
}

const req: CanonicalRequest = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'hello world' }],
  max_tokens: 100,
};

const target: Target = {
  provider: 'openai',
  model: 'gpt-4o',
  baseUrl: 'https://api.openai.com',
  apiKey: 'sk',
  inputUsdPer1k: 0.005,
  outputUsdPer1k: 0.015,
};

function busReturning(...responses: unknown[]): EventBus {
  return {
    client: {
      script: vi.fn(async () => 'sha'),
      evalsha: vi.fn(async () => responses.shift() ?? [1, 0, 0]),
    },
  } as unknown as EventBus;
}

describe('policy service', () => {
  it('allows requests when Valkey is absent (offline OpenAPI mode)', async () => {
    await expect(createPolicyService().authorize(identity(), req, [target])).resolves.toEqual({
      headers: {},
    });
  });

  it('throws rate_limited when the rpm bucket rejects', async () => {
    const service = createPolicyService({ bus: busReturning([0, 0, 1000]) });
    const err = await service
      .authorize(identity({ rateLimit: { rpm: 1, tpm: null } }), req, [target])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect(err).toMatchObject({ code: 'rate_limited' });
  });

  it('throws rate_limited when the tpm bucket rejects', async () => {
    const service = createPolicyService({ bus: busReturning([1, 59, 0], [0, 0, 30]) });
    const err = await service
      .authorize(identity({ rateLimit: { rpm: 60, tpm: 10 } }), req, [target])
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'rate_limited' });
  });

  it('emits X-RateLimit headers and a reservation on an allowed request', async () => {
    // rpm ok, tpm ok, budget reserve ok
    const service = createPolicyService({ bus: busReturning([1, 59, 0], [1, 900, 0], [1, 10]) });
    const decision = await service.authorize(
      identity({
        rateLimit: { rpm: 60, tpm: 1000 },
        budget: { period: 'monthly', limitUsd: 25, hardCutoff: true },
      }),
      req,
      [target],
    );
    expect(decision.headers['x-ratelimit-limit-requests']).toBe('60');
    expect(decision.headers['x-ratelimit-remaining-requests']).toBe('59');
    expect(decision.headers['x-ratelimit-limit-tokens']).toBe('1000');
    expect(decision.reservation).toMatchObject({ orgId: 'org-1', period: 'monthly' });
  });

  it('settle charges the actual cost against the reservation via the settle script', async () => {
    const evalsha = vi.fn<(...args: unknown[]) => Promise<number[]>>(() =>
      Promise.resolve([1, 0, 0]),
    );
    const bus = { client: { script: vi.fn(async () => 'sha'), evalsha } } as never;
    const service = createPolicyService({ bus });
    const decision = {
      headers: {},
      reservation: {
        orgId: 'org-1',
        period: 'monthly' as const,
        key: 'budget:org-1:monthly',
        reservedMicroUsd: 500,
      },
    };
    await service.settle(decision, target, { inputTokens: 1000, outputTokens: 1000 });
    // last evalsha call is the settle; delta = actual(0.005*1000/1000*1e6 + 0.015*1000/1000*1e6=20000) - 500
    const lastCall = evalsha.mock.calls.at(-1)!;
    expect(lastCall[2]).toBe('budget:org-1:monthly'); // key
    expect(Number(lastCall[3])).toBe(20000 - 500); // delta micro-USD
  });

  it('settle is a no-op when there is no reservation', async () => {
    const evalsha = vi.fn<(...args: unknown[]) => Promise<number[]>>(() => Promise.resolve([1]));
    const bus = { client: { script: vi.fn(async () => 'sha'), evalsha } } as never;
    await createPolicyService({ bus }).settle({ headers: {} }, target, {
      inputTokens: 1,
      outputTokens: 1,
    });
    expect(evalsha).not.toHaveBeenCalled();
  });

  it('throws budget_exceeded when the reserve script rejects', async () => {
    const service = createPolicyService({ bus: busReturning([1, 59, 0], [0, 99]) });
    const err = await service
      .authorize(
        identity({
          rateLimit: { rpm: 60, tpm: null },
          budget: { period: 'monthly', limitUsd: 0.000001, hardCutoff: true },
        }),
        req,
        [target],
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect(err).toMatchObject({ code: 'budget_exceeded' });
  });
});
