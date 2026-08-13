import { describe, it, expect, vi } from 'vitest';
import { RelayError } from '@relay-ai/shared';
import { createPolicyService } from '../services/policy.service.js';
import type { EventBus } from '../../../platform/eventbus.js';
import type { SpendReader } from '../types/policy.types.js';
import type { VirtualKeySnapshot } from '../../identity/index.js';
import type { CanonicalRequest, Target } from '../../proxy/index.js';

/**
 * The counter used to start at zero whenever the key was absent, so spend already made in the period
 * was invisible to enforcement. Observed live: 540 micro-USD actually spent against a 100 micro-USD
 * ceiling, with the counter reading 23 — only the one request made after the budget was created.
 *
 * Creating a budget mid-period therefore granted a free allowance equal to whatever had already been
 * spent, and a Valkey restart did the same thing to an established budget.
 */

const APP = 'a6b6835b-1d0a-4c13-b539-eaaca3494799';

function identity(budgets: VirtualKeySnapshot['policy']['budgets']): VirtualKeySnapshot {
  return {
    virtualKeyId: 'vk-1',
    keyId: 'kid-1',
    orgId: 'org-1',
    appId: APP,
    environment: 'live',
    orgStatus: 'active',
    keyStatus: 'active',
    graceUntil: null,
    entitlements: {},
    planCode: null,
    policy: { rateLimit: null, budgets },
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

const appCeiling = [
  {
    scope: 'app' as const,
    appId: APP,
    period: 'monthly' as const,
    limitUsd: 0.0001,
    hardCutoff: true,
  },
];

/** A Valkey stand-in that runs the reserve contract: EXISTS decides whether the seed is used. */
function fakeValkey(existing: number | null) {
  const state = { value: existing };
  const evalsha = vi.fn(async (_sha: unknown, _n: unknown, _key: unknown, ...args: unknown[]) => {
    const [limit, reserve, hard, , seed] = args.map(Number);
    const current = state.value ?? seed!;
    const next = current + reserve!;
    if (hard === 1 && next > limit!) {
      state.value = current;
      return [0, current];
    }
    state.value = next;
    return [1, next];
  });
  const bus = {
    client: {
      script: vi.fn(async () => 'sha'),
      evalsha,
      exists: vi.fn(async () => (state.value === null ? 0 : 1)),
    },
  } as unknown as EventBus;
  return { bus, evalsha, state };
}

/** Returns the reader plus its call count separately — reading the spy off the object as a method
 * reference trips the unbound-method lint rule. */
function reader(microUsd: number): { spendReader: SpendReader; calls: () => number } {
  const spy = vi.fn(async () => microUsd);
  return { spendReader: { periodSpendMicroUsd: spy }, calls: () => spy.mock.calls.length };
}

describe('budget threshold warning', () => {
  /** Valkey stand-in whose reserve returns a chosen running total, so the ratio is controllable. */
  function valkeyAt(total: number) {
    const evalsha = vi.fn(async (_sha: unknown, _n: unknown, _k: unknown, ...args: unknown[]) => {
      const [limit] = args.map(Number);
      // Allow unless the total is over the limit, mirroring the real script's verdict.
      return total > limit! ? [0, total] : [1, total];
    });
    return {
      client: { script: vi.fn(async () => 'sha'), evalsha, exists: vi.fn(async () => 1) },
    } as unknown as EventBus;
  }

  function alertSpy() {
    const warned: { percent: number }[] = [];
    return {
      sink: {
        budgetThreshold: (i: { percent: number }) => warned.push(i),
        budgetExceeded: () => {},
      },
      warned,
    };
  }

  // limitUsd 1 ⇒ 1_000_000 micro-USD, so the running total IS the percentage × 10_000.
  const ceiling = [
    {
      scope: 'org' as const,
      appId: null,
      period: 'monthly' as const,
      limitUsd: 1,
      hardCutoff: true,
    },
  ];

  it('warns once spend reaches 80% of the ceiling', async () => {
    const { sink, warned } = alertSpy();
    const service = createPolicyService({ bus: valkeyAt(800_000), alerts: sink });
    await service.authorize(identity(ceiling), req, [target]);
    expect(warned).toHaveLength(1);
    expect(warned[0]?.percent).toBe(80);
  });

  it('stays quiet below the mark — a warning at 20% is noise', async () => {
    const { sink, warned } = alertSpy();
    const service = createPolicyService({ bus: valkeyAt(200_000), alerts: sink });
    await service.authorize(identity(ceiling), req, [target]);
    expect(warned).toHaveLength(0);
  });

  it('does not warn once the ceiling is actually exceeded', async () => {
    // Past 100% the breach alert is the correct message; a "you are at 80%" mail would be wrong.
    const { sink, warned } = alertSpy();
    const service = createPolicyService({ bus: valkeyAt(1_200_000), alerts: sink });
    await service.authorize(identity(ceiling), req, [target]).catch(() => null);
    expect(warned).toHaveLength(0);
  });

  it('works with no alert sink wired', async () => {
    const service = createPolicyService({ bus: valkeyAt(900_000) });
    await expect(service.authorize(identity(ceiling), req, [target])).resolves.toBeTruthy();
  });
});

describe('cold budget counter seeding', () => {
  it('rejects when the period has ALREADY exceeded the ceiling before the counter existed', async () => {
    // 540 spent, 100 ceiling — the exact live case. Before seeding this request sailed through.
    const { bus } = fakeValkey(null);
    const service = createPolicyService({ bus, spendReader: reader(540).spendReader });

    const err = await service
      .authorize(identity(appCeiling), req, [target])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect(err).toMatchObject({ code: 'budget_exceeded' });
  });

  it('still admits a request when prior spend leaves room under the ceiling', async () => {
    const { bus } = fakeValkey(null);
    const service = createPolicyService({
      bus,
      spendReader: reader(1).spendReader,
      // ceiling far above the estimate so the reserve fits
    });
    const generous = [{ ...appCeiling[0]!, limitUsd: 100 }];
    await expect(service.authorize(identity(generous), req, [target])).resolves.toMatchObject({
      reservations: expect.any(Array),
    });
  });

  it('does not consult the database once the counter is warm', async () => {
    const { bus } = fakeValkey(50);
    const { spendReader, calls } = reader(999);
    const service = createPolicyService({ bus, spendReader });

    await service
      .authorize(identity([{ ...appCeiling[0]!, limitUsd: 100 }]), req, [target])
      .catch(() => null);
    // A warm key already holds the truth; re-reading Postgres on every request would put a database
    // round trip on the hot path for no benefit.
    expect(calls()).toBe(0);
  });

  it('passes the seed through to the script so the script — not the caller — decides to use it', async () => {
    const { bus, evalsha } = fakeValkey(null);
    const service = createPolicyService({ bus, spendReader: reader(77).spendReader });
    await service.authorize(identity([{ ...appCeiling[0]!, limitUsd: 1000 }]), req, [target]);
    const args = evalsha.mock.calls.at(-1)!;
    expect(Number(args.at(-1))).toBe(77); // seed is the last ARGV
  });

  it('falls back to zero when the spend read fails — a budget must not take the data plane down', async () => {
    const { bus } = fakeValkey(null);
    const failing: SpendReader = {
      periodSpendMicroUsd: vi.fn(async () => {
        throw new Error('postgres unavailable');
      }),
    };
    const service = createPolicyService({ bus, spendReader: failing });
    await expect(
      service.authorize(identity([{ ...appCeiling[0]!, limitUsd: 1000 }]), req, [target]),
    ).resolves.toBeTruthy();
  });

  it('works with no spend reader at all (offline / tests)', async () => {
    const { bus } = fakeValkey(null);
    const service = createPolicyService({ bus });
    await expect(
      service.authorize(identity([{ ...appCeiling[0]!, limitUsd: 1000 }]), req, [target]),
    ).resolves.toBeTruthy();
  });
});
