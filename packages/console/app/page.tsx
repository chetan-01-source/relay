import { getLogtoContext } from '@logto/next/server-actions';
import { logtoConfig, logtoConfigured } from './lib/logto';
import { signInAction, signOutAction } from './actions';
import { getMe } from './lib/api';

// auth state is per-request (reads cookies) — never statically prerender
export const dynamic = 'force-dynamic';

export default async function Home() {
  if (!logtoConfigured) {
    return (
      <main>
        <h1>Relay Console</h1>
        <p>Logto is not configured. Set LOGTO_APP_ID / LOGTO_APP_SECRET in .env.local.</p>
      </main>
    );
  }

  const { isAuthenticated, claims } = await getLogtoContext(logtoConfig);

  // Prove the typed control-plane client end-to-end: call GET /api/v1/me with the caller's token.
  // Tolerant of a 401/403 (e.g. a token lacking the relay:read scope) so the page still renders.
  let me: Awaited<ReturnType<typeof getMe>> | null = null;
  let meError: string | null = null;
  if (isAuthenticated) {
    try {
      me = await getMe();
    } catch (err) {
      meError = err instanceof Error ? err.message : 'request failed';
    }
  }

  return (
    <main>
      <h1>Relay Console</h1>
      {isAuthenticated ? (
        <>
          <p>Signed in as {claims?.email ?? claims?.sub}</p>
          {me ? (
            <pre>{JSON.stringify(me, null, 2)}</pre>
          ) : (
            <p>Control-plane call: {meError ?? 'no data'}</p>
          )}
          <form action={signOutAction}>
            <button type="submit">Sign out</button>
          </form>
        </>
      ) : (
        <form action={signInAction}>
          <button type="submit">Sign in with Logto</button>
        </form>
      )}
    </main>
  );
}
