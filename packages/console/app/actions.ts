'use server';

import { signIn, signOut } from '@logto/next/server-actions';
import { logtoConfig } from './lib/logto';
import { rememberReturnTo } from './lib/return-to';

export async function signInAction(): Promise<void> {
  await signIn(logtoConfig);
}

/**
 * Sign in and come back to `returnTo` instead of the home page. Used by the invitation page, and by
 * the re-authentication step after accepting one: a session issued before the user joined an org
 * carries no `organizations` claim, so the console cannot mint an org-scoped token until Logto
 * re-issues it. Signing in again with a live Logto session is a redirect, not a second login.
 */
export async function signInWithReturnAction(formData: FormData): Promise<void> {
  const returnTo = formData.get('returnTo');
  if (typeof returnTo === 'string') await rememberReturnTo(returnTo);
  await signIn(logtoConfig);
}

export async function signOutAction(): Promise<void> {
  await signOut(logtoConfig, logtoConfig.baseUrl);
}
