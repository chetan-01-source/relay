'use client';

/**
 * The docs sidebar.
 *
 * A client component for one reason: it needs `usePathname` to mark the current page. It does NOT
 * use the console's `NavLink`, which treats a prefix match as active — that would light up
 * "Overview" (`/docs`) on every page in the section. Docs links match exactly.
 *
 * On small screens the same list becomes a `<details>` disclosure rather than a JS drawer: it is
 * keyboard-operable, findable by in-page search, and works before hydration.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '../../app/lib/utils';

export interface DocsNavItem {
  href: string;
  label: string;
}

export interface DocsNavGroup {
  title: string;
  items: DocsNavItem[];
}

/** Ordered the way somebody actually adopts the gateway: try it → integrate → operate → run it. */
export const DOCS_NAV: DocsNavGroup[] = [
  {
    title: 'Getting started',
    items: [
      { href: '/docs', label: 'Overview' },
      { href: '/docs/quickstart', label: 'Quickstart' },
    ],
  },
  {
    title: 'Integrate',
    items: [
      { href: '/docs/sdk', label: 'TypeScript SDK' },
      { href: '/docs/errors', label: 'Errors & headers' },
      { href: '/docs/api', label: 'API reference' },
    ],
  },
  {
    title: 'Operate',
    items: [{ href: '/docs/plans', label: 'Plans & quotas' }],
  },
  {
    title: 'Run it yourself',
    items: [{ href: '/docs/self-host', label: 'Self-hosting' }],
  },
];

export function DocsNav() {
  const pathname = usePathname();

  const list = (
    <nav aria-label="Documentation" className="space-y-6">
      {DOCS_NAV.map((group) => (
        <div key={group.title}>
          <p className="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {group.title}
          </p>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const active = pathname === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    // aria-current, not just a colour: the fill alone is invisible to a screen
                    // reader and UI-THEME §4 forbids colour as the only indicator.
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'block rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active
                        ? 'bg-secondary font-medium text-secondary-foreground'
                        : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <>
      <div className="hidden lg:block">{list}</div>

      <details className="group rounded-lg border lg:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Documentation
          <span
            className="text-muted-foreground transition-transform group-open:rotate-45"
            aria-hidden="true"
          >
            +
          </span>
        </summary>
        <div className="border-t p-3">{list}</div>
      </details>
    </>
  );
}
