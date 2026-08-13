/**
 * Where to land after Logto sends the user back.
 *
 * Logto's redirect URI is fixed (`${baseUrl}/callback`) and has to be registered in the Logto app,
 * so it cannot carry a per-visit destination. The invitation flow needs one: somebody who opens
 * /invitations/<id> while signed out must return to that page, not to the home screen where the link
 * they were sent is lost. So the destination is parked in a short-lived cookie across the round trip.
 *
 * Only same-site PATHS are accepted. An absolute or protocol-relative value ("//evil.example") would
 * turn the console's own callback into an open redirect, which is exactly the kind of thing an
 * attacker looks for in a link people are already primed to click.
 */
import { cookies } from 'next/headers';

const COOKIE = 'relay_return_to';
const MAX_AGE_SECONDS = 10 * 60; // long enough to sign in or register, short enough to be forgotten

/** True when `value` is a path this app may redirect to. */
export function isSafeReturnPath(value: string | undefined | null): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//');
}

/** Park the destination for the sign-in round trip. Server actions / route handlers only. */
export async function rememberReturnTo(path: string): Promise<void> {
  if (!isSafeReturnPath(path)) return;
  const store = await cookies();
  store.set(COOKIE, path, {
    httpOnly: true,
    sameSite: 'lax', // must survive the top-level redirect back from Logto
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
}

/** Read the destination and clear it — a one-shot value; a stale one would hijack a later sign-in. */
export async function takeReturnTo(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(COOKIE)?.value;
  store.delete(COOKIE);
  return isSafeReturnPath(value) ? value : null;
}
