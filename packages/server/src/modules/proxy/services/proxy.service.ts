/**
 * Proxy service (playbook §5) — business logic ONLY. No HTTP types, no DB. Selects the
 * adapter, calls the upstream provider, and yields provider-agnostic canonical deltas.
 * Throws RelayError on failure; the controller maps that to an HTTP response.
 *
 * Every await that BLOCKS on the external provider (the fetch, each body/chunk read) is wrapped in
 * `timed()`, which accumulates that wall-clock into `timing.upstreamMs`. Gateway CPU (adapter
 * translate, SSE parse, toDelta) is deliberately NOT timed, so the controller can subtract only the
 * provider wait and report gateway-only overhead.
 */
import { RelayError } from '@relay/shared';
import { adapterFor } from '../adapters/adapter.js';
import { parseSse } from '../lib/sse.js';
import {
  type CanonicalDelta,
  type CanonicalRequest,
  type ProxyService,
  type RequestTiming,
  type Target,
} from '../types/proxy.types.js';

/** Run fn, adding the time it was awaited to the provider-wait accumulator. */
async function timed<T>(timing: RequestTiming, fn: () => Promise<T>): Promise<T> {
  const t0 = process.hrtime.bigint();
  try {
    return await fn();
  } finally {
    timing.upstreamMs += Number(process.hrtime.bigint() - t0) / 1e6;
  }
}

async function callUpstream(
  req: CanonicalRequest,
  target: Target,
  timing: RequestTiming,
): Promise<Response> {
  const adapter = adapterFor(target.provider);
  const upstreamReq = adapter.translate(req, target);
  let res: Response;
  try {
    res = await timed(timing, () =>
      fetch(upstreamReq.url, {
        method: 'POST',
        headers: upstreamReq.headers,
        body: upstreamReq.body,
      }),
    );
  } catch {
    throw new RelayError('upstream_unreachable');
  }
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    // pass the upstream status through unchanged; keep the provider detail in the message
    throw new RelayError('upstream_error', {
      status: res.status || 502,
      message: `upstream error ${res.status}: ${detail.slice(0, 200)}`,
    });
  }
  return res;
}

/** Yields upstream byte chunks; the wait for each provider chunk is counted as provider time. */
async function* streamAsyncIterable(
  stream: ReadableStream<Uint8Array>,
  timing: RequestTiming,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await timed(timing, () => reader.read());
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export function createProxyService(): ProxyService {
  return {
    async complete(req, target, timing) {
      const res = await callUpstream({ ...req, stream: false }, target, timing);
      return timed(timing, () => res.json()); // reading the body is still provider/socket wait
    },

    async *stream(req, target, timing) {
      const res = await callUpstream({ ...req, stream: true }, target, timing);
      const adapter = adapterFor(target.provider);
      const body = res.body as ReadableStream<Uint8Array>;
      for await (const event of parseSse(streamAsyncIterable(body, timing))) {
        const delta: CanonicalDelta | null = adapter.toDelta(event);
        if (!delta) continue;
        yield delta;
        if (delta.done) return;
      }
    },
  };
}
