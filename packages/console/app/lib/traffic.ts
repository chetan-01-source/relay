/**
 * Traffic-feed view model — PURE, shared by the server page (which seeds history via
 * `GET /api/v1/traffic?status=`) and the client table (which applies the same filter to live SSE
 * events). One definition of the status set means the seeded rows and the streamed rows can never
 * disagree about what a filter means.
 */
import type { TrafficEvent } from './api';

/** The settle statuses the metering path records. Mirrors the endpoint's `status` enum. */
export const TRAFFIC_STATUSES = ['ok', 'error', 'rate_limited', 'budget_exceeded'] as const;

export type TrafficStatus = (typeof TRAFFIC_STATUSES)[number];

/** Narrow an untrusted query-string value; anything else means "no filter". */
export function parseStatus(value: string | null | undefined): TrafficStatus | null {
  return (TRAFFIC_STATUSES as readonly string[]).includes(value ?? '')
    ? (value as TrafficStatus)
    : null;
}

/** The badge variant for a settle status. Only `ok` is success; the rest are failures of different
 * kinds, and rate/budget rejections are policy outcomes rather than errors. */
export function statusVariant(status: string): 'success' | 'destructive' | 'secondary' {
  if (status === 'ok') return 'success';
  if (status === 'error') return 'destructive';
  return 'secondary';
}

/** Merge a live event into the feed: newest first, de-duplicated, capped, and honouring the filter.
 * Returns the original array when nothing changes so React can skip the re-render. */
export function mergeEvent(
  events: readonly TrafficEvent[],
  incoming: TrafficEvent,
  options: { filter: TrafficStatus | null; max: number },
): TrafficEvent[] {
  if (options.filter && incoming.status !== options.filter) return events as TrafficEvent[];
  const key = `${incoming.id}:${incoming.created_at}`;
  if (events.some((event) => `${event.id}:${event.created_at}` === key)) {
    return events as TrafficEvent[];
  }
  return [incoming, ...events].slice(0, options.max);
}
