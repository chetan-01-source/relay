import { getLogtoContext } from '@logto/next/server-actions';
import { logtoConfig, logtoConfigured } from './lib/logto';
import { signInAction, signOutAction } from './actions';

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

  return (
    <main>
      <h1>Relay Console</h1>
      {isAuthenticated ? (
        <>
          <p>Signed in as {claims?.email ?? claims?.sub}</p>
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
