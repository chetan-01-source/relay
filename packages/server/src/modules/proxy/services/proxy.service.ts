/**
 * Proxy service (playbook §5) — business logic ONLY. No HTTP types, no DB. Selects the
 * adapter, calls the upstream provider, and yields provider-agnostic canonical deltas.
 * Throws UpstreamError on failure; the controller maps that to an HTTP response.
 */
import { RelayError } from '@relay/shared';
import { adapterFor } from '../adapters/adapter.js';
import { parseSse } from '../lib/sse.js';
import {
  type CanonicalDelta,
  type CanonicalRequest,
  type ProxyService,
  type Target,
} from '../types/proxy.types.js';

async function callUpstream(req: CanonicalRequest, target: Target): Promise<Response> {
  const adapter = adapterFor(target.provider);
  const upstreamReq = adapter.translate(req, target);
  let res: Response;
  try {
    res = await fetch(upstreamReq.url, {
      method: 'POST',
      headers: upstreamReq.headers,
      body: upstreamReq.body,
    });
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

async function* streamAsyncIterable(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export function createProxyService(): ProxyService {
  return {
    async complete(req, target) {
      const res = await callUpstream({ ...req, stream: false }, target);
      return res.json();
    },

    async *stream(req, target) {
      const res = await callUpstream({ ...req, stream: true }, target);
      const adapter = adapterFor(target.provider);
      const body = res.body as ReadableStream<Uint8Array>;
      for await (const event of parseSse(streamAsyncIterable(body))) {
        const delta: CanonicalDelta | null = adapter.toDelta(event);
        if (!delta) continue;
        yield delta;
        if (delta.done) return;
      }
    },
  };
}
