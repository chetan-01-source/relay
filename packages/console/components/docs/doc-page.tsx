/**
 * Shared page furniture for the docs: the header block and the section heading.
 *
 * Every heading gets a stable `id` so any sentence in the docs is linkable — the thing you need most
 * when answering "where is that documented" in a support thread. The anchor is a real link, visible
 * on hover and on keyboard focus rather than hover-only, so a keyboard user can reach it too.
 */
import type { ReactNode } from 'react';
import { Link as LinkIcon } from 'lucide-react';

export function DocHeader({
  eyebrow,
  title,
  lede,
}: {
  eyebrow?: string;
  title: string;
  lede: string;
}) {
  return (
    <header className="mb-10">
      {eyebrow ? (
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {eyebrow}
        </p>
      ) : null}
      <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">{title}</h1>
      {/* max-w-prose, not the column width: 65–75 characters is where a line stops being work. */}
      <p className="mt-3 max-w-prose text-base leading-relaxed text-muted-foreground">{lede}</p>
    </header>
  );
}

export function DocSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 border-t pt-10 first:border-t-0 first:pt-0">
      <h2 className="group flex items-center gap-2 text-xl font-semibold tracking-tight">
        {title}
        <a
          href={`#${id}`}
          aria-label={`Link to ${title}`}
          className="rounded-sm text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
        >
          <LinkIcon className="size-4" aria-hidden="true" />
        </a>
      </h2>
      <div className="mt-4 space-y-4 text-sm leading-relaxed text-muted-foreground [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 [&_code]:font-mono [&_code]:text-[0.9em] [&_code]:text-foreground [&_strong]:font-medium [&_strong]:text-foreground">
        {children}
      </div>
    </section>
  );
}

/** The stack of sections on a docs page — one rhythm, set once. */
export function DocBody({ children }: { children: ReactNode }) {
  return <div className="space-y-10">{children}</div>;
}

/** A two-column definition list; the shape most reference content actually wants. */
export function DocList({ rows }: { rows: Array<{ term: ReactNode; detail: ReactNode }> }) {
  return (
    <dl className="divide-y rounded-lg border">
      {rows.map((row, index) => (
        <div key={index} className="grid gap-1 p-4 sm:grid-cols-[14rem_minmax(0,1fr)] sm:gap-4">
          <dt className="font-mono text-xs text-foreground">{row.term}</dt>
          <dd className="text-sm leading-relaxed">{row.detail}</dd>
        </div>
      ))}
    </dl>
  );
}
