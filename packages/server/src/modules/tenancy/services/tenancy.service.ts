/**
 * Tenancy service (Week 2 Day 7) — the business logic of the tenant lifecycle. Orchestrates four
 * collaborators, never touching SQL or HTTP itself:
 *   Logto (org + invite)  ·  Postgres via withTenant  ·  the audit trail  ·  snapshot invalidation.
 *
 * Onboarding is a small saga: the Logto org is created first (it supplies the required logto_org_id),
 * then the DB transaction records the org + entitlements + audit atomically. If the DB step fails we
 * compensate by deleting the just-created Logto org, so a failed onboard leaves nothing behind.
 *
 * Every write runs as a platform admin (these are platform-console operations). Suspend/unsuspend and
 * entitlement edits publish on the Valkey bus so the data plane's in-process snapshots reload ≤1s.
 */
import { RelayError } from 'relay-shared';
import type { Database } from '../../../platform/db.js';
import type { EventBus } from '../../../platform/eventbus.js';
import { LogtoApiError, type LogtoOrgSync, type OrgInvitation } from '../../../platform/logto.js';
import type { AuditRepository } from '../../audit/index.js';
import type { PlansService } from '../../plans/index.js';
import type { NotificationEnqueuer } from '../../notifications/index.js';
import { publishOrgSuspend, publishOrgFeaturesUpdated } from '../../identity/index.js';
import { resolveTemplate, DEFAULT_TEMPLATE } from '../lib/entitlements.js';
import { canAdvance } from '../lib/onboarding.js';
import type {
  AcceptedInvitation,
  Invitation,
  InvitationOffer,
  InvitationStatus,
  Member,
  OrgMemberRole,
  OnboardingState,
  OnboardOrgInput,
  Organization,
  OrgRow,
  TenancyRepository,
  TenancyService,
  UpdateEntitlementsInput,
} from '../types/tenancy.types.js';

// A platform-admin write names no single tenant while creating one, so we scope the transaction to
// the NIL org id; the platform_admin_access policies grant the write regardless of app.current_org.
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

// Where the invitation email points. Only a default so a dev stack works out of the box; a real
// deployment sets RELAY_CONSOLE_URL, because a link to localhost in a tenant's inbox is a dead end.
const DEFAULT_CONSOLE_URL = 'http://localhost:3100';

export interface TenancyServiceDeps {
  db: Database;
  repo: TenancyRepository;
  audit: AuditRepository;
  logto: LogtoOrgSync | null; // null when Logto M2M is not configured → onboarding is unavailable
  bus: EventBus | null; // null for the offline spec dump → snapshot invalidation is skipped
  notify?: NotificationEnqueuer; // absent ⇒ no notification is produced
  consoleUrl?: string | undefined; // base URL the invitation link is built from
  /** Enforces `members.max` at invitation time. Absent ⇒ no seat ceiling. */
  plans?: PlansService;
}

export function createTenancyService(deps: TenancyServiceDeps): TenancyService {
  const { db, repo, audit, logto, bus, notify, plans } = deps;
  const consoleUrl = (deps.consoleUrl ?? DEFAULT_CONSOLE_URL).replace(/\/+$/, '');

  /** The console page that completes a join. This is the ONLY thing the invitation email links to. */
  function acceptUrl(invitationId: string): string {
    return `${consoleUrl}/invitations/${invitationId}`;
  }

  async function onboardOrg(actor: string, input: OnboardOrgInput): Promise<Organization> {
    if (!logto) {
      throw new RelayError('service_unavailable', {
        message: 'Organization onboarding requires Logto to be configured.',
      });
    }
    const template = input.template ?? DEFAULT_TEMPLATE;

    // 1. Create the Logto org first — it supplies the required, unique logto_org_id.
    const logtoOrgId = await logto.createOrganization(input.name);

    // 2. Persist the org + entitlements + audit atomically. Compensate Logto if this fails.
    let org: OrgRow;
    try {
      org = await db.withTenant(NIL_UUID, { isPlatformAdmin: true }, async (tx) => {
        const created = await repo.createOrg(tx, { logtoOrgId, name: input.name });
        await repo.upsertFeatures(tx, created.id, resolveTemplate(template));
        await audit.appendWithTx(tx, created.id, {
          actor,
          action: 'org.create',
          target: created.id,
          data: { name: input.name, template },
        });
        return created;
      });
    } catch (err) {
      await logto.deleteOrganization(logtoOrgId).catch(() => {
        // best-effort compensation; the orphan is logged by the caller's error handler
      });
      throw isUniqueViolation(err)
        ? new RelayError('conflict', {
            message: 'An organization with that identity already exists.',
          })
        : err;
    }

    // 3. Invite the admin (optional) and advance the lifecycle. A failed invite does not undo the
    //    org — it just leaves onboarding at 'created' for a retry.
    if (input.adminEmail) {
      // The first person invited to a new tenant administers it — otherwise a freshly onboarded org
      // has nobody who can set a budget or add a provider.
      const invitation = await logto.createInvitation(logtoOrgId, input.adminEmail, 'admin');
      await logto.sendInvitationMail(invitation.id, acceptUrl(invitation.id));
      org = await db.withTenant(org.id, { isPlatformAdmin: true }, async (tx) => {
        await repo.setOnboardingState(tx, org.id, 'admin_invited');
        await audit.appendWithTx(tx, org.id, {
          actor,
          action: 'org.admin_invited',
          target: org.id,
          data: { email: input.adminEmail },
        });
        return (await repo.getOrg(tx, org.id))!;
      });
    }

    return toApi(org);
  }

  function listOrgs(): Promise<Organization[]> {
    return db.withTenant(NIL_UUID, { isPlatformAdmin: true }, async (tx) => {
      const rows = await repo.listOrgs(tx);
      return rows.map(toApi);
    });
  }

  async function getOrg(orgId: string): Promise<Organization | null> {
    const row = await db.withTenant(orgId, { isPlatformAdmin: true }, (tx) =>
      repo.getOrg(tx, orgId),
    );
    return row ? toApi(row) : null;
  }

  async function setStatus(
    actor: string,
    orgId: string,
    status: 'active' | 'suspended',
    action: string,
  ): Promise<Organization> {
    const org = await db.withTenant(orgId, { isPlatformAdmin: true }, async (tx) => {
      await requireOrg(tx, orgId);
      await repo.setStatus(tx, orgId, status);
      // Only the suspension is notified: being cut off is news, being restored is a relief the org
      // will already have noticed. Enqueued in the same transaction as the status change.
      if (notify && status === 'suspended') {
        await notify.enqueueWithTx(tx, orgId, {
          event: 'org.suspended',
          dedupeKey: null,
          payload: { actor },
        });
      }
      await audit.appendWithTx(tx, orgId, { actor, action, target: orgId });
      return (await repo.getOrg(tx, orgId))!;
    });
    // Drop cached snapshots for this org so the data plane sees the new status within ≤1s.
    if (bus) await publishOrgSuspend(bus, orgId);
    return toApi(org);
  }

  function suspendOrg(actor: string, orgId: string): Promise<Organization> {
    return setStatus(actor, orgId, 'suspended', 'org.suspend');
  }

  function unsuspendOrg(actor: string, orgId: string): Promise<Organization> {
    return setStatus(actor, orgId, 'active', 'org.unsuspend');
  }

  function getEntitlements(orgId: string): Promise<Record<string, unknown>> {
    return db.withTenant(orgId, { isPlatformAdmin: true }, async (tx) => {
      await requireOrg(tx, orgId);
      return foldFeatures(await repo.listFeatures(tx, orgId));
    });
  }

  async function updateEntitlements(
    actor: string,
    orgId: string,
    input: UpdateEntitlementsInput,
  ): Promise<Record<string, unknown>> {
    const features = await db.withTenant(orgId, { isPlatformAdmin: true }, async (tx) => {
      await requireOrg(tx, orgId);
      await repo.upsertFeatures(tx, orgId, input.features);
      await audit.appendWithTx(tx, orgId, {
        actor,
        action: 'org.features.updated',
        target: orgId,
        data: input.features,
      });
      return foldFeatures(await repo.listFeatures(tx, orgId));
    });
    if (bus) await publishOrgFeaturesUpdated(bus, orgId);
    return features;
  }

  async function advanceOnboarding(
    actor: string,
    orgId: string,
    to: OnboardingState,
  ): Promise<Organization> {
    const org = await db.withTenant(orgId, { isPlatformAdmin: true }, async (tx) => {
      const current = await requireOrg(tx, orgId);
      if (!canAdvance(current.onboarding_state, to)) {
        throw new RelayError('invalid_request', {
          message: `Cannot move onboarding from '${current.onboarding_state}' to '${to}'.`,
          param: 'state',
        });
      }
      await repo.setOnboardingState(tx, orgId, to);
      await audit.appendWithTx(tx, orgId, { actor, action: `org.onboarding.${to}`, target: orgId });
      return (await repo.getOrg(tx, orgId))!;
    });
    return toApi(org);
  }

  /** Load an org inside the current tx or throw 404. Used by every mutation to fail loud + early. */
  async function requireOrg(tx: Parameters<TenancyRepository['getOrg']>[0], orgId: string) {
    const org = await repo.getOrg(tx, orgId);
    if (!org) throw new RelayError('not_found', { message: `Organization '${orgId}' not found.` });
    return org;
  }

  /** Resolve our org row → its logto_org_id, or throw. Members live in Logto, keyed by that id. */
  async function requireLogtoOrgId(orgId: string): Promise<string> {
    if (!logto) {
      throw new RelayError('service_unavailable', {
        message: 'Member management requires Logto to be configured.',
      });
    }
    const org = await getOrg(orgId);
    if (!org) throw new RelayError('not_found', { message: `Organization '${orgId}' not found.` });
    return org.logto_org_id;
  }

  /**
   * Translate Logto's rejection of an invite into something the caller can act on.
   *
   * Re-inviting an address that already has a pending invitation is a UNIQUE violation in Logto
   * (422). That is the caller's situation, not a gateway fault, so it becomes a 409 with a message
   * that says what to do — rather than the generic "An internal error occurred." it produced before.
   * Anything else is re-thrown untouched: an unexpected Logto failure IS ours, and dressing it up as
   * a client error would hide a real outage.
   */
  async function inviting<T>(email: string, send: () => Promise<T>): Promise<T> {
    try {
      return await send();
    } catch (err) {
      if (
        err instanceof LogtoApiError &&
        (err.logtoCode === 'entity.unique_integrity_violation' || err.status === 422)
      ) {
        throw new RelayError('conflict', {
          message: `${email} already has a pending invitation to this organization. Revoke it before sending another.`,
          param: 'email',
        });
      }
      throw err;
    }
  }

  async function listMembers(orgId: string): Promise<Member[]> {
    const logtoOrgId = await requireLogtoOrgId(orgId);
    const members = await logto!.listMembers(logtoOrgId);
    // Identity comes from Logto, role from us. A member with no row reads as 'member' — see the
    // migration: orgs that predate this table keep working, and nobody is promoted by accident.
    const roles = await db.withTenant(orgId, { isPlatformAdmin: true }, (tx) =>
      repo.listOrgMembers(tx, orgId),
    );
    const roleByUser = new Map(roles.map((r) => [r.user_id, r.role]));
    return members.map((m) => ({
      object: 'organization.member',
      id: m.id,
      name: m.name,
      email: m.email,
      role: roleByUser.get(m.id) ?? 'member',
    }));
  }

  /**
   * Promote or demote a member. A platform-admin operation: org administration is granted from
   * outside the org, so an org cannot bootstrap its own first admin or lock its operator out.
   */
  async function setMemberRole(
    actor: string,
    orgId: string,
    userId: string,
    role: OrgMemberRole,
  ): Promise<Member> {
    const logtoOrgId = await requireLogtoOrgId(orgId);
    const members = await logto!.listMembers(logtoOrgId);
    const member = members.find((m) => m.id === userId);
    if (!member) {
      throw new RelayError('not_found', { message: `'${userId}' is not a member of this org.` });
    }
    await db.withTenant(orgId, { isPlatformAdmin: true }, async (tx) => {
      await repo.upsertOrgMember(tx, orgId, { userId, role, email: member.email });
      await audit.appendWithTx(tx, orgId, {
        actor,
        action: 'org.member.role_changed',
        target: orgId,
        data: { userId, role, email: member.email },
      });
    });
    return {
      object: 'organization.member',
      id: member.id,
      name: member.name,
      email: member.email,
      role,
    };
  }

  /**
   * Invite an address into the org: record the invitation, then mail the acceptance link.
   *
   * The two steps are separate because the link must carry the id Logto assigns at creation. If the
   * mail step fails the invitation still exists and stays pending — the admin resends rather than
   * re-invites, which is why a failed send is surfaced as a 503 and not rolled back.
   */
  async function inviteMember(
    actor: string,
    orgId: string,
    email: string,
    role: OrgMemberRole = 'member',
  ): Promise<Invitation> {
    const logtoOrgId = await requireLogtoOrgId(orgId);
    // Seats are checked BEFORE Logto is asked to create the invitation. Unlike the other quotas
    // this one cannot live inside the insert transaction — the membership is created in Logto, not
    // in our database — so it is deliberately a pre-check. The narrow race it leaves (two admins
    // inviting the last seat at once) over-fills by one invitation, which is recoverable; issuing
    // an invitation we would then have to refuse at acceptance time is not.
    if (plans) {
      await db.withTenant(orgId, { isPlatformAdmin: true }, (tx) =>
        plans.assertQuota(tx, orgId, 'members.max'),
      );
    }
    const invitation = await inviting(email, () =>
      logto!.createInvitation(logtoOrgId, email, role),
    );
    await logto!.sendInvitationMail(invitation.id, acceptUrl(invitation.id));
    await db.withTenant(orgId, { isPlatformAdmin: true }, (tx) =>
      audit.appendWithTx(tx, orgId, {
        actor,
        action: 'org.member.invited',
        target: orgId,
        data: { email, role, invitation_id: invitation.id },
      }),
    );
    return toInvitationApi(invitation, orgId);
  }

  async function listInvitations(orgId: string): Promise<Invitation[]> {
    const logtoOrgId = await requireLogtoOrgId(orgId);
    const invitations = await logto!.listInvitations(logtoOrgId);
    return invitations
      .map((i) => toInvitationApi(i, orgId))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  /**
   * Load an invitation and prove it belongs to `orgId` before acting on it. Without this check an
   * admin of one tenant could revoke another tenant's invitation by id — the ids are unguessable but
   * not secret, and "unguessable" is not an authorization model.
   */
  async function requireInvitationOfOrg(orgId: string, invitationId: string) {
    const logtoOrgId = await requireLogtoOrgId(orgId);
    const invitation = await logto!.getInvitation(invitationId);
    if (!invitation || invitation.organizationId !== logtoOrgId) {
      throw new RelayError('not_found', { message: `Invitation '${invitationId}' not found.` });
    }
    return invitation;
  }

  async function resendInvitation(
    actor: string,
    orgId: string,
    invitationId: string,
  ): Promise<Invitation> {
    const invitation = await requireInvitationOfOrg(orgId, invitationId);
    if (invitation.status !== 'Pending') {
      throw new RelayError('conflict', {
        message: `This invitation is ${invitation.status.toLowerCase()} — only a pending invitation can be resent.`,
      });
    }
    await logto!.sendInvitationMail(invitation.id, acceptUrl(invitation.id));
    await db.withTenant(orgId, { isPlatformAdmin: true }, (tx) =>
      audit.appendWithTx(tx, orgId, {
        actor,
        action: 'org.invitation.resent',
        target: orgId,
        data: { email: invitation.invitee, invitation_id: invitation.id },
      }),
    );
    return toInvitationApi(invitation, orgId);
  }

  async function revokeInvitation(
    actor: string,
    orgId: string,
    invitationId: string,
  ): Promise<void> {
    const invitation = await requireInvitationOfOrg(orgId, invitationId);
    await logto!.revokeInvitation(invitation.id);
    await db.withTenant(orgId, { isPlatformAdmin: true }, (tx) =>
      audit.appendWithTx(tx, orgId, {
        actor,
        action: 'org.invitation.revoked',
        target: orgId,
        data: { email: invitation.invitee, invitation_id: invitation.id },
      }),
    );
  }

  /**
   * Resolve an invitation for the person holding the link, enforcing that they are the invitee.
   *
   * The invitation id travels in a URL that can be forwarded, screenshotted, or sat in a shared
   * inbox, so possession of it proves nothing. Logto's accept API does not check who is accepting —
   * this does: the signed-in account's primary email must match the invited address, or the caller
   * gets a 403 and learns nothing about the org. That check is the whole security model of this flow.
   */
  async function invitationFor(userId: string, invitationId: string) {
    if (!logto) {
      throw new RelayError('service_unavailable', {
        message: 'Invitations require Logto to be configured.',
      });
    }
    const invitation = await logto.getInvitation(invitationId);
    if (!invitation) {
      throw new RelayError('not_found', { message: 'This invitation no longer exists.' });
    }
    const user = await logto.getUser(userId);
    const email = user?.primaryEmail?.trim().toLowerCase();
    if (!email || email !== invitation.invitee.trim().toLowerCase()) {
      throw new RelayError('insufficient_scope', {
        message: 'This invitation was sent to a different email address.',
      });
    }
    const org = await db.withTenant(NIL_UUID, { isPlatformAdmin: true }, (tx) =>
      repo.getOrgByLogtoId(tx, invitation.organizationId),
    );
    if (!org) {
      // The Logto org exists but Relay has no row for it — an invitation into a tenant we do not
      // manage. Accepting would produce a membership the gateway can never resolve to an org.
      throw new RelayError('not_found', { message: 'This invitation no longer exists.' });
    }
    return { invitation, org };
  }

  async function getInvitationOffer(
    userId: string,
    invitationId: string,
  ): Promise<InvitationOffer> {
    const { invitation, org } = await invitationFor(userId, invitationId);
    return {
      object: 'organization.invitation',
      id: invitation.id,
      email: invitation.invitee,
      org_name: org.name,
      status: statusOf(invitation.status, invitation.expiresAt),
      expires_at: new Date(invitation.expiresAt).toISOString(),
    };
  }

  async function acceptInvitation(
    userId: string,
    invitationId: string,
  ): Promise<AcceptedInvitation> {
    const { invitation, org } = await invitationFor(userId, invitationId);
    const status = statusOf(invitation.status, invitation.expiresAt);
    if (status === 'accepted') {
      // Already a member — clicking the link twice is not an error worth blocking on.
      return { object: 'organization.membership', org_id: org.id, org_name: org.name };
    }
    if (status !== 'pending') {
      throw new RelayError('conflict', {
        message: `This invitation is ${status}. Ask an administrator to send a new one.`,
      });
    }
    await logto!.acceptInvitation(invitation.id, userId);
    // Logto now says they belong; this row says what they may do. Written in the same step so a
    // member can never exist without a role — the gate would then read them as a plain member and
    // the admin who invited them would look at a console that quietly disagrees with the invitation.
    await db.withTenant(org.id, { isPlatformAdmin: true }, async (tx) => {
      await repo.upsertOrgMember(tx, org.id, {
        userId,
        role: invitation.role,
        email: invitation.invitee,
      });
      await audit.appendWithTx(tx, org.id, {
        actor: userId,
        action: 'org.member.joined',
        target: org.id,
        data: { email: invitation.invitee, role: invitation.role, invitation_id: invitation.id },
      });
    });
    return { object: 'organization.membership', org_id: org.id, org_name: org.name };
  }

  async function removeMember(actor: string, orgId: string, userId: string): Promise<void> {
    const logtoOrgId = await requireLogtoOrgId(orgId);
    await logto!.removeMember(logtoOrgId, userId);
    await db.withTenant(orgId, { isPlatformAdmin: true }, (tx) =>
      (async () => {
        // Drop the role with the membership, so re-inviting the same person starts them at the role
        // the new invitation grants rather than silently restoring the old one.
        await repo.deleteOrgMember(tx, orgId, userId);
        if (notify) {
          await notify.enqueueWithTx(tx, orgId, {
            event: 'member.removed',
            dedupeKey: null,
            payload: { actor, target: userId },
          });
        }
        await audit.appendWithTx(tx, orgId, {
          actor,
          action: 'org.member.removed',
          target: orgId,
          data: { userId },
        });
      })(),
    );
  }

  return {
    onboardOrg,
    listOrgs,
    getOrg,
    suspendOrg,
    unsuspendOrg,
    getEntitlements,
    updateEntitlements,
    advanceOnboarding,
    listMembers,
    removeMember,
    setMemberRole,
    inviteMember,
    listInvitations,
    resendInvitation,
    revokeInvitation,
    getInvitationOffer,
    acceptInvitation,
  };
}

/**
 * Logto's status, plus the one transition it does not perform for us: an invitation past its expiry
 * still reads `Pending` until something touches it, and telling a user "pending" about a link that
 * will be refused is worse than saying it expired.
 */
function statusOf(status: OrgInvitation['status'], expiresAt: number): InvitationStatus {
  if (status === 'Pending' && expiresAt <= Date.now()) return 'expired';
  return status.toLowerCase() as InvitationStatus;
}

function toInvitationApi(invitation: OrgInvitation, orgId: string): Invitation {
  return {
    object: 'organization.invitation',
    id: invitation.id,
    org_id: orgId,
    email: invitation.invitee,
    role: invitation.role,
    status: statusOf(invitation.status, invitation.expiresAt),
    created_at: new Date(invitation.createdAt).toISOString(),
    expires_at: new Date(invitation.expiresAt).toISOString(),
  };
}

function toApi(row: OrgRow): Organization {
  return {
    object: 'organization',
    id: row.id,
    name: row.name,
    status: row.status,
    onboarding_state: row.onboarding_state,
    logto_org_id: row.logto_org_id,
    created_at: row.created_at,
  };
}

function foldFeatures(rows: { feature_key: string; value: unknown }[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) out[row.feature_key] = row.value;
  return out;
}

/** Postgres unique_violation — the logto_org_id UNIQUE constraint tripped (duplicate onboard). */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
