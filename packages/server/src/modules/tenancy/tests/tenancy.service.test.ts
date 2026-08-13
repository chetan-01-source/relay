import { describe, it, expect, beforeEach } from 'vitest';
import { isRelayError } from '@relay-ai/shared';
import type { Database, Queryable } from '../../../platform/db.js';
import type { EventBus } from '../../../platform/eventbus.js';
import {
  LogtoApiError,
  type LogtoOrgSync,
  type LogtoUser,
  type OrgInvitation,
} from '../../../platform/logto.js';
import type { AuditEventInput, AuditRepository } from '../../audit/index.js';
import { ENTITLEMENT_TEMPLATES } from '../lib/entitlements.js';
import { createTenancyService } from '../services/tenancy.service.js';
import type { OrgMemberRow, OrgRow, TenancyRepository } from '../types/tenancy.types.js';

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
  const members = new Map<string, OrgMemberRow>();
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
    getOrgByLogtoId: (_tx, logtoOrgId) =>
      Promise.resolve([...orgs.values()].find((o) => o.logto_org_id === logtoOrgId) ?? null),
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
    upsertOrgMember: (_tx, orgId, input) => {
      members.set(`${orgId}:${input.userId}`, {
        user_id: input.userId,
        role: input.role,
        email: input.email,
      });
      return Promise.resolve();
    },
    listOrgMembers: (_tx, orgId) =>
      Promise.resolve(
        [...members.entries()].filter(([k]) => k.startsWith(`${orgId}:`)).map(([, v]) => v),
      ),
    deleteOrgMember: (_tx, orgId, userId) => {
      members.delete(`${orgId}:${userId}`);
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
  return { repo, orgs, features, members };
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

const HOUR = 60 * 60 * 1000;

function fakeLogto(overrides: Partial<LogtoOrgSync> = {}) {
  const calls = {
    created: [] as string[],
    deleted: [] as string[],
    invited: [] as string[],
    mailed: [] as { id: string; link: string }[],
    accepted: [] as { id: string; userId: string }[],
    revoked: [] as string[],
  };
  const invitations = new Map<string, OrgInvitation>();
  const users = new Map<string, LogtoUser>();
  let n = 0;
  const logto: LogtoOrgSync = {
    createOrganization: (name) => {
      calls.created.push(name);
      return Promise.resolve(`logto-${name}`);
    },
    deleteOrganization: (id) => {
      calls.deleted.push(id);
      return Promise.resolve();
    },
    createInvitation: (orgId, email, role) => {
      calls.invited.push(email);
      const invitation: OrgInvitation = {
        id: `inv-${++n}`,
        organizationId: orgId,
        invitee: email,
        status: 'Pending',
        createdAt: Date.now(),
        expiresAt: Date.now() + 24 * HOUR,
        role,
      };
      invitations.set(invitation.id, invitation);
      return Promise.resolve(invitation);
    },
    listInvitations: (orgId) =>
      Promise.resolve([...invitations.values()].filter((i) => i.organizationId === orgId)),
    getInvitation: (id) => Promise.resolve(invitations.get(id) ?? null),
    sendInvitationMail: (id, link) => {
      calls.mailed.push({ id, link });
      return Promise.resolve();
    },
    revokeInvitation: (id) => {
      calls.revoked.push(id);
      invitations.get(id)!.status = 'Revoked';
      return Promise.resolve();
    },
    acceptInvitation: (id, userId) => {
      calls.accepted.push({ id, userId });
      invitations.get(id)!.status = 'Accepted';
      return Promise.resolve();
    },
    getUser: (userId) => Promise.resolve(users.get(userId) ?? null),
    listMembers: () => Promise.resolve([]),
    removeMember: () => Promise.resolve(),
    ...overrides,
  };
  return { logto, calls, invitations, users };
}

function build(opts: {
  repo?: TenancyRepository;
  logto?: LogtoOrgSync | null;
  bus?: EventBus | null;
  audit?: AuditRepository;
  consoleUrl?: string;
}) {
  const repo = opts.repo ?? fakeRepo().repo;
  const audit = opts.audit ?? fakeAudit().audit;
  return createTenancyService({
    db: fakeDb,
    repo,
    audit,
    logto: opts.logto === undefined ? fakeLogto().logto : opts.logto,
    bus: opts.bus === undefined ? fakeBus().bus : opts.bus,
    ...(opts.consoleUrl ? { consoleUrl: opts.consoleUrl } : {}),
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

describe('tenancy service · invitations', () => {
  /** An org plus a service wired to the same Logto double, which every case below starts from. */
  async function withOrg(overrides: Partial<LogtoOrgSync> = {}) {
    const { repo, members } = fakeRepo();
    const { audit, events } = fakeAudit();
    const bundle = fakeLogto(overrides);
    const svc = build({
      repo,
      audit,
      logto: bundle.logto,
      consoleUrl: 'https://console.relay.test/',
    });
    const org = await svc.onboardOrg('admin', { name: 'Acme' });
    return { svc, org, events, members, ...bundle };
  }

  it('records the invitation and mails a link to the console page that accepts it', async () => {
    const { svc, org, calls, events } = await withOrg();

    const invitation = await svc.inviteMember('admin', org.id, 'dev@acme.com');

    expect(invitation.status).toBe('pending');
    expect(invitation.email).toBe('dev@acme.com');
    expect(calls.invited).toEqual(['dev@acme.com']);
    // The link must carry the id Logto assigned, which is why creating and mailing are two steps.
    expect(calls.mailed).toEqual([
      { id: invitation.id, link: `https://console.relay.test/invitations/${invitation.id}` },
    ]);
    expect(events.map((e) => e.action)).toContain('org.member.invited');
  });

  it('reports a duplicate pending invitation as 409, not a 500', async () => {
    const { svc, org } = await withOrg({
      createInvitation: () =>
        Promise.reject(new LogtoApiError('POST', '/organization-invitations', 422, '{}')),
    });
    expect(await codeOf(() => svc.inviteMember('admin', org.id, 'dup@acme.com'))).toBe('conflict');
  });

  it('accepts an invitation for the invited address and joins that org', async () => {
    const { svc, org, calls, users, events } = await withOrg();
    const invitation = await svc.inviteMember('admin', org.id, 'dev@acme.com');
    users.set('u-1', { id: 'u-1', primaryEmail: 'DEV@acme.com', name: 'Dev' });

    const offer = await svc.getInvitationOffer('u-1', invitation.id);
    expect(offer.org_name).toBe('Acme');

    const joined = await svc.acceptInvitation('u-1', invitation.id);
    expect(joined).toEqual({ object: 'organization.membership', org_id: org.id, org_name: 'Acme' });
    expect(calls.accepted).toEqual([{ id: invitation.id, userId: 'u-1' }]);
    expect(events.map((e) => e.action)).toContain('org.member.joined');
  });

  it('refuses a holder of the link whose account is a different address', async () => {
    const { svc, org, calls, users } = await withOrg();
    const invitation = await svc.inviteMember('admin', org.id, 'dev@acme.com');
    users.set('u-2', { id: 'u-2', primaryEmail: 'someone@else.com', name: 'Else' });

    // Both the read and the accept refuse: the link leaking must not even disclose the org name.
    expect(await codeOf(() => svc.getInvitationOffer('u-2', invitation.id))).toBe(
      'insufficient_scope',
    );
    expect(await codeOf(() => svc.acceptInvitation('u-2', invitation.id))).toBe(
      'insufficient_scope',
    );
    expect(calls.accepted).toEqual([]);
  });

  it('reports an expired invitation as expired and refuses to accept it', async () => {
    const { svc, org, invitations, users, calls } = await withOrg();
    const invitation = await svc.inviteMember('admin', org.id, 'late@acme.com');
    invitations.get(invitation.id)!.expiresAt = Date.now() - HOUR;
    users.set('u-3', { id: 'u-3', primaryEmail: 'late@acme.com', name: 'Late' });

    expect((await svc.getInvitationOffer('u-3', invitation.id)).status).toBe('expired');
    expect(await codeOf(() => svc.acceptInvitation('u-3', invitation.id))).toBe('conflict');
    expect(calls.accepted).toEqual([]);
  });

  it('is idempotent once accepted — a second click returns the same membership', async () => {
    const { svc, org, users, calls } = await withOrg();
    const invitation = await svc.inviteMember('admin', org.id, 'dev@acme.com');
    users.set('u-4', { id: 'u-4', primaryEmail: 'dev@acme.com', name: 'Dev' });

    await svc.acceptInvitation('u-4', invitation.id);
    const again = await svc.acceptInvitation('u-4', invitation.id);
    expect(again.org_id).toBe(org.id);
    expect(calls.accepted).toHaveLength(1); // Logto was told exactly once
  });

  it('resends only a pending invitation, and revoking frees the address', async () => {
    const { svc, org, calls } = await withOrg();
    const invitation = await svc.inviteMember('admin', org.id, 'dev@acme.com');

    await svc.resendInvitation('admin', org.id, invitation.id);
    expect(calls.mailed).toHaveLength(2);

    await svc.revokeInvitation('admin', org.id, invitation.id);
    expect(calls.revoked).toEqual([invitation.id]);
    expect(await codeOf(() => svc.resendInvitation('admin', org.id, invitation.id))).toBe(
      'conflict',
    );
  });

  it('will not touch an invitation belonging to another org', async () => {
    const { svc, org } = await withOrg({
      getInvitation: (id) =>
        Promise.resolve({
          id,
          organizationId: 'logto-SomeoneElse',
          invitee: 'x@y.z',
          status: 'Pending',
          createdAt: Date.now(),
          expiresAt: Date.now() + HOUR,
          role: 'member',
        }),
    });
    expect(await codeOf(() => svc.revokeInvitation('admin', org.id, 'inv-9'))).toBe('not_found');
  });

  it('records the invited role on the membership when the invitation is accepted', async () => {
    const { svc, org, users, members } = await withOrg();
    const invitation = await svc.inviteMember('admin', org.id, 'boss@acme.com', 'admin');
    expect(invitation.role).toBe('admin');
    users.set('u-5', { id: 'u-5', primaryEmail: 'boss@acme.com', name: 'Boss' });

    await svc.acceptInvitation('u-5', invitation.id);

    // The role travels on the invitation because there is nowhere else to keep it between the
    // decision and the acceptance — and it must be written in the same step as the membership.
    expect(members.get(`${org.id}:u-5`)).toEqual({
      user_id: 'u-5',
      role: 'admin',
      email: 'boss@acme.com',
    });
  });

  it('defaults an invitation to member, so administration is never granted implicitly', async () => {
    const { svc, org, users, members } = await withOrg();
    const invitation = await svc.inviteMember('admin', org.id, 'dev@acme.com');
    expect(invitation.role).toBe('member');
    users.set('u-6', { id: 'u-6', primaryEmail: 'dev@acme.com', name: 'Dev' });

    await svc.acceptInvitation('u-6', invitation.id);
    expect(members.get(`${org.id}:u-6`)?.role).toBe('member');
  });

  it('removing a member drops the role, so re-inviting starts from the new invitation', async () => {
    const { svc, org, users, members } = await withOrg({
      listMembers: () => Promise.resolve([{ id: 'u-7', name: 'Gone', email: 'gone@acme.com' }]),
    });
    const invitation = await svc.inviteMember('admin', org.id, 'gone@acme.com', 'admin');
    users.set('u-7', { id: 'u-7', primaryEmail: 'gone@acme.com', name: 'Gone' });
    await svc.acceptInvitation('u-7', invitation.id);
    expect(members.get(`${org.id}:u-7`)?.role).toBe('admin');

    await svc.removeMember('admin', org.id, 'u-7');
    expect(members.has(`${org.id}:u-7`)).toBe(false);
  });

  it('reports a member with no recorded role as a plain member', async () => {
    // Orgs that predate org_members have no rows at all. They must keep working, and absence must
    // read as least privilege rather than as administration.
    const { svc, org } = await withOrg({
      listMembers: () => Promise.resolve([{ id: 'legacy', name: 'Old', email: 'old@acme.com' }]),
    });
    const [member] = await svc.listMembers(org.id);
    expect(member?.role).toBe('member');
  });

  it('setMemberRole promotes an existing member and refuses a non-member', async () => {
    const { svc, org, members } = await withOrg({
      listMembers: () => Promise.resolve([{ id: 'u-8', name: 'Dev', email: 'dev@acme.com' }]),
    });

    const promoted = await svc.setMemberRole('platform', org.id, 'u-8', 'admin');
    expect(promoted.role).toBe('admin');
    expect(members.get(`${org.id}:u-8`)?.role).toBe('admin');

    expect(await codeOf(() => svc.setMemberRole('platform', org.id, 'ghost', 'admin'))).toBe(
      'not_found',
    );
  });

  it('lists the org’s invitations', async () => {
    const { svc, org } = await withOrg();
    await svc.inviteMember('admin', org.id, 'one@acme.com');
    await svc.inviteMember('admin', org.id, 'two@acme.com');

    const list = await svc.listInvitations(org.id);
    expect(list.map((i) => i.email).sort()).toEqual(['one@acme.com', 'two@acme.com']);
    expect(list.every((i) => i.org_id === org.id)).toBe(true);
  });
});
