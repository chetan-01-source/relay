/**
 * Tenancy module interfaces (Week 2 Day 7). Platform-admin control plane for the tenant lifecycle:
 * onboard an org (Logto org + row + entitlements + admin invite), list/read, suspend/unsuspend
 * (which the data plane observes ≤1s later), and edit entitlements. Every mutation is an audit event.
 *
 * Every layer depends on an interface declared here.
 */
import type { Queryable } from '../../../platform/db.js';

/** Linear onboarding lifecycle (mirrored by the CHECK in migration 0011). */
export type OnboardingState = 'created' | 'admin_invited' | 'provider_added' | 'first_request';

/** Named entitlement bundles applied at onboarding. */
export type EntitlementTemplateName = 'default' | 'trial' | 'internal';

export type OrgStatus = 'active' | 'suspended';

/** A row in the organizations table (persistence shape). */
export interface OrgRow {
  id: string;
  logto_org_id: string;
  name: string;
  status: OrgStatus;
  onboarding_state: OnboardingState;
  created_at: string;
  updated_at: string;
}

/** The API object returned to console clients. */
export interface Organization {
  object: 'organization';
  id: string;
  name: string;
  status: OrgStatus;
  onboarding_state: OnboardingState;
  logto_org_id: string;
  created_at: string;
}

export interface OrgFeatureRow {
  feature_key: string;
  value: unknown;
}

export interface OnboardOrgInput {
  name: string;
  adminEmail?: string;
  template?: EntitlementTemplateName;
}

export interface UpdateEntitlementsInput {
  features: Record<string, unknown>;
}

/** Data-access boundary. The ONLY layer that touches the database. Methods take the caller's
 * transaction (a Queryable) so a whole onboarding/suspend flow commits atomically. */
export interface TenancyRepository {
  createOrg(tx: Queryable, input: { logtoOrgId: string; name: string }): Promise<OrgRow>;
  getOrg(tx: Queryable, orgId: string): Promise<OrgRow | null>;
  listOrgs(tx: Queryable): Promise<OrgRow[]>;
  setStatus(tx: Queryable, orgId: string, status: OrgStatus): Promise<void>;
  setOnboardingState(tx: Queryable, orgId: string, state: OnboardingState): Promise<void>;
  upsertFeatures(tx: Queryable, orgId: string, features: Record<string, unknown>): Promise<void>;
  listFeatures(tx: Queryable, orgId: string): Promise<OrgFeatureRow[]>;
}

/** Business boundary. Orchestrates Logto sync + DB + audit + snapshot invalidation. No SQL, no HTTP. */
export interface TenancyService {
  onboardOrg(actor: string, input: OnboardOrgInput): Promise<Organization>;
  listOrgs(): Promise<Organization[]>;
  getOrg(orgId: string): Promise<Organization | null>;
  suspendOrg(actor: string, orgId: string): Promise<Organization>;
  unsuspendOrg(actor: string, orgId: string): Promise<Organization>;
  getEntitlements(orgId: string): Promise<Record<string, unknown>>;
  updateEntitlements(
    actor: string,
    orgId: string,
    input: UpdateEntitlementsInput,
  ): Promise<Record<string, unknown>>;
  advanceOnboarding(actor: string, orgId: string, to: OnboardingState): Promise<Organization>;
}
