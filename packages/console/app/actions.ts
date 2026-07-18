'use server';

import { signIn, signOut } from '@logto/next/server-actions';
import { logtoConfig } from './lib/logto';

export async function signInAction(): Promise<void> {
  await signIn(logtoConfig);
}

export async function signOutAction(): Promise<void> {
  await signOut(logtoConfig, logtoConfig.baseUrl);
}
