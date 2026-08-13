import Link from 'next/link';
import { cn } from '../../app/lib/utils';
import { shortId, type Labelled } from '../../app/lib/labels';

export interface LabelledIdProps {
  value: Labelled;
  /** Optional link for the name (e.g. through to the application or route). */
  href?: string;
  /** Shown when there is no id at all (a deleted or never-set reference). */
  fallback?: string;
  className?: string;
}

/**
 * Renders a resolved id as **name** with its raw id beneath.
 *
 * Both halves are deliberate: the name is what a human recognises, the id is what they need to paste
 * into a log search or a support ticket. Showing only the name would make the screen unactionable;
 * showing only the id is what made these screens unreadable in the first place.
 *
 * An id that resolves to nothing still renders — as the id alone, not "—". A row referencing a
 * deleted application is a real thing that happened, and hiding the reference would lose the trail.
 * The full id is always in `title`, so it can be read even when truncated.
 */
export function LabelledId({ value, href, fallback = '—', className }: LabelledIdProps) {
  if (!value.id && !value.name) {
    return <span className={cn('text-muted-foreground', className)}>{fallback}</span>;
  }

  // Nothing to resolve against (model/day buckets) — the name is the whole story.
  if (value.name && !value.id) {
    return <span className={cn('font-medium', className)}>{value.name}</span>;
  }

  const name = value.name ?? (
    <span className="text-muted-foreground" title="This id no longer resolves to a named resource">
      unknown
    </span>
  );

  return (
    <span className={cn('flex flex-col leading-tight', className)}>
      <span className="font-medium">
        {href ? (
          <Link href={href} className="hover:underline">
            {name}
          </Link>
        ) : (
          name
        )}
      </span>
      <span className="font-mono text-xs text-muted-foreground" title={value.id}>
        {shortId(value.id)}
      </span>
    </span>
  );
}
