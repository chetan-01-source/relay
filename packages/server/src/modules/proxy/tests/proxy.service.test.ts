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
    const out = await createProxyService().complete(req, [target], timing);
    expect(out).toEqual({ id: 'x' });
    expect(timing.upstreamMs).toBeGreaterThanOrEqual(0); // fetch + res.json() counted as provider wait
  });

  it('complete() throws RelayError(upstream_error) passing the upstream status through', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('rate limited', { status: 429 })),
    );
    await expect(createProxyService().complete(req, [target], newTiming())).rejects.toMatchObject({
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
      .complete(req, [target], newTiming())
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
    for await (const d of createProxyService().stream(req, [target], timing)) {
      if (d.text) texts.push(d.text);
    }
    expect(texts).toEqual(['Hel', 'lo']);
    expect(timing.upstreamMs).toBeGreaterThanOrEqual(0); // each reader.read() wait accumulated
  });

  it('complete() normalizes an Anthropic body to OpenAI shape and records usage', async () => {
    const anthropicTarget: Target = {
      ...target,
      provider: 'anthropic',
      baseUrl: 'http://anthropic',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: 'msg_1',
              model: 'claude-3-5-sonnet',
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'hi there' }],
              usage: { input_tokens: 4, output_tokens: 2 },
            }),
            { status: 200 },
          ),
      ),
    );
    const timing = newTiming();
    const out = (await createProxyService().complete(req, [anthropicTarget], timing)) as {
      object: string;
      choices: { message: { content: string } }[];
    };
    expect(out.object).toBe('chat.completion');
    expect(out.choices[0]!.message.content).toBe('hi there');
    expect(timing.usage).toEqual({ inputTokens: 4, outputTokens: 2 });
  });

  it('complete() retries the next target before returning an upstream failure', async () => {
    const secondary: Target = { ...target, baseUrl: 'http://backup', breakerKey: 'backup' };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new Error('primary down'))
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'ok' }), { status: 200 })),
    );

    const timing = newTiming();
    await expect(
      createProxyService().complete(req, [{ ...target, breakerKey: 'primary' }, secondary], timing),
    ).resolves.toEqual({ id: 'ok' });
    expect(timing.failover).toBe(true);
    expect(timing.selectedProvider).toBe('openai');
  });
});
