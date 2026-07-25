import type { ReactNode } from 'react';
import {
  LayoutDashboard,
  Boxes,
  KeyRound,
  ScrollText,
  Building2,
  BarChart3,
  Waypoints,
  Radio,
} from 'lucide-react';
import { requireUser } from '../lib/auth';
import { signOutAction } from '../actions';
import { NavLink } from '../../components/nav-link';
import { Button } from '../../components/ui/button';
import { ThemeToggle } from '../../components/theme-toggle';

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
        <div className="flex items-center gap-2 px-3 pb-5 pt-1">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
            R
          </span>
          <span className="text-lg font-semibold tracking-tight">Relay</span>
        </div>
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
          <NavLink href="/routes">
            <Waypoints className="mr-2 h-4 w-4" /> Routes
          </NavLink>
          <NavLink href="/traffic">
            <Radio className="mr-2 h-4 w-4" /> Live traffic
          </NavLink>
          <NavLink href="/audit">
            <ScrollText className="mr-2 h-4 w-4" /> Audit
          </NavLink>
          {me.is_platform_admin ? (
            <>
              <div className="mt-4 px-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Platform
              </div>
              <NavLink href="/orgs">
                <Building2 className="mr-2 h-4 w-4" /> Organizations
              </NavLink>
              <NavLink href="/platform">
                <BarChart3 className="mr-2 h-4 w-4" /> Platform usage
              </NavLink>
            </>
          ) : null}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b px-6">
          <div className="text-sm text-muted-foreground">
            {me.org_id ? `Org ${me.org_id.slice(0, 8)}…` : 'No organization'}
          </div>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <form action={signOutAction}>
              <Button type="submit" variant="ghost" size="sm">
                Sign out
              </Button>
            </form>
          </div>
        </header>
        <main className="min-w-0 flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
