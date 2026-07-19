import { describe, it, expect, beforeEach } from 'vitest';
import { isRelayError } from '@relay/shared';
import type { Database, Queryable } from '../../../platform/db.js';
import type { EventBus } from '../../../platform/eventbus.js';
import type { LogtoOrgSync } from '../../../platform/logto.js';
import type { AuditEventInput, AuditRepository } from '../../audit/index.js';
import { ENTITLEMENT_TEMPLATES } from '../lib/entitlements.js';
import { createTenancyService } from '../services/tenancy.service.js';
import type { OrgRow, TenancyRepository } from '../types/tenancy.types.js';

// ── Fakes ────────────────────────────────────────────────────────────────────
// The service talks only to interfaces, so we drive it with in-memory doubles and assert the
// orchestration: Logto saga + compensation, entitlement seeding, audit, snapshot invalidation.

/** withTenant just runs the callback with a throwaway tx — the fake repo ignores the tx. */
const fakeDb = {
  withTenant: <T>(_org: string, _scope: unknown, fn: (tx: Queryable) => Promise<T>) =>
    fn({} as Queryable),
} as unknown as Database;

function fakeRepo() {
  const orgs = new Map<string, OrgRow>();
  const features = new Map<string, Record<string, unknown>>();
  let n = 0;
  const repo: TenancyRepository = {
    createOrg(_tx, input) {
      const id = `org-${++n}`;
      const now = '2026-07-19T00:00:00Z';
      const row: OrgRow = {
        id,
        logto_org_id: input.logtoOrgId,
        name: input.name,
        status: 'active',
        onboarding_state: 'created',
        created_at: now,
        updated_at: now,
      };
      orgs.set(id, row);
      features.set(id, {});
      return Promise.resolve(row);
    },
    getOrg: (_tx, orgId) => Promise.resolve(orgs.get(orgId) ?? null),
    listOrgs: () => Promise.resolve([...orgs.values()]),
    setStatus: (_tx, orgId, status) => {
      orgs.get(orgId)!.status = status;
      return Promise.resolve();
    },
    setOnboardingState: (_tx, orgId, state) => {
      orgs.get(orgId)!.onboarding_state = state;
      return Promise.resolve();
    },
    upsertFeatures: (_tx, orgId, f) => {
      features.set(orgId, { ...features.get(orgId), ...f });
      return Promise.resolve();
    },
    listFeatures: (_tx, orgId) =>
      Promise.resolve(
        Object.entries(features.get(orgId) ?? {}).map(([feature_key, value]) => ({
          feature_key,
          value,
        })),
      ),
  };
  return { repo, orgs, features };
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

function fakeLogto(overrides: Partial<LogtoOrgSync> = {}) {
  const calls = { created: [] as string[], deleted: [] as string[], invited: [] as string[] };
  const logto: LogtoOrgSync = {
    createOrganization: (name) => {
      calls.created.push(name);
      return Promise.resolve(`logto-${name}`);
    },
    deleteOrganization: (id) => {
      calls.deleted.push(id);
      return Promise.resolve();
    },
    inviteAdmin: (_id, email) => {
      calls.invited.push(email);
      return Promise.resolve('inv-1');
    },
    ...overrides,
  };
  return { logto, calls };
}

function build(opts: {
  repo?: TenancyRepository;
  logto?: LogtoOrgSync | null;
  bus?: EventBus | null;
  audit?: AuditRepository;
}) {
  const repo = opts.repo ?? fakeRepo().repo;
  const audit = opts.audit ?? fakeAudit().audit;
  return createTenancyService({
    db: fakeDb,
    repo,
    audit,
    logto: opts.logto === undefined ? fakeLogto().logto : opts.logto,
    bus: opts.bus === undefined ? fakeBus().bus : opts.bus,
  });
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

describe('tenancy service · onboarding', () => {
  let repoBundle: ReturnType<typeof fakeRepo>;
  let auditBundle: ReturnType<typeof fakeAudit>;

  beforeEach(() => {
    repoBundle = fakeRepo();
    auditBundle = fakeAudit();
  });

  it('creates a Logto org, a row, default entitlements, and an audit event', async () => {
    const { logto, calls } = fakeLogto();
    const svc = build({ repo: repoBundle.repo, audit: auditBundle.audit, logto });

    const org = await svc.onboardOrg('admin-1', { name: 'Acme' });

    expect(org.object).toBe('organization');
    expect(org.onboarding_state).toBe('created');
    expect(calls.created).toEqual(['Acme']);
    expect(repoBundle.features.get(org.id)).toEqual(ENTITLEMENT_TEMPLATES.default);
    expect(auditBundle.events.map((e) => e.action)).toEqual(['org.create']);
  });

  it('invites the admin and advances to admin_invited when an email is given', async () => {
    const { logto, calls } = fakeLogto();
    const svc = build({ repo: repoBundle.repo, audit: auditBundle.audit, logto });

    const org = await svc.onboardOrg('admin-1', { name: 'Beta', adminEmail: 'a@b.co' });

    expect(org.onboarding_state).toBe('admin_invited');
    expect(calls.invited).toEqual(['a@b.co']);
    expect(auditBundle.events.map((e) => e.action)).toEqual(['org.create', 'org.admin_invited']);
  });

  it('applies the requested entitlement template', async () => {
    const svc = build({ repo: repoBundle.repo });
    const org = await svc.onboardOrg('admin-1', { name: 'Gamma', template: 'internal' });
    expect(repoBundle.features.get(org.id)).toEqual(ENTITLEMENT_TEMPLATES.internal);
  });

  it('returns 503 and writes nothing when Logto is not configured', async () => {
    const svc = build({ repo: repoBundle.repo, logto: null });
    expect(await codeOf(() => svc.onboardOrg('admin-1', { name: 'X' }))).toBe(
      'service_unavailable',
    );
    expect(repoBundle.orgs.size).toBe(0);
  });

  it('compensates by deleting the Logto org when the DB write fails', async () => {
    const { logto, calls } = fakeLogto();
    const brokenRepo: TenancyRepository = {
      ...repoBundle.repo,
      createOrg: () => Promise.reject(new Error('db down')),
    };
    const svc = build({ repo: brokenRepo, logto });

    await expect(svc.onboardOrg('admin-1', { name: 'Delta' })).rejects.toThrow('db down');
    expect(calls.deleted).toEqual(['logto-Delta']); // orphan cleaned up
  });

  it('maps a duplicate (unique_violation) to 409 conflict and compensates', async () => {
    const { logto, calls } = fakeLogto();
    const dupRepo: TenancyRepository = {
      ...repoBundle.repo,
      createOrg: () => Promise.reject(Object.assign(new Error('dup'), { code: '23505' })),
    };
    const svc = build({ repo: dupRepo, logto });

    expect(await codeOf(() => svc.onboardOrg('admin-1', { name: 'Dupe' }))).toBe('conflict');
    expect(calls.deleted).toEqual(['logto-Dupe']);
  });
});

describe('tenancy service · lifecycle', () => {
  it('suspend sets status and publishes org.suspend', async () => {
    const { repo } = fakeRepo();
    const { bus, published } = fakeBus();
    const svc = build({ repo, bus });
    const created = await svc.onboardOrg('admin', { name: 'S' });

    const suspended = await svc.suspendOrg('admin', created.id);
    expect(suspended.status).toBe('suspended');
    expect(published.some((p) => p.channel === 'org.suspend')).toBe(true);
  });

  it('unsuspend restores active and re-publishes', async () => {
    const { repo } = fakeRepo();
    const { bus, published } = fakeBus();
    const svc = build({ repo, bus });
    const created = await svc.onboardOrg('admin', { name: 'U' });
    await svc.suspendOrg('admin', created.id);
    const active = await svc.unsuspendOrg('admin', created.id);
    expect(active.status).toBe('active');
    expect(published.filter((p) => p.channel === 'org.suspend')).toHaveLength(2);
  });

  it('suspend on an unknown org is 404', async () => {
    const svc = build({});
    expect(await codeOf(() => svc.suspendOrg('admin', 'nope'))).toBe('not_found');
  });

  it('updateEntitlements merges, publishes org.features.updated, and returns the flags', async () => {
    const { repo } = fakeRepo();
    const { bus, published } = fakeBus();
    const svc = build({ repo, bus });
    const created = await svc.onboardOrg('admin', { name: 'E' });

    const features = await svc.updateEntitlements('admin', created.id, {
      features: { 'modalities.image': true },
    });
    expect(features['modalities.image']).toBe(true);
    expect(published.some((p) => p.channel === 'org.features.updated')).toBe(true);
  });

  it('advanceOnboarding follows the state machine and rejects illegal jumps', async () => {
    const { repo } = fakeRepo();
    const svc = build({ repo });
    const created = await svc.onboardOrg('admin', { name: 'O' });

    const advanced = await svc.advanceOnboarding('admin', created.id, 'admin_invited');
    expect(advanced.onboarding_state).toBe('admin_invited');
    expect(await codeOf(() => svc.advanceOnboarding('admin', created.id, 'first_request'))).toBe(
      'invalid_request',
    );
  });
});
