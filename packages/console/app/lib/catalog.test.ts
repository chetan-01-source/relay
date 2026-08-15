import { describe, expect, it } from 'vitest';
import { groupByProvider } from './catalog';

describe('groupByProvider', () => {
  it('groups models and labels each provider from the shared registry', () => {
    const groups = groupByProvider([
      { provider: 'openai', model: 'gpt-4o' },
      { provider: 'openai', model: 'gpt-4o-mini' },
      { provider: 'anthropic', model: 'claude-opus-5' },
    ]);

    expect(groups.map((g) => g.provider)).toEqual(['openai', 'anthropic']);
    expect(groups[0]!.label).toBe('OpenAI');
    expect(groups[0]!.models).toHaveLength(2);
    expect(groups[1]!.label).toBe('Anthropic');
  });

  it('preserves the order the gateway returned', () => {
    // The API sorts by provider then model, so groups arrive alphabetical and models stay sorted.
    const groups = groupByProvider([
      { provider: 'anthropic', model: 'claude-haiku-4-5' },
      { provider: 'anthropic', model: 'claude-opus-5' },
    ]);
    expect(groups[0]!.models.map((m) => m.model)).toEqual(['claude-haiku-4-5', 'claude-opus-5']);
  });

  /**
   * The catalogue is refreshed independently of the code, so a row can outlive the registry entry
   * that produced it. Dropping it would look like the sync had failed.
   */
  it('keeps a provider the registry does not know, falling back to its id', () => {
    const groups = groupByProvider([{ provider: 'some-future-vendor', model: 'x' }]);
    expect(groups[0]!.label).toBe('some-future-vendor');
  });

  it('buckets a row with no provider rather than dropping it', () => {
    const groups = groupByProvider([{ model: 'orphan' }]);
    expect(groups[0]!.provider).toBe('unknown');
  });

  it('returns nothing for an empty catalogue', () => {
    expect(groupByProvider([])).toEqual([]);
  });
});
