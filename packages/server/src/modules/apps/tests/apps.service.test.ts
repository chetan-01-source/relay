import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { isRelayError } from '@relay/shared';
import { parseVirtualKey, verifyVirtualKeySecret } from '../../../platform/crypto.js';
import type { Database, Queryable } from '../../../platform/db.js';
import type { EventBus } from '../../../platform/eventbus.js';
import type { AuditEventInput, AuditRepository } from '../../audit/index.js';
import { createAppsService } from '../services/apps.service.js';
import type { ApplicationRow, AppsRepository, VirtualKeyRow } from '../types/apps.types.js';

const master = randomBytes(32).toString('base64');

const fakeDb = {
  withTenant: <T>(_o: string, _s: unknown, fn: (tx: Queryable) => Promise<T>) =>
    fn({} as Queryable),
} as unknown as Database;

function fakeRepo() {
  const apps = new Map<string, ApplicationRow>();
  const keys = new Map<string, VirtualKeyRow>();
  const verifiers = new Map<string, Buffer>(); // key row id → stored verifier (never surfaced)
  let n = 0;
  const now = '2026-07-19T00:00:00Z';

  const repo: AppsRepository = {
    createApp(_tx, orgId, input) {
      const id = `app-${++n}`;
      const row: ApplicationRow = {
        id,
        org_id: orgId,
        name: input.name,
        description: input.description ?? null,
        created_at: now,
      };
      apps.set(id, row);
      return Promise.resolve(row);
    },
    getApp: (_tx, appId) => Promise.resolve(apps.get(appId) ?? null),
    listApps: () => Promise.resolve([...apps.values()]),
    insertKey(_tx, key) {
      const id = `key-${++n}`;
      const row: VirtualKeyRow = {
        id,
        app_id: key.appId,
        key_id: key.keyId,
        last4: key.last4,
        name: key.name,
        environment: key.environment,
        status: 'active',
        successor_id: null,
        grace_until: null,
        created_at: now,
        revoked_at: null,
      };
      keys.set(id, row);
      verifiers.set(id, key.verifier);
      return Promise.resolve(row);
    },
    getKey: (_tx, keyId) => Promise.resolve(keys.get(keyId) ?? null),
    listKeys: (_tx, appId) => Promise.resolve([...keys.values()].filter((k) => k.app_id === appId)),
    revokeKey: (_tx, keyId) => {
      const k = keys.get(keyId)!;
      if (k.status === 'active') {
        k.status = 'revoked';
        k.revoked_at = now;
      }
      return Promise.resolve();
    },
    linkSuccessor: (_tx, predecessorId, successorId, graceUntil) => {
      const k = keys.get(predecessorId)!;
      k.successor_id = successorId;
      k.grace_until = graceUntil;
      return Promise.resolve();
    },
  };
  return { repo, apps, keys, verifiers };
}

function fakeAudit() {
  const events: AuditEventInput[] = [];
  const audit: AuditRepository = {
    appendWithTx: (_tx, orgId, event) => {
      events.push(event);
      return Promise.resolve({
        id: 'a',
        orgId,
        seq: events.length,
        actor: event.actor,
        action: event.action,
        target: event.target ?? null,
        hash: Buffer.alloc(32),
      });
    },
  };
  return { audit, events };
}

function fakeBus() {
  const published: { channel: string; message: string }[] = [];
  const bus = {
    publish: (channel: string, message: string) => {
      published.push({ channel, message });
      return Promise.resolve(1);
    },
  } as unknown as EventBus;
  return { bus, published };
}

function build(repo: AppsRepository, audit: AuditRepository, bus: EventBus | null) {
  return createAppsService({ db: fakeDb, repo, audit, masterKey: master, bus });
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (isRelayError(err)) return err.code;
    throw err;
  }
  throw new Error('expected a RelayError');
}

describe('apps service · key lifecycle', () => {
  let repoBundle: ReturnType<typeof fakeRepo>;
  let auditBundle: ReturnType<typeof fakeAudit>;
  let appId: string;

  beforeEach(async () => {
    repoBundle = fakeRepo();
    auditBundle = fakeAudit();
    const app = await build(repoBundle.repo, auditBundle.audit, null).createApp('u', 'org-1', {
      name: 'App',
    });
    appId = app.id;
  });

  it('issues a key: returns the plaintext once, stores only a verifier, audits it', async () => {
    const svc = build(repoBundle.repo, auditBundle.audit, null);
    const issued = await svc.issueKey('u', 'org-1', appId, {});

    expect(issued.key).toMatch(/^rk_live_/);
    expect(issued.last4).toBe(parseVirtualKey(issued.key)!.secret.slice(-4));
    expect(Object.keys(issued)).not.toContain('key_sha256');

    // the stored verifier actually verifies the returned secret
    const stored = repoBundle.verifiers.get(issued.id)!;
    expect(verifyVirtualKeySecret(master, parseVirtualKey(issued.key)!.secret, stored)).toBe(true);
    expect(auditBundle.events.some((e) => e.action === 'key.issue')).toBe(true);
  });

  it('rejects issuing against an unknown app (404)', async () => {
    const svc = build(repoBundle.repo, auditBundle.audit, null);
    expect(await codeOf(() => svc.issueKey('u', 'org-1', 'nope', {}))).toBe('not_found');
  });

  it('lists keys without any secret material', async () => {
    const svc = build(repoBundle.repo, auditBundle.audit, null);
    await svc.issueKey('u', 'org-1', appId, {});
    const [key] = await svc.listKeys('org-1', appId);
    expect(key!.object).toBe('virtual_key');
    expect(Object.keys(key!)).not.toContain('key');
  });

  it('rotates: mints a successor, links the predecessor + grace, invalidates its snapshot', async () => {
    const { bus, published } = fakeBus();
    const svc = build(repoBundle.repo, auditBundle.audit, bus);
    const original = await svc.issueKey('u', 'org-1', appId, {});

    const successor = await svc.rotateKey('u', 'org-1', original.id);
    expect(successor.id).not.toBe(original.id);
    expect(successor.key).toMatch(/^rk_live_/);

    const pred = repoBundle.keys.get(original.id)!;
    expect(pred.successor_id).toBe(successor.id);
    expect(pred.grace_until).not.toBeNull();
    expect(published.some((p) => p.channel === 'key.invalidate')).toBe(true);
    expect(auditBundle.events.some((e) => e.action === 'key.rotate')).toBe(true);
  });

  it('refuses to rotate a revoked key (400) and 404s an unknown key', async () => {
    const svc = build(repoBundle.repo, auditBundle.audit, null);
    const key = await svc.issueKey('u', 'org-1', appId, {});
    await svc.revokeKey('u', 'org-1', key.id);
    expect(await codeOf(() => svc.rotateKey('u', 'org-1', key.id))).toBe('invalid_request');
    expect(await codeOf(() => svc.rotateKey('u', 'org-1', 'ghost'))).toBe('not_found');
  });

  it('revokes: flips status and publishes key.invalidate', async () => {
    const { bus, published } = fakeBus();
    const svc = build(repoBundle.repo, auditBundle.audit, bus);
    const key = await svc.issueKey('u', 'org-1', appId, {});

    const revoked = await svc.revokeKey('u', 'org-1', key.id);
    expect(revoked.status).toBe('revoked');
    expect(published.some((p) => p.channel === 'key.invalidate')).toBe(true);
    expect(auditBundle.events.some((e) => e.action === 'key.revoke')).toBe(true);
  });
});
