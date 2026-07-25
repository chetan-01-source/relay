/**
 * SSE proxy for the live-traffic feed (Day 13 · FE-1). A browser EventSource can't attach an
 * Authorization header, so this same-origin Next route handler fetches the gateway's authenticated
 * SSE stream (bearer added server-side from the Logto session) and pipes the body straight through.
 */
import { trafficStreamUpstream } from '../../../lib/api';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const { url, authorization } = await trafficStreamUpstream();
  const upstream = await fetch(url, {
    headers: { authorization, accept: 'text/event-stream' },
    cache: 'no-store',
  });
  if (!upstream.ok || !upstream.body) {
    return new Response('event: error\ndata: upstream unavailable\n\n', {
      status: 502,
      headers: { 'content-type': 'text/event-stream' },
    });
  }
  return new Response(upstream.body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}
