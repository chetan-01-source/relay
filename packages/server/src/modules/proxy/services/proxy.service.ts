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

interface BreakerState {
  failures: number;
  openedUntil: number;
}

const breakers = new Map<string, BreakerState>();
const BREAKER_FAILURES = 2;
const BREAKER_COOLDOWN_MS = 30_000;

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
    async complete(req, targets, timing) {
      let lastError: unknown;
      const candidates = availableTargets(targets);
      for (const [index, target] of candidates.entries()) {
        try {
          const res = await callUpstream({ ...req, stream: false }, target, timing);
          markSuccess(target);
          timing.failover = index > 0;
          timing.selectedProvider = target.provider;
          timing.selectedTarget = target;
          const raw = await timed(timing, () => res.json()); // body read is provider/socket wait
          // Normalize the provider body to OpenAI canonical (Anthropic differs) and lift usage.
          const normalized = adapterFor(target.provider).toResponse(raw, req);
          if (normalized.usage) timing.usage = normalized.usage;
          return normalized.body;
        } catch (err) {
          markFailure(target);
          lastError = err;
        }
      }
      throw upstreamFailure(lastError);
    },

    async *stream(req, targets, timing) {
      let lastError: unknown;
      const candidates = availableTargets(targets);
      for (const [index, target] of candidates.entries()) {
        let emitted = false;
        try {
          const res = await callUpstream({ ...req, stream: true }, target, timing);
          const adapter = adapterFor(target.provider);
          const body = res.body as ReadableStream<Uint8Array>;
          for await (const event of parseSse(streamAsyncIterable(body, timing))) {
            const delta: CanonicalDelta | null = adapter.toDelta(event);
            if (!delta) continue;
            if (delta.usage) timing.usage = delta.usage;
            emitted = true;
            markSuccess(target);
            timing.failover = index > 0;
            timing.selectedProvider = target.provider;
            timing.selectedTarget = target;
            yield delta;
            if (delta.done) return;
          }
          return;
        } catch (err) {
          markFailure(target);
          lastError = err;
          if (emitted) return;
        }
      }
      throw upstreamFailure(lastError);
    },
  };
}

function availableTargets(targets: Target[]): Target[] {
  const now = Date.now();
  const open: Target[] = [];
  const closed: Target[] = [];
  for (const target of targets) {
    const key = target.breakerKey;
    const state = key ? breakers.get(key) : undefined;
    if (state && state.openedUntil > now) open.push(target);
    else closed.push(target);
  }
  return closed.length > 0 ? closed : open;
}

function markSuccess(target: Target): void {
  if (target.breakerKey) breakers.delete(target.breakerKey);
}

function markFailure(target: Target): void {
  if (!target.breakerKey) return;
  const current = breakers.get(target.breakerKey) ?? { failures: 0, openedUntil: 0 };
  const failures = current.failures + 1;
  breakers.set(target.breakerKey, {
    failures,
    openedUntil: failures >= BREAKER_FAILURES ? Date.now() + jitter(BREAKER_COOLDOWN_MS) : 0,
  });
}

function jitter(maxMs: number): number {
  return Math.floor(Math.random() * maxMs);
}

function upstreamFailure(err: unknown): Error {
  return err instanceof Error ? err : new RelayError('upstream_unreachable');
}
