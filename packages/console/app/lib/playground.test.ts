import { describe, it, expect } from 'vitest';
import { completionText, errorMessage, tokenUsage, headerFacts } from './playground';
import type { RelayHeaders } from './api';

const NO_HEADERS: RelayHeaders = {
  traceId: null,
  provider: null,
  cache: null,
  failover: null,
  costUsd: null,
  modalities: null,
};

describe('completionText', () => {
  it('reads the first choice message', () => {
    const body = { choices: [{ message: { role: 'assistant', content: 'hello' } }] };
    expect(completionText(body)).toBe('hello');
  });

  it('returns null for anything that is not a completion envelope', () => {
    expect(completionText(null)).toBeNull();
    expect(completionText('a plain string body')).toBeNull();
    expect(completionText({ choices: [] })).toBeNull();
    // A multimodal reply is an array, not a string — the plain-text panel must not render it.
    expect(completionText({ choices: [{ message: { content: [{ type: 'text' }] } }] })).toBeNull();
  });
});

describe('errorMessage', () => {
  it('reads the OpenAI error envelope Relay speaks end to end', () => {
    expect(errorMessage({ error: { message: 'budget exceeded', type: 'policy' } })).toBe(
      'budget exceeded',
    );
  });

  it('returns null when there is no error block', () => {
    expect(errorMessage({ choices: [] })).toBeNull();
    expect(errorMessage(undefined)).toBeNull();
  });
});

describe('tokenUsage', () => {
  it('reads prompt/completion counts', () => {
    expect(tokenUsage({ usage: { prompt_tokens: 12, completion_tokens: 5 } })).toEqual({
      input: 12,
      output: 5,
    });
  });

  it('treats a missing half as zero rather than NaN', () => {
    expect(tokenUsage({ usage: { prompt_tokens: 12 } })).toEqual({ input: 12, output: 0 });
  });

  it('returns null when the upstream omitted usage', () => {
    expect(tokenUsage({ choices: [] })).toBeNull();
  });
});

describe('headerFacts', () => {
  it('drops headers the gateway did not send', () => {
    expect(headerFacts(NO_HEADERS)).toEqual([]);
  });

  it('flags a cache hit, a failover and a non-zero cost as notable', () => {
    const facts = headerFacts({
      ...NO_HEADERS,
      provider: 'openai',
      cache: 'hit-exact',
      failover: 'true',
      costUsd: '0.000412',
    });
    expect(facts.map((f) => [f.label, f.notable])).toEqual([
      ['Provider', false],
      ['Cache', true],
      ['Failover', true],
      ['Cost (USD)', true],
    ]);
  });

  it('treats a plain miss, no failover and a zero cost as unremarkable', () => {
    const facts = headerFacts({
      ...NO_HEADERS,
      cache: 'miss',
      failover: 'false',
      costUsd: '0.000000',
    });
    expect(facts.every((f) => !f.notable)).toBe(true);
  });
});
