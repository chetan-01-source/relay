/**
 * Analytics request/response helpers (Week 3 Day 12) — PURE, so they are exhaustively unit-testable.
 * These enforce the query-param contract (group_by allowlist, ISO time window, output format) and
 * render the CSV export. Keeping them here (not in the controller) makes the boundary logic testable
 * and the controller a thin HTTP shell. Validation failures throw the shared RelayError.
 */
import { RelayError } from '@relay/shared';
import { USAGE_GROUP_BY, type UsageBucket, type UsageGroupBy } from '../types/analytics.types.js';

/** Validate `group_by` against the allowlist; default is `model`. Throws 400 on anything else — the
 * value is never passed to SQL as text (the query maps this enum to a fixed column). */
export function parseGroupBy(raw: string | undefined): UsageGroupBy {
  if (raw === undefined) return 'model';
  if ((USAGE_GROUP_BY as readonly string[]).includes(raw)) return raw as UsageGroupBy;
  throw new RelayError('invalid_request', {
    message: `group_by must be one of: ${USAGE_GROUP_BY.join(', ')}.`,
    param: 'group_by',
  });
}

/** Validate the optional ISO time window. A malformed timestamp fails loud (400) rather than being
 * silently dropped — an operator querying a bad range should know, not get the whole table. */
export function parseWindow(query: { from?: string; to?: string }): { from?: string; to?: string } {
  const out: { from?: string; to?: string } = {};
  if (query.from !== undefined) out.from = validTimestamp(query.from, 'from');
  if (query.to !== undefined) out.to = validTimestamp(query.to, 'to');
  return out;
}

function validTimestamp(value: string, param: string): string {
  if (Number.isNaN(Date.parse(value))) {
    throw new RelayError('invalid_request', {
      message: `${param} must be an ISO-8601 timestamp.`,
      param,
    });
  }
  return value;
}

/** Normalize the `format` param to 'json' | 'csv' (default json). Throws 400 on anything else. */
export function parseFormat(raw: string | undefined): 'json' | 'csv' {
  if (raw === undefined || raw === 'json') return 'json';
  if (raw === 'csv') return 'csv';
  throw new RelayError('invalid_request', {
    message: 'format must be one of: json, csv.',
    param: 'format',
  });
}

/** Minimal RFC-4180 CSV: quote every field and double embedded quotes (model ids can contain
 * commas/quotes). The rollup aggregate is bounded (grouped rows), so a single body is correct — no
 * unbounded streaming needed. */
export function toCsv(rows: readonly UsageBucket[]): string {
  const lines = ['key,requests,input_tokens,output_tokens,cost_usd'];
  for (const r of rows) {
    lines.push(
      [
        csvField(r.key),
        String(r.requests),
        String(r.input_tokens),
        String(r.output_tokens),
        r.cost_usd.toFixed(6),
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
