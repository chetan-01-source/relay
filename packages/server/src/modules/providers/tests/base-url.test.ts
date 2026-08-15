/**
 * Upstream base-URL validation. The stored value becomes the address the GATEWAY fetches, so these
 * are the cases that decide whether a tenant can aim the gateway's own process at something it
 * should never reach.
 */
import { describe, expect, it } from 'vitest';
import { validateBaseUrl } from '../lib/base-url.js';

const SELF_HOSTED = { allowPrivateAddresses: true };
const MULTI_TENANT = { allowPrivateAddresses: false };

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'NO ERROR';
  } catch (err) {
    return (err as { code?: string }).code ?? (err as Error).name;
  }
}

describe('validateBaseUrl — schemes', () => {
  it('accepts http and https', () => {
    expect(validateBaseUrl('https://api.openai.com', MULTI_TENANT)).toBe('https://api.openai.com');
    expect(validateBaseUrl('http://api.example.com', MULTI_TENANT)).toBe('http://api.example.com');
  });

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'data:text/plain,x', 'gopher://h/1'])(
    'refuses %s in every edition',
    (url) => {
      expect(codeOf(() => validateBaseUrl(url, SELF_HOSTED))).toBe('invalid_request');
      expect(codeOf(() => validateBaseUrl(url, MULTI_TENANT))).toBe('invalid_request');
    },
  );

  it('refuses a value that is not a URL at all', () => {
    expect(codeOf(() => validateBaseUrl('not a url', SELF_HOSTED))).toBe('invalid_request');
    expect(codeOf(() => validateBaseUrl('/relative/path', SELF_HOSTED))).toBe('invalid_request');
  });
});

describe('validateBaseUrl — link-local', () => {
  /**
   * 169.254.169.254 is the cloud metadata endpoint on AWS, GCP and Azure. It hands IAM credentials
   * to anything that asks from inside the instance, so it is refused even on a self-hosted box,
   * where the blast radius would be the operator's own cloud account.
   */
  it.each([
    'http://169.254.169.254/latest/meta-data',
    'http://169.254.170.2/v2/credentials',
    'http://[fe80::1]/',
  ])('refuses %s even when private addresses are allowed', (url) => {
    expect(codeOf(() => validateBaseUrl(url, SELF_HOSTED))).toBe('invalid_request');
  });
});

describe('validateBaseUrl — private addresses', () => {
  const privateUrls = [
    'http://localhost:11434',
    'http://127.0.0.1:8080',
    'http://10.0.0.5:8000',
    'http://192.168.1.10:1234',
    'http://172.16.0.1:8000',
    'http://172.31.255.254:8000',
    'http://[::1]:8080',
  ];

  it.each(privateUrls)('allows %s on a self-hosted deployment', (url) => {
    // Ollama on localhost and vLLM on the LAN are the documented setups; blocking them would break
    // the openai_compat provider entirely.
    expect(() => validateBaseUrl(url, SELF_HOSTED)).not.toThrow();
  });

  it.each(privateUrls)('refuses %s on a multi-tenant deployment', (url) => {
    // Here the org admin is a customer, and reaching the operator's internal network is SSRF.
    expect(codeOf(() => validateBaseUrl(url, MULTI_TENANT))).toBe('invalid_request');
  });

  it('does not mistake public 172.x for the private range', () => {
    // 172.16/12 covers 172.16–172.31 only; 172.15 and 172.32 are ordinary public addresses.
    expect(() => validateBaseUrl('http://172.15.0.1', MULTI_TENANT)).not.toThrow();
    expect(() => validateBaseUrl('http://172.32.0.1', MULTI_TENANT)).not.toThrow();
  });
});

describe('validateBaseUrl — normalization', () => {
  it('strips trailing slashes, which would otherwise double up with the adapter path', () => {
    expect(validateBaseUrl('https://api.openai.com/', MULTI_TENANT)).toBe('https://api.openai.com');
    expect(validateBaseUrl('https://api.openai.com///', MULTI_TENANT)).toBe(
      'https://api.openai.com',
    );
  });

  it('trims surrounding whitespace from a pasted value', () => {
    expect(validateBaseUrl('  https://api.openai.com  ', MULTI_TENANT)).toBe(
      'https://api.openai.com',
    );
  });

  it('keeps a vendor path prefix, which OpenRouter and Groq both need', () => {
    expect(validateBaseUrl('https://openrouter.ai/api', MULTI_TENANT)).toBe(
      'https://openrouter.ai/api',
    );
  });
});
