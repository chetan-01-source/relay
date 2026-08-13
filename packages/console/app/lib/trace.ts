/**
 * Trace roll-up — PURE, so the aggregation is unit-tested without a gateway.
 *
 * One request id can produce several settle events (a cache hit and the upstream call that filled it
 * share a trace id), so the detail page needs both the ordered timeline and a total across it.
 */
import type { TrafficEvent } from './api';

export interface TraceSummary {
  /** Events oldest-first, so the page reads as a timeline. */
  ordered: TrafficEvent[];
  events: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Wall-clock latency of the slowest event, or null when none reported one. */
  latencyMs: number | null;
  /** The trace's overall outcome (see below). */
  status: string;
  /** ISO timestamp of the first event, or '' when none carried one. */
  startedAt: string;
}

/**
 * Aggregate the events of one trace.
 *
 * Status is the *worst* outcome, not the last: a trace whose upstream call failed and then succeeded
 * on retry still contains a failure worth seeing, and a header that said "ok" would hide it. Cost and
 * tokens sum across events because that is what the request actually consumed.
 *
 * Latency is the maximum rather than the sum — events overlap (a cache lookup happens inside the
 * request the upstream call also belongs to), so adding them would overstate how long the caller
 * waited.
 */
export function traceSummary(events: readonly TrafficEvent[]): TraceSummary {
  const ordered = [...events].sort((a, b) =>
    (a.created_at ?? '').localeCompare(b.created_at ?? ''),
  );

  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let latencyMs: number | null = null;

  for (const event of ordered) {
    inputTokens += event.input_tokens ?? 0;
    outputTokens += event.output_tokens ?? 0;
    costUsd += event.cost_usd ?? 0;
    if (event.latency_ms != null) latencyMs = Math.max(latencyMs ?? 0, event.latency_ms);
  }

  return {
    ordered,
    events: ordered.length,
    inputTokens,
    outputTokens,
    costUsd,
    latencyMs,
    status: worstStatus(ordered.map((e) => e.status ?? 'ok')),
    startedAt: ordered[0]?.created_at ?? '',
  };
}

// Worst-first: a failure anywhere in the trace is the headline, and a policy rejection outranks a
// clean settle. Anything unrecognised sorts above 'ok' so a new status is never silently hidden.
const SEVERITY = ['error', 'budget_exceeded', 'rate_limited'];

/** The most severe status in the list, or 'ok' when the list is empty or all clean. */
export function worstStatus(statuses: readonly string[]): string {
  for (const candidate of SEVERITY) {
    if (statuses.includes(candidate)) return candidate;
  }
  const unknown = statuses.find((s) => s !== 'ok');
  return unknown ?? 'ok';
}
