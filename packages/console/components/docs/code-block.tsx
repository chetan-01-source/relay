/**
 * A code sample with a copy button.
 *
 * Deliberately NOT syntax-highlighted. A highlighter is ~40KB of client JavaScript on pages whose
 * whole job is to load fast and be read, and on our single-accent palette a rainbow of token colours
 * would break the design system's one rule (UI-THEME §4). Structure comes from the label bar and the
 * monospace face instead.
 *
 * A server component; only the copy button is interactive. `overflow-x-auto` on the `<pre>` keeps a
 * long line scrolling inside its own box rather than widening the page — the one thing that reliably
 * ruins docs on a phone.
 */
import { CopyButton } from '../copy-button';

export function CodeBlock({
  code,
  label,
  /** Turn off when the sample is illustrative output rather than something to run. */
  copyable = true,
}: {
  code: string;
  label?: string;
  copyable?: boolean;
}) {
  return (
    <figure className="overflow-hidden rounded-lg border bg-muted/40">
      {label ? (
        <figcaption className="flex items-center justify-between gap-3 border-b px-4 py-2">
          <span className="font-mono text-xs text-muted-foreground">{label}</span>
          {copyable ? <CopyButton value={code} size="icon" label={`Copy ${label}`} /> : null}
        </figcaption>
      ) : null}
      <div className="relative">
        {!label && copyable ? (
          <div className="absolute right-2 top-2 z-10">
            <CopyButton value={code} size="icon" label="Copy code" />
          </div>
        ) : null}
        <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed md:text-[13px]">
          <code>{code}</code>
        </pre>
      </div>
    </figure>
  );
}

/** A short inline note. Two tones only — anything more and the page turns into a wall of boxes. */
export function Callout({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warning';
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-lg border-l-2 bg-muted/40 p-4 text-sm leading-relaxed ${
        tone === 'warning' ? 'border-l-amber-500' : 'border-l-primary'
      }`}
    >
      {title ? <p className="mb-1 font-medium">{title}</p> : null}
      <div className="text-muted-foreground [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4">
        {children}
      </div>
    </div>
  );
}
