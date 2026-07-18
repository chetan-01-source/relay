import { describe, it, expect } from 'vitest';
import { openaiAdapter, anthropicAdapter, adapterFor } from '../adapters/adapter.js';
import type { CanonicalRequest, Target } from '../types/proxy.types.js';

const req: CanonicalRequest = {
  model: 'gpt-4o',
  messages: [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hello world' },
  ],
  stream: true,
  max_tokens: 100,
};
const target: Target = {
  provider: 'openai',
  model: 'gpt-4o',
  baseUrl: 'http://up',
  apiKey: 'sk-x',
};

describe('openaiAdapter', () => {
  it('translate targets /v1/chat/completions with bearer auth and stream_options', () => {
    const out = openaiAdapter.translate(req, target);
    expect(out.url).toBe('http://up/v1/chat/completions');
    expect(out.headers.authorization).toBe('Bearer sk-x');
    const body = JSON.parse(out.body);
    expect(body.model).toBe('gpt-4o');
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages).toHaveLength(2);
  });

  it('toDelta extracts content, usage, and [DONE]', () => {
    expect(openaiAdapter.toDelta({ data: '[DONE]' })).toEqual({ done: true });
    expect(
      openaiAdapter.toDelta({ data: JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }) }),
    ).toEqual({ text: 'hi' });
    expect(
      openaiAdapter.toDelta({
        data: JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 5 } }),
      }),
    ).toEqual({ usage: { inputTokens: 3, outputTokens: 5 } });
    expect(openaiAdapter.toDelta({ data: 'not json' })).toBeNull();
  });
});

describe('anthropicAdapter', () => {
  it('translate splits system out of messages and sets version header', () => {
    const out = anthropicAdapter.translate(req, { ...target, provider: 'anthropic' });
    expect(out.url).toBe('http://up/v1/messages');
    expect(out.headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(out.body);
    expect(body.system).toBe('be brief');
    expect(body.messages).toHaveLength(1); // system removed
    expect(body.messages[0].role).toBe('user');
    expect(body.max_tokens).toBe(100);
  });

  it('toDelta normalizes typed events to canonical deltas', () => {
    expect(
      anthropicAdapter.toDelta({
        data: JSON.stringify({ type: 'content_block_delta', delta: { text: 'yo' } }),
      }),
    ).toEqual({ text: 'yo' });
    expect(
      anthropicAdapter.toDelta({
        data: JSON.stringify({
          type: 'message_delta',
          usage: { input_tokens: 2, output_tokens: 4 },
        }),
      }),
    ).toEqual({ usage: { inputTokens: 2, outputTokens: 4 } });
    expect(anthropicAdapter.toDelta({ data: JSON.stringify({ type: 'message_stop' }) })).toEqual({
      done: true,
    });
    expect(anthropicAdapter.toDelta({ data: JSON.stringify({ type: 'ping' }) })).toBeNull();
  });
});

describe('adapterFor + countTokens', () => {
  it('maps openai_compat to the openai adapter', () => {
    expect(adapterFor('openai_compat')).toBe(openaiAdapter);
    expect(adapterFor('anthropic')).toBe(anthropicAdapter);
  });
  it('estimates tokens from chars/4 plus max_tokens', () => {
    // "be brief"(8) + "hello world"(11) = 19 chars -> ceil(19/4)=5, +100 max_tokens = 105
    expect(openaiAdapter.countTokens(req)).toBe(105);
  });
});
