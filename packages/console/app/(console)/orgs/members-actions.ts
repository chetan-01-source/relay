'use server';

/**
 * Server actions for the org members panel. Members live in Logto; the gateway proxies
 * list/invite/remove behind platform:admin. These run server-side so the caller's token is attached
 * by the typed client and never reaches the browser.
 *
 * Both actions RETURN their outcome rather than throwing. A thrown server action escapes to Next's
 * error overlay — a full-page crash for something as ordinary as inviting the same person twice.
 * Returning the message lets the form render it inline, next to the field that caused it.
 */
import { revalidatePath } from 'next/cache';
import {
  inviteMember,
  removeMember,
  resendInvitation,
  revokeInvitation,
  setMemberRole,
} from '../../lib/api';

export interface MemberActionResult {
  ok: boolean;
  error?: string;
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function errorOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Request failed';
}

/** Invite a member by email into the org. */
export async function inviteMemberAction(
  _prev: MemberActionResult,
  formData: FormData,
): Promise<MemberActionResult> {
  const orgId = field(formData, 'orgId');
  const email = field(formData, 'email');
  // Anything but an explicit 'admin' is a member: a malformed field must not grant administration.
  const role = field(formData, 'role') === 'admin' ? 'admin' : 'member';
  if (!orgId) return { ok: false, error: 'Missing organization.' };
  if (!email) return { ok: false, error: 'Enter an email address.' };
  try {
    await inviteMember(orgId, email, role);
    revalidatePath(`/orgs/${orgId}`);
    return { ok: true };
  } catch (err) {
    // The gateway already returns an actionable message (e.g. a duplicate pending invitation);
    // surface it verbatim rather than replacing it with something vaguer.
    return { ok: false, error: errorOf(err) };
  }
}

/** Send the invitation mail again — the invitee lost it, or it went to spam. */
export async function resendInvitationAction(
  _prev: MemberActionResult,
  formData: FormData,
): Promise<MemberActionResult> {
  const orgId = field(formData, 'orgId');
  const invitationId = field(formData, 'invitationId');
  if (!orgId || !invitationId) return { ok: false, error: 'Missing invitation.' };
  try {
    await resendInvitation(orgId, invitationId);
    revalidatePath(`/orgs/${orgId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorOf(err) };
  }
}

/** Revoke a pending invitation. This is what frees the address to be invited again. */
export async function revokeInvitationAction(
  _prev: MemberActionResult,
  formData: FormData,
): Promise<MemberActionResult> {
  const orgId = field(formData, 'orgId');
  const invitationId = field(formData, 'invitationId');
  if (!orgId || !invitationId) return { ok: false, error: 'Missing invitation.' };
  try {
    await revokeInvitation(orgId, invitationId);
    revalidatePath(`/orgs/${orgId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorOf(err) };
  }
}

/** Promote or demote an existing member. */
export async function setMemberRoleAction(
  _prev: MemberActionResult,
  formData: FormData,
): Promise<MemberActionResult> {
  const orgId = field(formData, 'orgId');
  const userId = field(formData, 'userId');
  const role = field(formData, 'role') === 'admin' ? 'admin' : 'member';
  if (!orgId || !userId) return { ok: false, error: 'Missing member.' };
  try {
    await setMemberRole(orgId, userId, role);
    revalidatePath(`/orgs/${orgId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorOf(err) };
  }
}

/** Remove a member from the org. */
export async function removeMemberAction(
  _prev: MemberActionResult,
  formData: FormData,
): Promise<MemberActionResult> {
  const orgId = field(formData, 'orgId');
  const userId = field(formData, 'userId');
  if (!orgId || !userId) return { ok: false, error: 'Missing member.' };
  try {
    await removeMember(orgId, userId);
    revalidatePath(`/orgs/${orgId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorOf(err) };
  }
}
