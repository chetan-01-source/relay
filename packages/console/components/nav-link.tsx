'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '../app/lib/utils';

/** A sidebar link that highlights when the current path is at or under its href. */
export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      // aria-current is what tells a screen reader which item is selected — the colour change alone
      // is invisible to one, and UI-THEME.md §4 forbids colour as the only indicator.
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        active
          ? 'bg-secondary text-secondary-foreground'
          : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
      )}
    >
      {children}
    </Link>
  );
}
