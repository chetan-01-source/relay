'use client';

/**
 * The landing page's top bar. Sticky and blurred, as in the reference — but on our tokens, so it
 * works in both themes instead of assuming a black page.
 *
 * A client component for exactly one reason: the mobile menu's open/closed state. Everything else on
 * this page is server-rendered.
 *
 * Two details the reference gets wrong and this does not:
 *   • Its links are absolutely centred with `left-1/2 -translate-x-1/2`, which overlaps the logo the
 *     moment either side grows. A three-column grid centres them without overlap at any width.
 *   • Its mobile menu leaves focus behind on the trigger and traps nothing. Here Escape closes,
 *     focus returns to the trigger, and the trigger carries `aria-expanded`/`aria-controls`.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';
import { signInAction } from '../../app/actions';
import { RelayLogo } from '../brand/relay-logo';
import { ThemeToggle } from '../theme-toggle';
import { Button } from '../ui/button';

/**
 * `section` entries are anchors on the LANDING page; `route` entries are real pages.
 *
 * The distinction matters because this nav is rendered on the docs pages too. A bare `#faq` there
 * resolves against `/docs/whatever` — a fragment that does not exist on that page — so the link
 * silently does nothing. Every section link is therefore resolved against `/` whenever we are not
 * already on `/` (see `hrefFor`).
 */
interface NavItem {
  /** Fragment id for a section, or a path for a route. */
  target: string;
  label: string;
  kind: 'section' | 'route';
}

const ITEMS: NavItem[] = [
  { target: 'capabilities', label: 'Capabilities', kind: 'section' },
  // MVP-FREE: Relay is free for everyone during the trial, so there is no pricing section to point
  // at (see app/page.tsx). Restore this line together with that section to switch selling back on;
  // `showPricing` already gates it, so it stays correct either way.
  // { target: 'pricing', label: 'Pricing', kind: 'section' },
  { target: '/docs', label: 'Docs', kind: 'route' },
  { target: 'self-host', label: 'Self-host', kind: 'section' },
  { target: 'faq', label: 'FAQ', kind: 'section' },
];

export function LandingNav({
  signedIn,
  /**
   * Whether the landing page has a pricing section to point at. Passed in rather than read from the
   * environment here: this is a client component, and a `NEXT_PUBLIC_` variable would be a second
   * edition switch to keep in sync with the server's `RELAY_EDITION`.
   */
  showPricing = false,
}: {
  signedIn: boolean;
  showPricing?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();
  const onLanding = pathname === '/';

  const links = ITEMS.filter((item) => showPricing || item.target !== 'pricing').map((item) => ({
    label: item.label,
    // On the landing page a bare fragment keeps the in-page scroll (and the URL tidy). Anywhere
    // else it has to name the page it belongs to, or it is a link to nothing.
    href: item.kind === 'route' ? item.target : onLanding ? `#${item.target}` : `/#${item.target}`,
    // A cross-page jump is a navigation, so it goes through the router; a same-page anchor stays a
    // plain <a> and lets the browser do the scrolling it already does well.
    route: item.kind === 'route' || !onLanding,
  }));

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <nav
        aria-label="Main"
        className="mx-auto grid max-w-6xl grid-cols-[auto_1fr_auto] items-center gap-4 px-6 py-3"
      >
        <Link
          href="/"
          className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <RelayLogo />
          <span className="sr-only">Relay home</span>
        </Link>

        <div className="hidden items-center justify-center gap-7 md:flex">
          {links.map((link) =>
            link.route ? (
              <Link
                key={link.href}
                href={link.href}
                className="rounded-sm text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {link.label}
              </Link>
            ) : (
              <a
                key={link.href}
                href={link.href}
                className="rounded-sm text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {link.label}
              </a>
            ),
          )}
        </div>

        <div className="hidden items-center gap-2 md:flex">
          <ThemeToggle />
          {signedIn ? (
            <Button asChild size="sm">
              <Link href="/dashboard">Open console</Link>
            </Button>
          ) : (
            // The server action is imported directly into this client component — a real form post,
            // so signing in works with JavaScript disabled and needs no throwaway `?signin=1` route.
            <form action={signInAction}>
              <Button type="submit" size="sm">
                Sign in
              </Button>
            </form>
          )}
        </div>

        <div className="flex items-center justify-end gap-1 md:hidden">
          <ThemeToggle />
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls="landing-mobile-menu"
            aria-label={open ? 'Close menu' : 'Open menu'}
            className="inline-flex size-9 cursor-pointer items-center justify-center rounded-md text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
      </nav>

      {open ? (
        <div
          id="landing-mobile-menu"
          className="border-t border-border/60 bg-background/95 backdrop-blur-md md:hidden"
        >
          <div className="mx-auto flex max-w-6xl flex-col gap-1 px-6 py-4">
            {links.map((link) =>
              link.route ? (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="rounded-md px-2 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {link.label}
                </Link>
              ) : (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="rounded-md px-2 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {link.label}
                </a>
              ),
            )}
            <div className="mt-3 flex flex-col gap-2 border-t border-border/60 pt-4">
              {signedIn ? (
                <Button asChild size="sm">
                  <Link href="/dashboard">Open console</Link>
                </Button>
              ) : (
                <form action={signInAction}>
                  <Button type="submit" size="sm" className="w-full">
                    Sign in
                  </Button>
                </form>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </header>
  );
}
