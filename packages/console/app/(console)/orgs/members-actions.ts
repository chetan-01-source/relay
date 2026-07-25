'use server';

/**
 * Server actions for the org members panel (Day 13 · FE-1). Members live in Logto; the gateway
 * proxies list/invite/remove behind platform:admin. These run server-side so the caller's token is
 * attached by the typed client and never reaches the browser.
 */
import { revalidatePath } from 'next/cache';
import { inviteMember, removeMember } from '../../lib/api';

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** Invite a member by email into the org. */
export async function inviteMemberAction(formData: FormData): Promise<void> {
  const orgId = field(formData, 'orgId');
  const email = field(formData, 'email');
  if (!orgId || !email) return;
  await inviteMember(orgId, email);
  revalidatePath(`/orgs/${orgId}`);
}

/** Remove a member from the org. */
export async function removeMemberAction(formData: FormData): Promise<void> {
  const orgId = field(formData, 'orgId');
  const userId = field(formData, 'userId');
  if (!orgId || !userId) return;
  await removeMember(orgId, userId);
  revalidatePath(`/orgs/${orgId}`);
}
