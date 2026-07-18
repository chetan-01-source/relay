import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildMockLlm } from '../app.js';

let app: FastifyInstance;
let base: string;

beforeAll(async () => {
  app = buildMockLlm();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => app.close());

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const chat = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };

describe('health', () => {
  it('GET /healthz -> ok', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('openai /v1/chat/completions', () => {
  it('non-stream returns a chat.completion with usage', async () => {
    const res = await post('/v1/chat/completions', chat);
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      object: string;
      choices: { message: { content: string } }[];
      usage: { completion_tokens: number };
    };
    expect(j.object).toBe('chat.completion');
    expect(j.choices[0]?.message.content.length).toBeGreaterThan(0);
    expect(j.usage.completion_tokens).toBeGreaterThan(0);
  });

  it('x-mock-tokens caps the completion token count', async () => {
    const res = await post('/v1/chat/completions', chat, { 'x-mock-tokens': '3' });
    const j = (await res.json()) as {
      usage: { completion_tokens: number };
      choices: { message: { content: string } }[];
    };
    expect(j.usage.completion_tokens).toBe(3);
    expect(j.choices[0]?.message.content.split(' ')).toHaveLength(3);
  });

  it('stream emits chunks, a final usage chunk and [DONE]', async () => {
    const res = await post('/v1/chat/completions', { ...chat, stream: true });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('chat.completion.chunk');
    expect(text).toContain('"role":"assistant"');
    expect(text).toContain('completion_tokens');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('x-mock-error forces that status with an error envelope', async () => {
    const res = await post('/v1/chat/completions', chat, { 'x-mock-error': '429' });
    expect(res.status).toBe(429);
    expect((await res.json()) as { error: unknown }).toHaveProperty('error');
  });
});

describe('anthropic /v1/messages (different native shape)', () => {
  it('non-stream returns content[].text + usage.input_tokens', async () => {
    const res = await post('/v1/messages', {
      model: 'claude',
      max_tokens: 50,
      messages: chat.messages,
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      type: string;
      content: { type: string; text: string }[];
      usage: { input_tokens: number };
    };
    expect(j.type).toBe('message');
    expect(j.content[0]?.type).toBe('text');
    expect(j.usage.input_tokens).toBeGreaterThan(0);
  });

  it('stream emits typed events message_start … message_stop', async () => {
    const res = await post('/v1/messages', {
      model: 'claude',
      stream: true,
      messages: chat.messages,
    });
    const text = await res.text();
    expect(text).toContain('event: message_start');
    expect(text).toContain('event: content_block_delta');
    expect(text).toContain('"type":"text_delta"');
    expect(text).toContain('event: message_stop');
  });
});

describe('unknown routes', () => {
  it('return an OpenAI-style 404 envelope, not a bare framework 404', async () => {
    const res = await fetch(`${base}/v1/models`);
    expect(res.status).toBe(404);
    const j = (await res.json()) as { error: { type: string; code: string } };
    expect(j.error.type).toBe('invalid_request_error');
    expect(j.error.code).toBe('not_found');
  });
});
