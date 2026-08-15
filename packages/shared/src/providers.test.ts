import { describe, expect, it } from 'vitest';
import { PROVIDERS, PROVIDER_IDS, isKnownProvider, providerInfo, wireFor } from './providers.js';

describe('provider registry', () => {
  it('has no duplicate ids', () => {
    expect(new Set(PROVIDER_IDS).size).toBe(PROVIDER_IDS.length);
  });

  it('keeps the three Phase-1 providers, so existing credentials keep working', () => {
    // These ids are written into `provider_credentials.provider` on customers' rows. Renaming one
    // would orphan every credential using it, so they are pinned by test rather than by convention.
    for (const id of ['openai', 'anthropic', 'openai_compat']) {
      expect(isKnownProvider(id)).toBe(true);
    }
  });

  it('routes every provider to an implemented wire format', () => {
    for (const provider of PROVIDERS) {
      expect(['openai', 'anthropic', 'azure']).toContain(provider.wire);
    }
  });

  it('gives every provider a base URL or a documented reason it has none', () => {
    for (const provider of PROVIDERS) {
      if (provider.defaultBaseUrl !== null) {
        // A trailing slash would produce `//v1/chat/completions` once the adapter appends its path.
        expect(provider.defaultBaseUrl).toMatch(/^https:\/\//);
        expect(provider.defaultBaseUrl.endsWith('/')).toBe(false);
        continue;
      }
      // Only the two genuinely per-deployment providers may omit one.
      expect(['azure_openai', 'openai_compat']).toContain(provider.id);
    }
  });

  it('only claims published pricing for OpenRouter', () => {
    // Overstating this would make the sync write rate cards from fields a provider does not return.
    const pricing = PROVIDERS.filter((p) => p.publishesPricing).map((p) => p.id);
    expect(pricing).toEqual(['openrouter']);
  });

  it('gives a provider with a models path something to resolve it against', () => {
    // The sync builds `defaultBaseUrl + modelsPath`; a path with no base is unreachable.
    for (const provider of PROVIDERS) {
      if (provider.modelsPath === null) continue;
      if (provider.defaultBaseUrl === null) {
        expect(['openai_compat']).toContain(provider.id);
      }
    }
  });

  it('resolves the wire format for a known provider', () => {
    expect(wireFor('openrouter')).toBe('openai');
    expect(wireFor('anthropic')).toBe('anthropic');
    expect(wireFor('azure_openai')).toBe('azure');
  });

  /**
   * A credential written by a NEWER gateway and read by an older one mid-rollout must degrade to the
   * likeliest protocol rather than failing every request for the duration of the deploy.
   */
  it('falls back to the OpenAI wire for an unknown provider instead of throwing', () => {
    expect(wireFor('some-future-vendor')).toBe('openai');
    expect(providerInfo('some-future-vendor')).toBeUndefined();
    expect(isKnownProvider('some-future-vendor')).toBe(false);
  });

  it('describes every provider for the console', () => {
    for (const provider of PROVIDERS) {
      expect(provider.label.length).toBeGreaterThan(0);
      expect(provider.hint.length).toBeGreaterThan(0);
    }
  });
});
