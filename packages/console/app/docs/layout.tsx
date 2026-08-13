/**
 * The documentation shell.
 *
 * PUBLIC — outside the `(console)` group, so it never calls `requireUser()`. Docs that demand a
 * login are docs nobody evaluating the product can read, and this is the surface a developer hits
 * first, often from a search result.
 *
 * DESIGN NOTES (docs/UI-THEME.md):
 *  • Reuses the landing page's sticky blurred nav, so moving between marketing and docs does not
 *    feel like leaving the site. `pt-16` compensates for its fixed height — content must never sit
 *    behind it (§4).
 *  • Two columns on large screens: a sidebar of ordered sections, and a prose column capped at
 *    ~72ch. Anything wider stops being readable, which is the whole job here.
 *  • Server-rendered. The only client JavaScript on any docs page is the sidebar's active-link
 *    highlight, the theme toggle, the mobile menu and the copy buttons.
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { getLogtoContext } from '@logto/next/server-actions';
import { logtoConfig, logtoConfigured } from '../lib/logto';
import { isCloud } from '../lib/edition';
import { LandingNav } from '../../components/landing/landing-nav';
import { DocsNav } from '../../components/docs/docs-nav';
import { RelayMark } from '../../components/brand/relay-logo';

// The nav reflects auth state, which is per-request.
export const dynamic = 'force-dynamic';

export default async function DocsLayout({ children }: { children: ReactNode }) {
  let signedIn = false;
  if (logtoConfigured) {
    try {
      signedIn = (await getLogtoContext(logtoConfig)).isAuthenticated;
    } catch {
      signedIn = false;
    }
  }

  return (
    <>
      <a
        href="#doc-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:text-primary-foreground"
      >
        Skip to content
      </a>

      <LandingNav signedIn={signedIn} showPricing={isCloud} />

      <div className="mx-auto grid max-w-6xl gap-10 px-6 pb-20 pt-24 lg:grid-cols-[15rem_minmax(0,1fr)]">
        {/* `self-start` + `sticky` keeps the sidebar in view without it becoming its own scroll
            container — nested scrollbars are the fastest way to make docs feel broken. */}
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <DocsNav />
        </aside>

        <main id="doc-content" className="min-w-0">
          {children}

          <footer className="mt-16 flex flex-wrap items-center justify-between gap-4 border-t pt-8 text-sm">
            <span className="inline-flex items-center gap-2 text-muted-foreground">
              <RelayMark className="size-5 text-primary" />
              Relay Gateway
            </span>
            <nav aria-label="Documentation footer" className="flex items-center gap-6">
              <Link
                href="/"
                className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Home
              </Link>
              <a
                href="https://github.com/chetan-01-source/relay"
                className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                GitHub
              </a>
              <Link
                href="/dashboard"
                className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Console
              </Link>
            </nav>
          </footer>
        </main>
      </div>
    </>
  );
}
