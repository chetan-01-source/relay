'use client';

/**
 * Live-traffic table (Day 13 · FE-1). Subscribes to the same-origin SSE proxy (/api/traffic/stream)
 * via EventSource and renders the most recent requests, newest first. Rows are de-duplicated by id
 * and the list is capped so a long-lived tab never grows unbounded. Each row links to its trace.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { TrafficEvent } from '../app/lib/api';
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from './ui/table';
import { Badge } from './ui/badge';

const MAX_ROWS = 200;

function statusVariant(status: string): 'success' | 'destructive' | 'secondary' {
  if (status === 'ok') return 'success';
  if (status === 'error') return 'destructive';
  return 'secondary'; // rate_limited | budget_exceeded
}

export function LiveTraffic() {
  const [events, setEvents] = useState<TrafficEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const seen = useRef<Set<string>>(new Set());

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
      const key = `${event.id}:${event.created_at}`;
      if (seen.current.has(key)) return;
      seen.current.add(key);
      setEvents((prev) => [event, ...prev].slice(0, MAX_ROWS));
    };
    return () => source.close();
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span
          className={`inline-block size-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-muted-foreground'}`}
        />
        {connected ? 'Live' : 'Connecting…'}
        <span>· {events.length} events</span>
      </div>
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Waiting for requests. Make a call to <code>/v1/chat/completions</code> to see traffic.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Latency</TableHead>
              <TableHead>Request</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((e, i) => (
              <TableRow key={`${e.id}-${i}`}>
                <TableCell className="text-xs text-muted-foreground">
                  {new Date(e.created_at ?? '').toLocaleTimeString()}
                </TableCell>
                <TableCell className="font-medium">{e.model}</TableCell>
                <TableCell>
                  <Badge variant={statusVariant(e.status ?? 'ok')}>{e.status}</Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {(e.input_tokens ?? 0) + (e.output_tokens ?? 0)}
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
