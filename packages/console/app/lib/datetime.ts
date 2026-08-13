/**
 * Timestamp formatting — PURE, so both halves are unit-tested without a browser.
 *
 * Two functions on purpose, because a Server Component and the browser cannot agree:
 *
 *   • `utcLabel` is DETERMINISTIC. It renders the same bytes everywhere, so a server render and the
 *     client's first render match exactly and React never reports a hydration mismatch.
 *   • `localLabel` is timezone-dependent and must only ever run in the browser, after mount.
 *
 * The bug this exists to fix: Server Components called `toLocaleString()` directly. On a laptop that
 * looks right, because the dev server shares the developer's timezone. In production the gateway
 * runs in a container at UTC, so every timestamp in the console would silently render in UTC while
 * the reader assumes local — the same class of confusion as a request at 00:05 IST appearing under
 * the previous day.
 */

export type TimeMode = 'datetime' | 'time';

/** True when the value parses to a real instant. Bad input renders as an em dash, never "Invalid Date". */
function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The server-safe rendering: explicit UTC, identical in every environment.
 *
 * Labelled `UTC` rather than left ambiguous — an unlabelled timestamp that is not local time is
 * exactly what caused the confusion this module addresses.
 */
export function utcLabel(iso: string | null | undefined, mode: TimeMode = 'datetime'): string {
  const date = parse(iso);
  if (!date) return '—';
  const stamp = date.toISOString(); // 2026-08-10T00:05:20.509Z
  return mode === 'time'
    ? `${stamp.slice(11, 19)} UTC`
    : `${stamp.slice(0, 10)} ${stamp.slice(11, 16)} UTC`;
}

/** The browser rendering: the reader's own timezone. Only safe after mount. */
export function localLabel(iso: string | null | undefined, mode: TimeMode = 'datetime'): string {
  const date = parse(iso);
  if (!date) return '—';
  return mode === 'time' ? date.toLocaleTimeString() : date.toLocaleString();
}
