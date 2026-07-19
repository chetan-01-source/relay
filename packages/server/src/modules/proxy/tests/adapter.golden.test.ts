/**
 * Golden-file translation fixtures (Week 2 Day 8). For each P0 provider family we record the exact
 * ProviderRequest that `translate()` must produce for a text request and for a multimodal (inline
 * image) request. No live calls — the fixtures ARE the contract. A provider wire-format change shows
 * up here as a failing diff, and the fix is one adapter + this fixture, nothing else.
 */
import { describe, it, expect } from 'vitest';
import { openaiAdapter, anthropicAdapter, openaiCompatAdapter } from '../adapters/adapter.js';
import type { CanonicalRequest, ProviderRequest, Target } from '../types/proxy.types.js';

const TEXT_REQUEST: CanonicalRequest = {
  model: 'canonical-model',
  messages: [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hello world' },
  ],
  max_tokens: 100,
};

// OpenAI-style inline image (vision) content.
const IMAGE_REQUEST: CanonicalRequest = {
  model: 'canonical-model',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is in this image?' },
        { type: 'image_url', image_url: { url: 'https://img.example/cat.png' } },
      ],
    },
  ],
};

/** Compare a translate() result to a golden fixture, parsing the JSON body for a readable diff. */
function expectGolden(
  actual: ProviderRequest,
  golden: { url: string; headers: Record<string, string>; body: unknown },
) {
  expect(actual.url).toBe(golden.url);
  expect(actual.headers).toEqual(golden.headers);
  expect(JSON.parse(actual.body)).toEqual(golden.body);
}

describe('golden · openai', () => {
  const target: Target = {
    provider: 'openai',
    model: 'gpt-4o',
    baseUrl: 'http://up',
    apiKey: 'sk-x',
  };

  it('text request', () => {
    expectGolden(openaiAdapter.translate(TEXT_REQUEST, target), {
      url: 'http://up/v1/chat/completions',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-x' },
      body: {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hello world' },
        ],
        stream: false,
        max_tokens: 100,
      },
    });
  });

  it('image request passes multimodal parts through unchanged', () => {
    expectGolden(openaiAdapter.translate(IMAGE_REQUEST, target), {
      url: 'http://up/v1/chat/completions',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-x' },
      body: {
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is in this image?' },
              { type: 'image_url', image_url: { url: 'https://img.example/cat.png' } },
            ],
          },
        ],
        stream: false,
      },
    });
  });
});

describe('golden · anthropic', () => {
  const target: Target = {
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    baseUrl: 'http://up',
    apiKey: 'ak-x',
  };

  it('text request splits system out and shapes messages', () => {
    expectGolden(anthropicAdapter.translate(TEXT_REQUEST, target), {
      url: 'http://up/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'ak-x',
        'anthropic-version': '2023-06-01',
      },
      body: {
        model: 'claude-3-5-sonnet',
        max_tokens: 100,
        stream: false,
        system: 'be brief',
        messages: [{ role: 'user', content: 'hello world' }],
      },
    });
  });

  it('image request maps image_url to an Anthropic URL image block', () => {
    expectGolden(anthropicAdapter.translate(IMAGE_REQUEST, target), {
      url: 'http://up/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'ak-x',
        'anthropic-version': '2023-06-01',
      },
      body: {
        model: 'claude-3-5-sonnet',
        max_tokens: 1024,
        stream: false,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is in this image?' },
              { type: 'image', source: { type: 'url', url: 'https://img.example/cat.png' } },
            ],
          },
        ],
      },
    });
  });
});

describe('golden · openai_compat', () => {
  it('rewrites away the auth header when the target has no key (local Ollama)', () => {
    const target: Target = {
      provider: 'openai_compat',
      model: 'llama3',
      baseUrl: 'http://ollama:11434',
      apiKey: '',
    };
    const out = openaiCompatAdapter.translate(TEXT_REQUEST, target);
    expect(out.url).toBe('http://ollama:11434/v1/chat/completions');
    expect(out.headers).toEqual({ 'content-type': 'application/json' }); // no Authorization
    expect(JSON.parse(out.body).model).toBe('llama3');
  });

  it('keeps bearer auth when a key IS configured (vLLM/LM Studio with a token)', () => {
    const target: Target = {
      provider: 'openai_compat',
      model: 'llama3',
      baseUrl: 'http://vllm',
      apiKey: 'token-123',
    };
    const out = openaiCompatAdapter.translate(TEXT_REQUEST, target);
    expect(out.headers.authorization).toBe('Bearer token-123');
  });
});
