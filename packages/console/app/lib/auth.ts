/**
 * Server-side auth + authorization gates (Day 13 · FE-1). The console NEVER trusts the client to
 * hide privileged UI: every gated page calls one of these in its server component, which reads the
 * Logto session and the gateway's own view of the caller (`GET /api/v1/me` → org_id, scopes,
 * is_platform_admin). Fine-grained enforcement still lives in the gateway (it 403s a token without a
 * scope); these gates are the server-side redirect layer so an unauthorized user never sees the page.
 */
import { getLogtoContext } from '@logto/next/server-actions';
import { redirect } from 'next/navigation';
import { logtoConfig } from './logto';
import { getMe } from './api';

export type Me = Awaited<ReturnType<typeof getMe>>;

/** Require an authenticated session with a resolvable gateway identity. Redirects home otherwise. */
export async function requireUser(): Promise<Me> {
  const { isAuthenticated } = await getLogtoContext(logtoConfig);
  if (!isAuthenticated) redirect('/');
  try {
    return await getMe();
  } catch {
    // Authenticated with Logto but the gateway rejected the token (missing audience/scope): treat as
    // unauthenticated for the console and send them home rather than render a broken page.
    redirect('/');
  }
}

/** True if the caller may exercise `scope`. Platform admins and the coarse `all` grant satisfy any
 * scope; otherwise the exact scope must be present. Used for server-side conditional rendering. */
export function hasScope(me: Me, scope: string): boolean {
  if (me.is_platform_admin) return true;
  const scopes = me.scopes ?? [];
  return scopes.includes('all') || scopes.includes(scope);
}

/** Require an org-scoped caller (the build/operate screens act on the caller's own org). */
export async function requireOrg(): Promise<Me & { org_id: string }> {
  const me = await requireUser();
  if (!me.org_id) redirect('/');
  return me as Me & { org_id: string };
}

/** Require platform-admin (the cross-org screens). */
export async function requireAdmin(): Promise<Me> {
  const me = await requireUser();
  if (!me.is_platform_admin) redirect('/');
  return me;
}
