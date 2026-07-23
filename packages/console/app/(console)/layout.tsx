import type { ReactNode } from 'react';
import { LayoutDashboard, Boxes, KeyRound, ScrollText } from 'lucide-react';
import { requireUser } from '../lib/auth';
import { signOutAction } from '../actions';
import { NavLink } from '../../components/nav-link';
import { Button } from '../../components/ui/button';

// Auth state is per-request (reads cookies) — never statically prerender.
export const dynamic = 'force-dynamic';

/**
 * Shell for the authenticated console (build + operate). Gates on a resolvable gateway identity and
 * renders the nav + top bar around every child page. Fine-grained authorization stays server-side:
 * each page re-gates (requireOrg / requireAdmin) and the gateway enforces scopes on every call.
 */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const me = await requireUser();

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 flex-col border-r bg-card px-3 py-4 md:flex">
        <div className="px-3 pb-4 text-lg font-semibold tracking-tight">Relay</div>
        <nav className="flex flex-1 flex-col gap-1">
          <NavLink href="/dashboard">
            <LayoutDashboard className="mr-2 h-4 w-4" /> Dashboard
          </NavLink>
          <NavLink href="/apps">
            <Boxes className="mr-2 h-4 w-4" /> Applications
          </NavLink>
          <NavLink href="/providers">
            <KeyRound className="mr-2 h-4 w-4" /> Providers
          </NavLink>
          <NavLink href="/audit">
            <ScrollText className="mr-2 h-4 w-4" /> Audit
          </NavLink>
          {me.is_platform_admin ? (
            <NavLink href="/orgs">
              <Boxes className="mr-2 h-4 w-4" /> Organizations
            </NavLink>
          ) : null}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b px-6">
          <div className="text-sm text-muted-foreground">
            {me.org_id ? `Org ${me.org_id.slice(0, 8)}…` : 'No organization'}
          </div>
          <form action={signOutAction}>
            <Button type="submit" variant="ghost" size="sm">
              Sign out
            </Button>
          </form>
        </header>
        <main className="min-w-0 flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
