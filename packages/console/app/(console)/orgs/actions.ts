'use server';

/**
 * Server actions for the tenancy console (Week 2 Day 7 · FE-1). These run on the server, so the
 * caller's Logto access token is attached by the typed client (app/lib/api.ts) and never exposed to
 * the browser. The gateway enforces platform-admin scope — the UI is only a convenience.
 */
import { revalidatePath } from 'next/cache';
import {
  onboardOrg,
  updateEntitlements,
  suspendOrg,
  unsuspendOrg,
  advanceOnboarding,
  type OnboardOrgInput,
} from '../../lib/api';
import { FEATURE_KEYS } from '../../lib/features';

/** Read a form field as a trimmed string (form values are string | File; we only use text inputs). */
function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** Onboard a new org from the wizard form. */
export async function onboardOrgAction(formData: FormData): Promise<void> {
  const name = field(formData, 'name');
  if (!name) return;
  const adminEmail = field(formData, 'adminEmail');
  const template = (field(formData, 'template') || 'default') as OnboardOrgInput['template'];

  await onboardOrg({
    name,
    ...(adminEmail ? { adminEmail } : {}),
    ...(template ? { template } : {}),
  });
  revalidatePath('/orgs');
}

/** Save an org's entitlement matrix. Unchecked boxes are sent as false so flags can be turned off. */
export async function updateEntitlementsAction(formData: FormData): Promise<void> {
  const orgId = field(formData, 'orgId');
  if (!orgId) return;

  const features: Record<string, boolean> = {};
  for (const key of FEATURE_KEYS) {
    features[key] = formData.get(`feature:${key}`) === 'on';
  }
  await updateEntitlements(orgId, features);
  revalidatePath('/orgs');
  revalidatePath(`/orgs/${orgId}`);
}

/** Suspend an org (platform-admin). The data plane rejects its keys ≤1s later. */
export async function suspendOrgAction(formData: FormData): Promise<void> {
  const orgId = field(formData, 'orgId');
  if (!orgId) return;
  await suspendOrg(orgId);
  revalidatePath('/orgs');
  revalidatePath(`/orgs/${orgId}`);
}

/** Reactivate a suspended org (platform-admin). */
export async function unsuspendOrgAction(formData: FormData): Promise<void> {
  const orgId = field(formData, 'orgId');
  if (!orgId) return;
  await unsuspendOrg(orgId);
  revalidatePath('/orgs');
  revalidatePath(`/orgs/${orgId}`);
}

/** Advance the org's onboarding state machine one step (platform-admin). */
export async function advanceOnboardingAction(formData: FormData): Promise<void> {
  const orgId = field(formData, 'orgId');
  if (!orgId) return;
  await advanceOnboarding(orgId);
  revalidatePath('/orgs');
  revalidatePath(`/orgs/${orgId}`);
}
