import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  LayoutDashboard,
  Boxes,
  KeyRound,
  ScrollText,
  Building2,
  BarChart3,
  Waypoints,
  Radio,
  HeartPulse,
  LineChart,
  Layers,
  TerminalSquare,
  Wallet,
  Bell,
  Gauge,
} from 'lucide-react';
import { requireUser } from '../lib/auth';
import { signOutAction } from '../actions';
import { NavLink } from '../../components/nav-link';
import { RelayLogo } from '../../components/brand/relay-logo';
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
        {/* The real lockup, not a letter tile — the console and the landing page have to be the
            same product. Wrapped in a link home so the logo does what every logo is expected to. */}
        <Link
          href="/dashboard"
          aria-label="Relay dashboard"
          className="mx-3 mb-5 mt-1 inline-flex w-fit rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RelayLogo />
        </Link>
        {/* Grouped build → operate → platform, which is the order an operator actually works in.
            The groups are labelled because the flat list stopped being scannable past six items. */}
        <nav className="flex flex-1 flex-col gap-1" aria-label="Console">
          <NavLink href="/dashboard">
            <LayoutDashboard className="mr-2 h-4 w-4" aria-hidden="true" /> Dashboard
          </NavLink>

          <div className="mt-4 px-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Build
          </div>
          <NavLink href="/apps">
            <Boxes className="mr-2 h-4 w-4" aria-hidden="true" /> Applications
          </NavLink>
          <NavLink href="/providers">
            <KeyRound className="mr-2 h-4 w-4" aria-hidden="true" /> Providers
          </NavLink>
          <NavLink href="/routes">
            <Waypoints className="mr-2 h-4 w-4" aria-hidden="true" /> Routes
          </NavLink>
          <NavLink href="/models">
            <Layers className="mr-2 h-4 w-4" aria-hidden="true" /> Models
          </NavLink>
          <NavLink href="/playground">
            <TerminalSquare className="mr-2 h-4 w-4" aria-hidden="true" /> Playground
          </NavLink>

          <div className="mt-4 px-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Operate
          </div>
          <NavLink href="/analytics">
            <LineChart className="mr-2 h-4 w-4" aria-hidden="true" /> Usage &amp; spend
          </NavLink>
          <NavLink href="/budgets">
            <Wallet className="mr-2 h-4 w-4" aria-hidden="true" /> Budgets
          </NavLink>
          <NavLink href="/traffic">
            <Radio className="mr-2 h-4 w-4" aria-hidden="true" /> Live traffic
          </NavLink>
          <NavLink href="/audit">
            <ScrollText className="mr-2 h-4 w-4" aria-hidden="true" /> Audit
          </NavLink>
          <NavLink href="/notifications">
            <Bell className="mr-2 h-4 w-4" aria-hidden="true" /> Notifications
          </NavLink>
          {/* Last in Operate on purpose: it is the screen you visit when something is refused, not
              one you work in daily. It renders in both editions — self-hosted shows real usage
              counts against "Unlimited", which is useful capacity information. */}
          <NavLink href="/plan">
            <Gauge className="mr-2 h-4 w-4" aria-hidden="true" /> Plan &amp; usage
          </NavLink>

          {me.is_platform_admin ? (
            <>
              <div className="mt-4 px-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Platform
              </div>
              <NavLink href="/orgs">
                <Building2 className="mr-2 h-4 w-4" aria-hidden="true" /> Organizations
              </NavLink>
              <NavLink href="/platform">
                <BarChart3 className="mr-2 h-4 w-4" aria-hidden="true" /> Platform usage
              </NavLink>
              <NavLink href="/status">
                <HeartPulse className="mr-2 h-4 w-4" aria-hidden="true" /> System status
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
