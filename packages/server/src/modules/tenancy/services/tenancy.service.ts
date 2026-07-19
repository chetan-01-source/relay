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
import { RelayError } from '@relay/shared';
import type { Database } from '../../../platform/db.js';
import type { EventBus } from '../../../platform/eventbus.js';
import type { LogtoOrgSync } from '../../../platform/logto.js';
import type { AuditRepository } from '../../audit/index.js';
import { publishOrgSuspend, publishOrgFeaturesUpdated } from '../../identity/index.js';
import { resolveTemplate, DEFAULT_TEMPLATE } from '../lib/entitlements.js';
import { canAdvance } from '../lib/onboarding.js';
import type {
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

export interface TenancyServiceDeps {
  db: Database;
  repo: TenancyRepository;
  audit: AuditRepository;
  logto: LogtoOrgSync | null; // null when Logto M2M is not configured → onboarding is unavailable
  bus: EventBus | null; // null for the offline spec dump → snapshot invalidation is skipped
}

export function createTenancyService(deps: TenancyServiceDeps): TenancyService {
  const { db, repo, audit, logto, bus } = deps;

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
      await logto.inviteAdmin(logtoOrgId, input.adminEmail);
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

  return {
    onboardOrg,
    listOrgs,
    getOrg,
    suspendOrg,
    unsuspendOrg,
    getEntitlements,
    updateEntitlements,
    advanceOnboarding,
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
