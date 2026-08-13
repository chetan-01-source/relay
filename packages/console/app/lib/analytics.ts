/**
 * Analytics view model — PURE, so the grouping/window logic is unit-tested without a gateway. The
 * usage endpoints accept `group_by` (app|route|model|day) plus a `from`/`to` window and can render
 * either JSON or CSV; this module is the single place the console decides what those values are, so
 * the page, the CSV route handler and the tests cannot disagree.
 */
import type { UsageQuery } from './api';

export type Grouping = NonNullable<UsageQuery['group_by']>;

/** Every grouping the gateway supports, with the copy the segmented control renders. */
export const USAGE_GROUPINGS: readonly { value: Grouping; label: string; column: string }[] = [
  { value: 'model', label: 'Model', column: 'Model' },
  { value: 'app', label: 'Application', column: 'Application' },
  { value: 'route', label: 'Route', column: 'Route' },
  { value: 'day', label: 'Day', column: 'Date' },
];

export const DEFAULT_GROUPING: Grouping = 'model';

/** Narrow an untrusted query-string value to a supported grouping. */
export function parseGrouping(value: string | null | undefined): Grouping {
  const match = USAGE_GROUPINGS.find((g) => g.value === value);
  return match ? match.value : DEFAULT_GROUPING;
}

/** The heading for the bucket-key column, which changes meaning with the grouping. */
export function groupingColumn(grouping: Grouping): string {
  return USAGE_GROUPINGS.find((g) => g.value === grouping)?.column ?? 'Key';
}

export interface UsageWindow {
  from: string; // YYYY-MM-DD, inclusive
  to: string; // YYYY-MM-DD, inclusive
}

/** ISO date (YYYY-MM-DD) in UTC — the rollups are keyed in UTC, so the picker must be too. */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The default reporting window: the trailing `days` (inclusive of today). `today` is a parameter so
 * the function stays pure and the test doesn't depend on the clock. */
export function defaultWindow(today: Date, days = 30): UsageWindow {
  const start = new Date(today.getTime());
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { from: isoDate(start), to: isoDate(today) };
}

/** Accept a `YYYY-MM-DD` value from the query string, or fall back. Anything malformed is ignored
 * rather than forwarded — the gateway would 400, which reads as a broken page. */
export function parseDate(value: string | null | undefined, fallback: string): string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
}

/**
 * Convert the picker's window into the one the gateway expects.
 *
 * The console is inclusive end to end — "From 1 Aug To 9 Aug" means the 9th counts. The analytics
 * endpoint is not: its predicate is `hour < $to::timestamptz`, and a bare `YYYY-MM-DD` coerces to
 * MIDNIGHT. Passing the picker's date straight through therefore drops the whole of the final day —
 * including today, which is the day anyone testing actually cares about, and which made a working
 * pipeline look like it was recording nothing.
 *
 * So the inclusive end is advanced by one day to become the exclusive bound. Done here, at the one
 * boundary where the console calls the gateway, rather than by loosening the endpoint — the API's
 * half-open interval is the correct convention for a timestamp range and is already documented.
 */
export function apiWindow(window: UsageWindow): UsageWindow {
  return { from: window.from, to: nextDay(window.to) };
}

/** The day after `date` (YYYY-MM-DD), in UTC so it can't drift across a local timezone. */
function nextDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + 1));
  return isoDate(next);
}

/** Build the CSV download URL for the export button. */
export function exportHref(scope: 'org' | 'platform', query: UsageQuery): string {
  const qs = new URLSearchParams({ scope });
  if (query.group_by) qs.set('group_by', query.group_by);
  if (query.from) qs.set('from', query.from);
  if (query.to) qs.set('to', query.to);
  return `/api/analytics/export?${qs.toString()}`;
}
