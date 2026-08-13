import Link from 'next/link';
import { cn } from '../../app/lib/utils';

export interface SegmentedNavOption {
  /** Display text. */
  label: string;
  /** Where this segment navigates. */
  href: string;
  /** Whether this segment is the current view. */
  active: boolean;
}

export interface SegmentedNavProps {
  /** Announced group name, e.g. "Group usage by" — required, since the control has no visible label. */
  label: string;
  options: SegmentedNavOption[];
  className?: string;
}

/**
 * A row of mutually-exclusive filter links styled as a segmented control (analytics grouping, traffic
 * status). Links rather than buttons on purpose: the selection is URL state, so each segment is
 * shareable, works with Back, and needs no client JavaScript.
 *
 * `aria-current` carries the selection for screen readers — the fill colour alone would make it the
 * only indicator, which UI-THEME.md §4 forbids.
 */
export function SegmentedNav({ label, options, className }: SegmentedNavProps) {
  return (
    <nav
      aria-label={label}
      className={cn('flex flex-wrap gap-1 rounded-md border border-input p-1', className)}
    >
      {options.map((option) => (
        <Link
          key={option.label}
          href={option.href}
          aria-current={option.active ? 'page' : undefined}
          className={cn(
            'cursor-pointer rounded px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            option.active
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
          )}
        >
          {option.label}
        </Link>
      ))}
    </nav>
  );
}
