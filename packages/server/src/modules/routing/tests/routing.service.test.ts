import { randomBytes } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { RelayError } from '@relay/shared';
import { sealCredential } from '../../../platform/crypto.js';
import type { Database, Queryable } from '../../../platform/db.js';
import { createRoutingService } from '../services/routing.service.js';
import type { RoutingTargetRow } from '../types/routing.types.js';

const master = randomBytes(32).toString('base64');
const sealed = sealCredential(master, 'sk-real');

function row(over: Partial<RoutingTargetRow> = {}): RoutingTargetRow {
  return {
    route_id: 'route-1',
    route_version_id: 'version-1',
    strategy: 'priority',
    target_id: 'target-1',
    credential_id: 'cred-1',
    provider: 'openai',
    model: 'gpt-4o',
    priority: 100,
    weight: 1,
    base_url: null,
    health_score: 1,
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    auth_tag: sealed.authTag,
    wrapped_dek: sealed.wrappedDek,
    capabilities: { modalities: ['text', 'image'], streaming: true },
    input_usd_per_1k: '0.005',
    output_usd_per_1k: '0.015',
    ...over,
  };
}

function fakeDb(rows: RoutingTargetRow[]): Database {
  return {
    withTenant: async (_orgId, _scope, fn) => fn({ run: async () => rows } as unknown as Queryable),
  } as Database;
}

function countedDb(rows: RoutingTargetRow[]): { db: Database; reads: { count: number } } {
  const reads = { count: 0 };
  return {
    reads,
    db: {
      withTenant: async (_orgId, _scope, fn) => {
        reads.count += 1;
        return fn({ run: async () => rows } as unknown as Queryable);
      },
    } as Database,
  };
}

const visionReq = {
  model: 'gpt-4o',
  messages: [
    {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: 'describe this' },
        { type: 'image_url' as const, image_url: { url: 'https://example.test/a.png' } },
      ],
    },
  ],
};

const textReq = {
  model: 'gpt-4o',
  messages: [{ role: 'user' as const, content: 'hello' }],
};

describe('routing service', () => {
  it('skips incapable targets and opens the selected credential in memory', async () => {
    const service = createRoutingService({
      db: fakeDb([
        row({
          target_id: 'text-only',
          credential_id: 'cred-text',
          capabilities: { modalities: ['text'], streaming: true },
          priority: 1,
        }),
        row({ target_id: 'vision', credential_id: 'cred-vision', priority: 2 }),
      ]),
      masterKey: master,
      fallbackBaseUrl: 'http://mock',
    });

    const targets = await service.selectTargets('org-1', visionReq);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      routeTargetId: 'vision',
      credentialId: 'cred-vision',
      apiKey: 'sk-real',
      baseUrl: 'https://api.openai.com',
      inputUsdPer1k: 0.005,
    });
  });

  it('throws model_capability_mismatch when no active target supports the request', async () => {
    const service = createRoutingService({
      db: fakeDb([row({ capabilities: { modalities: ['text'], streaming: true } })]),
      masterKey: master,
      fallbackBaseUrl: 'http://mock',
    });

    const err = await service.selectTargets('org-1', visionReq).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect(err).toMatchObject({ code: 'model_capability_mismatch' });
  });

  it('orders priority strategy by ascending priority, then health_score', async () => {
    const service = createRoutingService({
      db: fakeDb([
        row({ target_id: 'low-health', priority: 1, health_score: 0.2 }),
        row({ target_id: 'high-health', priority: 1, health_score: 0.9 }),
        row({ target_id: 'secondary', priority: 5, health_score: 1 }),
      ]),
      masterKey: master,
      fallbackBaseUrl: 'http://mock',
    });

    const targets = await service.selectTargets('org-1', textReq);
    expect(targets.map((t) => t.routeTargetId)).toEqual(['high-health', 'low-health', 'secondary']);
  });

  it('throws model_not_found when no active route exists for the model', async () => {
    const service = createRoutingService({
      db: fakeDb([]),
      masterKey: master,
      fallbackBaseUrl: 'http://mock',
    });
    const err = await service.selectTargets('org-1', textReq).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect(err).toMatchObject({ code: 'model_not_found' });
  });

  it('weighted strategy puts the ticket-selected target first but keeps every target for failover', async () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.99); // last ticket → heaviest target
    try {
      const service = createRoutingService({
        db: fakeDb([
          row({ target_id: 'small', strategy: 'weighted', weight: 1, priority: 1 }),
          row({ target_id: 'big', strategy: 'weighted', weight: 9, priority: 2 }),
        ]),
        masterKey: master,
        fallbackBaseUrl: 'http://mock',
      });
      const targets = await service.selectTargets('org-1', textReq);
      expect(targets[0]!.routeTargetId).toBe('big');
      expect(targets).toHaveLength(2); // both retained so failover still works
    } finally {
      spy.mockRestore();
    }
  });

  it('caches active target rows by org and model after the first lookup', async () => {
    const { db, reads } = countedDb([row()]);
    const service = createRoutingService({ db, masterKey: master, fallbackBaseUrl: 'http://mock' });

    await service.selectTargets('org-1', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await service.selectTargets('org-1', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'again' }],
    });

    expect(reads.count).toBe(1);
  });
});
