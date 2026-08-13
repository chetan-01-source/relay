'use client';

/**
 * A timestamp rendered in the READER's timezone.
 *
 * Why a client component at all: Server Components run in the gateway's process, which in production
 * is a container at UTC. `toLocaleString()` there formats in the *server's* zone, so the console
 * would show UTC to a reader who assumes local — silently, and only once deployed.
 *
 * Why there is no hydration mismatch: the first render is `utcLabel`, which is byte-identical on the
 * server and in the browser. The switch to local time happens in an effect, i.e. *after* hydration,
 * so React compares two identical trees. That is deliberately different from formatting locally
 * during render and papering over the difference with `suppressHydrationWarning`, which suppresses
 * the symptom rather than removing the cause.
 *
 * Before JS runs — and with JS disabled — the UTC label stands on its own because it says "UTC".
 */
import { useEffect, useState } from 'react';
import { utcLabel, localLabel, type TimeMode } from '../app/lib/datetime';

export interface LocalTimeProps {
  /** ISO-8601 instant from the API. */
  iso: string | null | undefined;
  /** `datetime` (default) for full timestamps, `time` for a compact live feed. */
  mode?: TimeMode;
  className?: string;
}

export function LocalTime({ iso, mode = 'datetime', className }: LocalTimeProps) {
  const [label, setLabel] = useState(() => utcLabel(iso, mode));

  useEffect(() => {
    setLabel(localLabel(iso, mode));
  }, [iso, mode]);

  if (!iso) return <span className={className}>—</span>;

  // The machine-readable instant stays on the element, so the exact value is always recoverable
  // from the DOM (and on hover) regardless of which label is showing.
  return (
    <time dateTime={iso} title={iso} className={className}>
      {label}
    </time>
  );
}
