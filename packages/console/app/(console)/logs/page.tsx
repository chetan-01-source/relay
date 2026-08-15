/**
 * Request logs — the whole history, searchable.
 *
 * Live traffic answers "what is happening now": it tails the event bus and holds the last 50 in
 * memory, so anything older is simply gone from the UI. That is the right shape for watching a
 * deploy and the wrong one for answering "what did this key do on Tuesday", which is what an
 * operator needs during an incident or a billing dispute.
 *
 * The rows come from the same `usage_events` table the live feed publishes from, so nothing new is
 * stored — this is a second view over data that was always there but unreachable past the first 50.
 *
 * Filter and cursor state live in the URL, matching the analytics and budgets pages: a filtered view
 * is shareable, survives a reload, and the Back button steps back through pages.
 */
import Link from 'next/link';
import { ScrollText } from 'lucide-react';
import { requireOrg } from '../../lib/auth';
import { searchLogs, listApps } from '../../lib/api';
import { formatUsd } from '../../lib/usage';
import { statusTone } from '../../lib/logs';
import { LocalTime } from '../../../components/local-time';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '../../../components/ui/table';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

const selectClass =
  'flex h-9 w-full cursor-pointer rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

interface LogFilters {
  q?: string;
  status?: string;
  app_id?: string;
  from?: string;
  to?: string;
  before?: string;
  before_id?: string;
}

/** The filter keys that survive a "start over" — everything except the paging cursor. */
const FILTER_KEYS = ['q', 'status', 'app_id', 'from', 'to'] as const;

/** A link to this page carrying the current filters plus whatever `extra` adds (the next cursor). */
function logsHref(filters: LogFilters, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  const query = params.toString();
  return query ? `/logs?${query}` : '/logs';
}

export default async function LogsPage({ searchParams }: { searchParams: Promise<LogFilters> }) {
  await requireOrg();
  const filters = await searchParams;

  const [page, apps] = await Promise.all([
    searchLogs({
      limit: String(PAGE_SIZE),
      q: filters.q,
      status: filters.status,
      app_id: filters.app_id,
      // The picker gives a date; the API wants an instant. `to` is exclusive at the API, so the end
      // of the chosen day is the start of the next one — an inclusive-looking filter without any
      // last-second-of-the-day arithmetic.
      from: filters.from ? `${filters.from}T00:00:00.000Z` : undefined,
      to: filters.to ? `${nextDay(filters.to)}T00:00:00.000Z` : undefined,
      before: filters.before,
      before_id: filters.before_id,
    }).catch(() => ({ data: [], next_cursor: null })),
    listApps().catch(() => ({ data: [] })),
  ]);

  const events = page.data ?? [];
  const cursor = page.next_cursor ?? null;
  const appList = apps.data ?? [];
  const paging = Boolean(filters.before);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Logs</h1>
          <p className="text-sm text-muted-foreground">
            Every metered request, oldest reachable. Live traffic shows only the most recent 50 as
            they arrive — this is the full history.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/traffic">Live traffic</Link>
        </Button>
      </div>

      <Card>
        <CardContent className="pt-6">
          {/* GET, so every filter lands in the URL. Paging resets whenever a filter changes: the
              cursor points into the OLD result set and would silently skip rows. */}
          <form
            className="grid gap-3 md:grid-cols-[1fr_10rem_12rem_auto] md:items-end"
            method="GET"
          >
            <div className="space-y-1.5">
              <label className="text-sm" htmlFor="log-q">
                Search
              </label>
              <Input
                id="log-q"
                type="search"
                name="q"
                defaultValue={filters.q ?? ''}
                placeholder="request id or model…"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm" htmlFor="log-status">
                Status
              </label>
              <select
                id="log-status"
                name="status"
                defaultValue={filters.status ?? ''}
                className={selectClass}
              >
                <option value="">Any</option>
                <option value="ok">ok</option>
                <option value="error">error</option>
                <option value="rate_limited">rate limited</option>
                <option value="budget_exceeded">budget exceeded</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm" htmlFor="log-app">
                Application
              </label>
              <select
                id="log-app"
                name="app_id"
                defaultValue={filters.app_id ?? ''}
                className={selectClass}
              >
                <option value="">Any</option>
                {appList.map((app) => (
                  <option key={app.id} value={app.id}>
                    {app.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-2">
              <Button type="submit" variant="secondary">
                Filter
              </Button>
              <Button asChild variant="ghost">
                <Link href="/logs">Clear</Link>
              </Button>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm" htmlFor="log-from">
                From
              </label>
              <Input id="log-from" type="date" name="from" defaultValue={filters.from ?? ''} />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <label className="text-sm" htmlFor="log-to">
                To
              </label>
              <Input id="log-to" type="date" name="to" defaultValue={filters.to ?? ''} />
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ScrollText className="h-4 w-4" aria-hidden="true" />
            {events.length} {events.length === 1 ? 'request' : 'requests'}
            {paging ? <span className="text-sm text-muted-foreground">(continued)</span> : null}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No request matches these filters.{' '}
              <Link href="/logs" className="underline">
                Clear them
              </Link>{' '}
              to see everything.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Latency</TableHead>
                  <TableHead>Request</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      <LocalTime iso={event.created_at ?? ''} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{event.model}</TableCell>
                    <TableCell className="text-muted-foreground">{event.provider}</TableCell>
                    <TableCell>
                      <Badge variant={statusTone(event.status)}>{event.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {(event.input_tokens ?? 0) + (event.output_tokens ?? 0)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {formatUsd(Number(event.cost_usd ?? 0))}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {event.latency_ms ?? 0}ms
                    </TableCell>
                    <TableCell>
                      {/* Full id, monospaced: an operator copies this into a trace lookup. */}
                      <span className="font-mono text-xs text-muted-foreground">
                        {event.request_id}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        {paging ? (
          <Button asChild variant="outline">
            <Link href={logsHref(filters)}>Newest first</Link>
          </Button>
        ) : (
          <span />
        )}
        {cursor?.before && cursor.before_id ? (
          <Button asChild variant="outline">
            <Link href={logsHref(filters, { before: cursor.before, before_id: cursor.before_id })}>
              Older →
            </Link>
          </Button>
        ) : (
          <span className="text-sm text-muted-foreground">End of the log.</span>
        )}
      </div>
    </div>
  );
}

/** The day after `YYYY-MM-DD`, in UTC — turns an inclusive end date into the exclusive bound. */
function nextDay(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}
