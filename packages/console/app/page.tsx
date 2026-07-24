import Link from 'next/link';
import { getLogtoContext } from '@logto/next/server-actions';
import { logtoConfig, logtoConfigured } from './lib/logto';
import { signInAction, signOutAction } from './actions';
import { getMe } from './lib/api';
import { Button } from '../components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/ui/card';

// Auth state is per-request (reads cookies) — never statically prerender.
export const dynamic = 'force-dynamic';

export default async function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Relay Console</CardTitle>
          <CardDescription>Multi-tenant LLM gateway management.</CardDescription>
        </CardHeader>
        <CardContent>{await body()}</CardContent>
      </Card>
    </main>
  );
}

async function body() {
  if (!logtoConfigured) {
    return (
      <p className="text-sm text-muted-foreground">
        Logto is not configured. Set LOGTO_APP_ID / LOGTO_APP_SECRET in .env.local.
      </p>
    );
  }

  const { isAuthenticated, claims } = await getLogtoContext(logtoConfig);
  if (!isAuthenticated) {
    return (
      <form action={signInAction}>
        <Button type="submit" className="w-full">
          Sign in with Logto
        </Button>
      </form>
    );
  }

  // Prove the token resolves to a gateway identity; tolerate a 401/403 so the page still renders.
  let me: Awaited<ReturnType<typeof getMe>> | null = null;
  try {
    me = await getMe();
  } catch {
    me = null;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Signed in as {claims?.email ?? claims?.sub}</p>
      <div className="flex flex-col gap-2">
        {me?.org_id ? (
          <Button asChild className="w-full">
            <Link href="/dashboard">Open console →</Link>
          </Button>
        ) : null}
        {me?.is_platform_admin ? (
          <Button asChild variant="outline" className="w-full">
            <Link href="/orgs">Manage organizations →</Link>
          </Button>
        ) : null}
        {!me ? (
          <p className="text-sm text-destructive">
            Your token could not be resolved by the gateway (missing scope or audience).
          </p>
        ) : null}
      </div>
      <form action={signOutAction}>
        <Button type="submit" variant="ghost" size="sm" className="w-full">
          Sign out
        </Button>
      </form>
    </div>
  );
}
