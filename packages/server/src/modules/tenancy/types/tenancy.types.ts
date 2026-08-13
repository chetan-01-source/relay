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

/** Role a user holds inside one organization. `admin` may move budgets and store credentials. */
export type OrgMemberRole = 'admin' | 'member';

/** A member of an org (identity from Logto, role from org_members). */
export interface Member {
  object: 'organization.member';
  id: string;
  name: string | null;
  email: string | null;
  role: OrgMemberRole;
}

export interface OrgMemberRow {
  user_id: string;
  role: OrgMemberRole;
  email: string | null;
}

/**
 * A pending or historical invitation to join an org. `status` mirrors Logto's lifecycle, lowercased
 * to match the rest of the API's vocabulary. This is the platform-admin view — it names the org by
 * id because the caller already knows which org they are looking at.
 */
export interface Invitation {
  object: 'organization.invitation';
  id: string;
  org_id: string;
  email: string;
  /** What the invitee becomes on acceptance. */
  role: OrgMemberRole;
  status: InvitationStatus;
  created_at: string;
  expires_at: string;
}

export type InvitationStatus = 'pending' | 'accepted' | 'expired' | 'revoked';

/**
 * The invitee's view of their own invitation, which is deliberately narrower: it names the org so
 * the console can render "Join Acme", and it is only ever returned to the person the invitation was
 * addressed to. Nothing else about the tenant leaks through it.
 */
export interface InvitationOffer {
  object: 'organization.invitation';
  id: string;
  email: string;
  org_name: string;
  status: InvitationStatus;
  expires_at: string;
}

/** What accepting an invitation produced — the org the caller now belongs to. */
export interface AcceptedInvitation {
  object: 'organization.membership';
  org_id: string;
  org_name: string;
}

/** Data-access boundary. The ONLY layer that touches the database. Methods take the caller's
 * transaction (a Queryable) so a whole onboarding/suspend flow commits atomically. */
export interface TenancyRepository {
  createOrg(tx: Queryable, input: { logtoOrgId: string; name: string }): Promise<OrgRow>;
  getOrg(tx: Queryable, orgId: string): Promise<OrgRow | null>;
  /** Reverse of the onboarding mapping: Logto's org id → our row. Used by the invitation flow, which
   * only learns which tenant it is dealing with from the invitation Logto hands back. */
  getOrgByLogtoId(tx: Queryable, logtoOrgId: string): Promise<OrgRow | null>;
  listOrgs(tx: Queryable): Promise<OrgRow[]>;
  setStatus(tx: Queryable, orgId: string, status: OrgStatus): Promise<void>;
  setOnboardingState(tx: Queryable, orgId: string, state: OnboardingState): Promise<void>;
  upsertFeatures(tx: Queryable, orgId: string, features: Record<string, unknown>): Promise<void>;
  listFeatures(tx: Queryable, orgId: string): Promise<OrgFeatureRow[]>;
  upsertOrgMember(
    tx: Queryable,
    orgId: string,
    input: { userId: string; role: OrgMemberRole; email: string | null },
  ): Promise<void>;
  listOrgMembers(tx: Queryable, orgId: string): Promise<OrgMemberRow[]>;
  deleteOrgMember(tx: Queryable, orgId: string, userId: string): Promise<void>;
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
  /** List the org's members (via Logto). Throws service_unavailable when Logto is not configured. */
  listMembers(orgId: string): Promise<Member[]>;
  /** Remove a member from the org. */
  removeMember(actor: string, orgId: string, userId: string): Promise<void>;

  // ── Invitations ───────────────────────────────────────────────────────────────────────────────
  /** Invite an email address into the org as `role`, and send the invitation mail. */
  inviteMember(
    actor: string,
    orgId: string,
    email: string,
    role?: OrgMemberRole,
  ): Promise<Invitation>;
  /** Change what an existing member may do. Platform-admin operation (console → org detail). */
  setMemberRole(actor: string, orgId: string, userId: string, role: OrgMemberRole): Promise<Member>;
  /** Every invitation ever issued for the org, newest first. */
  listInvitations(orgId: string): Promise<Invitation[]>;
  /** Send the invitation mail again for a still-pending invitation. */
  resendInvitation(actor: string, orgId: string, invitationId: string): Promise<Invitation>;
  /** Revoke a pending invitation, freeing the address to be invited again. */
  revokeInvitation(actor: string, orgId: string, invitationId: string): Promise<void>;
  /** The invitee's own view of an invitation. Rejects any caller but the invited address. */
  getInvitationOffer(userId: string, invitationId: string): Promise<InvitationOffer>;
  /** Accept an invitation on behalf of the signed-in user, creating the membership. */
  acceptInvitation(userId: string, invitationId: string): Promise<AcceptedInvitation>;
}
