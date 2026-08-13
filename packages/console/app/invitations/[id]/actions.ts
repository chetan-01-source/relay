'use server';

import { signIn } from '@logto/next/server-actions';
import { acceptInvitation } from '../../lib/api';
import { logtoConfig } from '../../lib/logto';
import { rememberReturnTo } from '../../lib/return-to';

export interface AcceptResult {
  ok: boolean;
  error?: string;
}

/**
 * Join the org this invitation names, then re-authenticate.
 *
 * The re-auth is not ceremony. The user's session was minted before the membership existed, so its
 * `organizations` claim is empty; until Logto re-issues it the console cannot ask for an org-scoped
 * token and every console page would bounce the new member straight back to the home screen. With a
 * live Logto session this is a redirect the user barely sees, not a second sign-in.
 *
 * Failures are RETURNED, not thrown: a revoked or expired invitation is an ordinary outcome and
 * belongs on the page, next to the button, rather than in Next's error overlay.
 */
export async function acceptInvitationAction(
  _prev: AcceptResult,
  formData: FormData,
): Promise<AcceptResult> {
  const id = formData.get('invitationId');
  if (typeof id !== 'string' || !id) return { ok: false, error: 'Missing invitation.' };

  try {
    await acceptInvitation(id);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Could not accept invitation.',
    };
  }

  await rememberReturnTo('/dashboard');
  await signIn(logtoConfig); // throws a redirect — nothing after this line runs
  return { ok: true };
}
