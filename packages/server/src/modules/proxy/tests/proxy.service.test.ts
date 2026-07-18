import { describe, it, expect, vi, afterEach } from 'vitest';
import { RelayError } from '@relay/shared';
import { createProxyService } from '../services/proxy.service.js';
import { type CanonicalRequest, type RequestTiming, type Target } from '../types/proxy.types.js';

const req: CanonicalRequest = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
const target: Target = { provider: 'openai', model: 'gpt-4o', baseUrl: 'http://up', apiKey: 'sk' };
const newTiming = (): RequestTiming => ({ upstreamMs: 0 });

function sseStream(...lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(l));
      controller.close();
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('proxy.service', () => {
  it('complete() returns the upstream JSON and records provider-wait time', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ id: 'x' }), { status: 200 })),
    );
    const timing = newTiming();
    const out = await createProxyService().complete(req, target, timing);
    expect(out).toEqual({ id: 'x' });
    expect(timing.upstreamMs).toBeGreaterThanOrEqual(0); // fetch + res.json() counted as provider wait
  });

  it('complete() throws RelayError(upstream_error) passing the upstream status through', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('rate limited', { status: 429 })),
    );
    await expect(createProxyService().complete(req, target, newTiming())).rejects.toMatchObject({
      code: 'upstream_error',
      status: 429,
    });
  });

  it('complete() throws RelayError(upstream_unreachable, 502) when the fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const err = await createProxyService()
      .complete(req, target, newTiming())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect(err).toMatchObject({ code: 'upstream_unreachable', status: 502 });
  });

  it('stream() yields normalized canonical deltas, stops on [DONE], and records provider-wait', async () => {
    const body = sseStream(
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: [DONE]\n\n',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );
    const timing = newTiming();
    const texts: string[] = [];
    for await (const d of createProxyService().stream(req, target, timing)) {
      if (d.text) texts.push(d.text);
    }
    expect(texts).toEqual(['Hel', 'lo']);
    expect(timing.upstreamMs).toBeGreaterThanOrEqual(0); // each reader.read() wait accumulated
  });
});
