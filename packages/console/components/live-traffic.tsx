'use client';

/**
 * Live-traffic table. Two sources, one list: the server seeds recent history from
 * `GET /api/v1/traffic` (so the table is never blank on arrival — it used to sit empty until the next
 * request happened), and an EventSource on the same-origin SSE proxy appends events as they settle.
 *
 * Rows are de-duplicated by id+timestamp and capped, so a tab left open overnight doesn't grow
 * without bound. The status filter is applied to live events with the same predicate the server used
 * for the seed (lib/traffic.ts), so the two halves of the list always agree.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { TrafficEvent } from '../app/lib/api';
import { mergeEvent, statusVariant, type TrafficStatus } from '../app/lib/traffic';
import { formatUsd } from '../app/lib/usage';
import { LabelledId } from './ui/labelled-id';
import { LocalTime } from './local-time';
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from './ui/table';
import { Badge } from './ui/badge';

const MAX_ROWS = 200;

export interface LiveTrafficProps {
  /** Recent requests fetched server-side, newest first — the table's starting state. */
  initialEvents: TrafficEvent[];
  /** The active status filter, or null for "all". Live events are filtered to match. */
  filter: TrafficStatus | null;
  /**
   * id → name for the routes and applications events reference, resolved server-side. Passed as
   * plain objects rather than Maps because this crosses the server/client boundary, where only
   * JSON-serialisable values survive.
   */
  routeNames: Record<string, string>;
  appNames: Record<string, string>;
}

export function LiveTraffic({ initialEvents, filter, routeNames, appNames }: LiveTrafficProps) {
  const [events, setEvents] = useState<TrafficEvent[]>(initialEvents);
  const [connected, setConnected] = useState(false);

  // The seed is re-fetched by the server whenever the filter changes (it is a URL param), so reset
  // the list to the new seed rather than merging two filters' worth of rows.
  useEffect(() => {
    setEvents(initialEvents);
  }, [initialEvents]);

  useEffect(() => {
    const source = new EventSource('/api/traffic/stream');
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (e: MessageEvent<string>) => {
      let event: TrafficEvent;
      try {
        event = JSON.parse(e.data) as TrafficEvent;
      } catch {
        return;
      }
      setEvents((prev) => mergeEvent(prev, event, { filter, max: MAX_ROWS }));
    };
    return () => source.close();
  }, [filter]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span
          className={`inline-block size-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-muted-foreground'}`}
          aria-hidden="true"
        />
        <span role="status">{connected ? 'Live' : 'Connecting…'}</span>
        <span>· {events.length} requests</span>
      </div>
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No requests yet. Send one from the{' '}
          <Link href="/playground" className="underline">
            playground
          </Link>{' '}
          or call <code>/v1/chat/completions</code> directly.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Route</TableHead>
              <TableHead>Application</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Latency</TableHead>
              <TableHead>Request</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((e, i) => (
              <TableRow key={`${e.id}-${i}`}>
                <TableCell className="text-xs text-muted-foreground">
                  <LocalTime iso={e.created_at} mode="time" />
                </TableCell>
                <TableCell className="font-medium">{e.model}</TableCell>
                <TableCell>
                  <LabelledId
                    value={{ name: routeNames[e.route_id ?? ''] ?? null, id: e.route_id ?? '' }}
                    {...(e.route_id ? { href: `/routes/${e.route_id}` } : {})}
                  />
                </TableCell>
                <TableCell>
                  <LabelledId
                    value={{ name: appNames[e.app_id ?? ''] ?? null, id: e.app_id ?? '' }}
                    {...(e.app_id ? { href: `/apps/${e.app_id}` } : {})}
                  />
                </TableCell>
                <TableCell className="text-muted-foreground">{e.provider ?? '—'}</TableCell>
                <TableCell>
                  <Badge variant={statusVariant(e.status ?? 'ok')}>{e.status}</Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {(e.input_tokens ?? 0) + (e.output_tokens ?? 0)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {formatUsd(e.cost_usd ?? 0)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {e.latency_ms != null ? `${e.latency_ms}ms` : '—'}
                </TableCell>
                <TableCell>
                  <Link
                    href={`/traffic/${encodeURIComponent(e.request_id ?? '')}`}
                    className="font-mono text-xs hover:underline"
                  >
                    {(e.request_id ?? '').slice(0, 12)}…
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
