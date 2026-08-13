/**
 * The SDK is tested against a fake `fetch` rather than a mocked internal — the contract that matters
 * is "given these bytes on the wire, produce this object", and that is exactly what a fake fetch
 * exercises.
 */
import { describe, expect, it, vi } from 'vitest';
import { Relay, RelayApiError, isRelayApiError } from '../index.js';
import { parseMetadata } from '../metadata.js';

const BASE = 'https://relay.test';
const KEY = 'rk_live_abc.def';

const COMPLETION = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'fast',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
};

const RELAY_HEADERS = {
  'x-relay-provider': 'anthropic',
  'x-relay-cache': 'miss',
  'x-relay-failover': 'true',
  'x-relay-cost-usd': '0.000412',
  'x-relay-trace-id': '8f2c',
  'x-relay-modalities': 'text,image',
  'x-relay-plan': 'pro',
  'x-ratelimit-limit-requests': '600',
  'x-ratelimit-remaining-requests': '599',
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
}

function sseResponse(frames: string[], headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...headers },
  });
}

function client(fetchImpl: typeof fetch, over: Record<string, unknown> = {}) {
  return new Relay({ baseUrl: BASE, apiKey: KEY, fetch: fetchImpl, ...over });
}

describe('chat.completions.create', () => {
  it('sends the virtual key and returns Relay metadata as typed fields', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(COMPLETION, { headers: RELAY_HEADERS })),
    ) as unknown as typeof fetch;

    const relay = client(fetchImpl);
    const res = await relay.chat.completions.create({
      model: 'fast',
      messages: [{ role: 'user', content: 'hello' }],
    });

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${BASE}/v1/chat/completions`);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'fast', stream: false });

    expect(res.choices[0]?.message.content).toBe('hi');
    expect(res.relay).toMatchObject({
      provider: 'anthropic',
      cached: false,
      failover: true,
      costUsd: 0.000412,
      traceId: '8f2c',
      modalities: ['text', 'image'],
      plan: 'pro',
    });
    expect(res.relay.rateLimit.remainingRequests).toBe(599);
  });

  it('reports unknown rather than zero when the gateway omits a header', async () => {
    // An older gateway with a newer SDK must degrade to null — a fabricated costUsd: 0 would
    // quietly corrupt whatever the caller is accumulating.
    const fetchImpl = (() => Promise.resolve(jsonResponse(COMPLETION))) as unknown as typeof fetch;
    const res = await client(fetchImpl).chat.completions.create({
      model: 'fast',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(res.relay.costUsd).toBeNull();
    expect(res.relay.plan).toBeNull();
    expect(res.relay.modalities).toEqual([]);
  });
});

describe('errors', () => {
  it('turns a Relay envelope into a typed RelayApiError', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        jsonResponse(
          {
            error: {
              message: 'Organization budget limit reached.',
              type: 'rate_limit_error',
              code: 'budget_exceeded',
              param: null,
            },
          },
          { status: 429, headers: { 'retry-after': '30', 'x-relay-trace-id': 'abc' } },
        ),
      )) as unknown as typeof fetch;

    const err = await client(fetchImpl)
      .chat.completions.create({ model: 'fast', messages: [] })
      .catch((e: unknown) => e);

    expect(isRelayApiError(err)).toBe(true);
    const api = err as RelayApiError;
    expect(api.code).toBe('budget_exceeded');
    expect(api.status).toBe(429);
    expect(api.retryAfterSeconds).toBe(30);
    expect(api.traceId).toBe('abc');
  });

  it('still produces a code when a proxy returns no envelope', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response('<html>502</html>', { status: 502 }),
      )) as unknown as typeof fetch;
    const err = (await client(fetchImpl)
      .chat.completions.create({ model: 'fast', messages: [] })
      .catch((e: unknown) => e)) as RelayApiError;
    expect(err.status).toBe(502);
    expect(err.code).toBe('internal_error');
  });

  it('surfaces quota_exceeded with the limit key in `param`', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        jsonResponse(
          {
            error: {
              message: 'Plan pro allows 10 applications; this organization has 10.',
              type: 'invalid_request_error',
              code: 'quota_exceeded',
              param: 'apps.max',
            },
          },
          { status: 409 },
        ),
      )) as unknown as typeof fetch;

    const err = (await client(fetchImpl)
      .admin('jwt')
      .apps.create({ name: 'x' })
      .catch((e: unknown) => e)) as RelayApiError;
    expect(err.code).toBe('quota_exceeded');
    expect(err.param).toBe('apps.max');
  });
});

describe('retry', () => {
  it('does not retry by default', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ error: { code: 'upstream_error' } }, { status: 502 })),
    ) as unknown as typeof fetch;
    await client(fetchImpl)
      .chat.completions.create({ model: 'fast', messages: [] })
      .catch(() => undefined);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('retries a 502 up to the configured attempts when asked', async () => {
    let calls = 0;
    const fetchImpl = (() => {
      calls += 1;
      return Promise.resolve(
        calls < 3
          ? jsonResponse({ error: { code: 'upstream_error' } }, { status: 502 })
          : jsonResponse(COMPLETION),
      );
    }) as unknown as typeof fetch;

    const res = await client(fetchImpl, {
      retry: { attempts: 3, baseDelayMs: 1 },
    }).chat.completions.create({ model: 'fast', messages: [] });
    expect(calls).toBe(3);
    expect(res.id).toBe('chatcmpl-1');
  });

  it('never retries a 400 — the request is the problem, not the gateway', async () => {
    let calls = 0;
    const fetchImpl = (() => {
      calls += 1;
      return Promise.resolve(jsonResponse({ error: { code: 'invalid_request' } }, { status: 400 }));
    }) as unknown as typeof fetch;

    await client(fetchImpl, { retry: { attempts: 3, baseDelayMs: 1 } })
      .chat.completions.create({ model: 'fast', messages: [] })
      .catch(() => undefined);
    expect(calls).toBe(1);
  });
});

describe('streaming', () => {
  const frames = [
    'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"fast","choices":[{"index":0,"delta":{"content":"He"},"finish_reason":null}]}\n\n',
    'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"fast","choices":[{"index":0,"delta":{"content":"llo"},"finish_reason":null}]}\n\n',
    'data: [DONE]\n\n',
  ];

  it('yields chunks and exposes metadata', async () => {
    const fetchImpl = (() =>
      Promise.resolve(sseResponse(frames, RELAY_HEADERS))) as unknown as typeof fetch;
    const stream = await client(fetchImpl).chat.completions.stream({
      model: 'fast',
      messages: [{ role: 'user', content: 'hi' }],
    });

    let text = '';
    for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? '';
    expect(text).toBe('Hello');
    expect((await stream.relay).provider).toBe('anthropic');
  });

  it('reassembles an event split across two reads', async () => {
    // The chunk boundary lands mid-JSON — the parser has to buffer, not throw.
    const split = [
      'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"fast","choi',
      'ces":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
    ];
    const fetchImpl = (() => Promise.resolve(sseResponse(split))) as unknown as typeof fetch;
    const stream = await client(fetchImpl).chat.completions.stream({
      model: 'fast',
      messages: [],
    });
    expect(await stream.text()).toBe('ok');
  });

  it('skips a malformed frame instead of killing the stream', async () => {
    const withGarbage = ['data: {not json}\n\n', ...frames];
    const fetchImpl = (() => Promise.resolve(sseResponse(withGarbage))) as unknown as typeof fetch;
    const stream = await client(fetchImpl).chat.completions.stream({ model: 'fast', messages: [] });
    expect(await stream.text()).toBe('Hello');
  });

  it('throws from stream() itself when the request fails before the first token', async () => {
    // A tripped budget must surface where the caller's try/catch is, not on the first iteration.
    const fetchImpl = (() =>
      Promise.resolve(
        jsonResponse({ error: { code: 'budget_exceeded' } }, { status: 429 }),
      )) as unknown as typeof fetch;
    await expect(
      client(fetchImpl).chat.completions.stream({ model: 'fast', messages: [] }),
    ).rejects.toBeInstanceOf(RelayApiError);
  });
});

describe('construction', () => {
  it('requires a base URL and a key', () => {
    expect(() => new Relay({ baseUrl: '', apiKey: KEY })).toThrow(/baseUrl/);
    expect(() => new Relay({ baseUrl: BASE, apiKey: '' })).toThrow(/apiKey/);
  });

  it('sends the admin token, not the virtual key, on control-plane calls', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ object: 'list', data: [] })),
    ) as unknown as typeof fetch;
    await client(fetchImpl).admin('jwt-token').apps.list();
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer jwt-token');
  });
});

describe('parseMetadata', () => {
  it('treats a cache hit as cached', () => {
    const meta = parseMetadata(new Headers({ 'x-relay-cache': 'hit-exact' }));
    expect(meta.cached).toBe(true);
  });

  it('ignores an unparseable numeric header', () => {
    expect(parseMetadata(new Headers({ 'x-relay-cost-usd': 'n/a' })).costUsd).toBeNull();
  });
});
