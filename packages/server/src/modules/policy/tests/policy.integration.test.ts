/**
 * Policy integration (Week 2 Day 10, DEVELOPMENT.md §5) — runs the ACTUAL Lua scripts against a real
 * Valkey. The unit test mocks evalsha, so it cannot prove the token-bucket / reserve / settle logic
 * that lives inside the Lua. This suite does: it exercises Valkey as the source of truth so the
 * hard-cutoff, alert-only, and refund semantics are verified end-to-end.
 *
 * Self-skips unless a real Valkey URL is supplied (mirrors the DB integration suites):
 *   RELAY_VALKEY_URL = redis://localhost:6379
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayError } from '@relay/shared';
import { createEventBus, type EventBus } from '../../../platform/eventbus.js';
import { createPolicyService } from '../services/policy.service.js';
import type { PolicySnapshot } from '../types/policy.types.js';

const valkeyUrl = process.env.RELAY_VALKEY_URL;

const req = { model: 'gpt-4o', messages: [{ content: 'hello world' }], max_tokens: 100 };
const target = { inputUsdPer1k: 0.005, outputUsdPer1k: 0.015 };

function snapshot(policy: PolicySnapshot['policy']): PolicySnapshot {
  return { orgId: `it-${randomUUID()}`, keyId: randomUUID(), policy };
}

describe.skipIf(!valkeyUrl)('policy integration (real Valkey Lua)', () => {
  let bus: EventBus;

  beforeAll(async () => {
    bus = createEventBus(valkeyUrl!);
    await bus.client.connect();
  });
  afterAll(async () => {
    await bus.close();
  });

  it('enforces the rpm token bucket: allows up to capacity, then 429s', async () => {
    const service = createPolicyService({ bus });
    const identity = snapshot({ rateLimit: { rpm: 2, tpm: null }, budget: null });

    await expect(service.authorize(identity, req, [target])).resolves.toBeTruthy();
    await expect(service.authorize(identity, req, [target])).resolves.toBeTruthy();
    const err = await service.authorize(identity, req, [target]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect(err).toMatchObject({ code: 'rate_limited' });
  });

  it('hard-cutoff budget rejects once the reserve would exceed the limit', async () => {
    const service = createPolicyService({ bus });
    // limit $0.000001 is far below the reserve estimate → the very first request is rejected.
    const identity = snapshot({
      rateLimit: null,
      budget: { period: 'daily', limitUsd: 0.000001, hardCutoff: true },
    });
    const err = await service.authorize(identity, req, [target]).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'budget_exceeded' });
  });

  it('alert-only budget (hardCutoff=false) never rejects, even over the limit', async () => {
    const service = createPolicyService({ bus });
    const identity = snapshot({
      rateLimit: null,
      budget: { period: 'daily', limitUsd: 0.000001, hardCutoff: false },
    });
    const decision = await service.authorize(identity, req, [target]);
    expect(decision.reservation).toBeTruthy(); // reserved but allowed through
  });

  it('settle refunds the difference between the reserve estimate and the actual cost', async () => {
    const service = createPolicyService({ bus });
    const identity = snapshot({
      rateLimit: null,
      budget: { period: 'daily', limitUsd: 1000, hardCutoff: true },
    });
    const decision = await service.authorize(identity, req, [target]);
    const key = decision.reservation!.key;
    const afterReserve = Number(await bus.client.get(key));
    expect(afterReserve).toBe(decision.reservation!.reservedMicroUsd);

    // Actual usage is zero tokens → settle should drive the counter back down toward 0.
    await service.settle(decision, target, { inputTokens: 0, outputTokens: 0 });
    const afterSettle = Number(await bus.client.get(key));
    expect(afterSettle).toBe(0);
  });
});
