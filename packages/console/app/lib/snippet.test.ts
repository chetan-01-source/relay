import { describe, it, expect } from 'vitest';
import { buildSnippet, SNIPPET_LANGS } from './snippet';

const input = { baseUrl: 'http://localhost:3000/', apiKey: 'rk_live_abc', model: 'gpt-4o' };

describe('buildSnippet', () => {
  it('curl targets /v1/chat/completions with the bearer key and model, trimming a trailing slash', () => {
    const curl = buildSnippet('curl', input);
    expect(curl).toContain('http://localhost:3000/v1/chat/completions');
    expect(curl).not.toContain('3000//v1'); // trailing slash trimmed
    expect(curl).toContain('authorization: Bearer rk_live_abc');
    expect(curl).toContain('"model":"gpt-4o"');
  });

  it('python + node point the OpenAI SDK at the Relay base URL with the key', () => {
    const py = buildSnippet('python', input);
    expect(py).toContain('base_url="http://localhost:3000/v1"');
    expect(py).toContain('api_key="rk_live_abc"');
    const node = buildSnippet('node', input);
    expect(node).toContain('baseURL: "http://localhost:3000/v1"');
    expect(node).toContain('apiKey: "rk_live_abc"');
    expect(node).toContain('model: "gpt-4o"');
  });

  it('exposes exactly the three supported languages', () => {
    expect(SNIPPET_LANGS).toEqual(['curl', 'python', 'node']);
  });
});
