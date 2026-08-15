/**
 * Matching a direct provider's model id to the same model on OpenRouter. These cases are the real
 * id shapes the two spell differently — a mismatch here means a model silently settles at zero cost,
 * and a FALSE match means an invoice carries a number that looks plausible and is wrong.
 */
import { describe, expect, it } from 'vitest';
import { matchPrices, normalizeModelId, type PricedModel } from '../lib/price-match.js';

describe('normalizeModelId', () => {
  it('strips the vendor prefix OpenRouter adds', () => {
    expect(normalizeModelId('anthropic/claude-opus-5')).toBe(normalizeModelId('claude-opus-5'));
  });

  it("strips Anthropic's dated snapshot suffix", () => {
    // Anthropic pins a snapshot; OpenRouter tracks the family.
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe(
      normalizeModelId('anthropic/claude-haiku-4.5'),
    );
    expect(normalizeModelId('claude-sonnet-4-5-20250929')).toBe(
      normalizeModelId('anthropic/claude-sonnet-4.5'),
    );
  });

  it('treats a dotted and a dashed version as the same model', () => {
    expect(normalizeModelId('claude-3-5-sonnet')).toBe(
      normalizeModelId('anthropic/claude-3.5-sonnet'),
    );
  });

  it('keeps genuinely different models apart', () => {
    expect(normalizeModelId('claude-opus-4-5')).not.toBe(normalizeModelId('claude-opus-4-6'));
    expect(normalizeModelId('gpt-4o')).not.toBe(normalizeModelId('gpt-4o-mini'));
  });

  /** `-fast` and `:batch` are priced differently, so they must NOT collapse onto the base model. */
  it('does not fold a differently-priced variant onto the base model', () => {
    expect(normalizeModelId('anthropic/claude-opus-4.7-fast')).not.toBe(
      normalizeModelId('claude-opus-4-7'),
    );
    expect(normalizeModelId('anthropic/claude-opus-4.5:batch')).not.toBe(
      normalizeModelId('claude-opus-4-5'),
    );
  });
});

describe('matchPrices', () => {
  const reference: PricedModel[] = [
    { model: 'anthropic/claude-haiku-4.5', inputUsdPer1k: 0.001, outputUsdPer1k: 0.005 },
    { model: 'anthropic/claude-opus-5', inputUsdPer1k: 0.015, outputUsdPer1k: 0.075 },
    { model: 'openai/gpt-4o', inputUsdPer1k: 0.0025, outputUsdPer1k: 0.01 },
  ];

  it('prices a dated Anthropic snapshot from the OpenRouter family entry', () => {
    const matched = matchPrices(['claude-haiku-4-5-20251001'], reference);
    expect(matched.get('claude-haiku-4-5-20251001')).toMatchObject({
      inputUsdPer1k: 0.001,
      outputUsdPer1k: 0.005,
    });
  });

  it('prices a direct OpenAI model from its namespaced twin', () => {
    expect(matchPrices(['gpt-4o'], reference).get('gpt-4o')?.inputUsdPer1k).toBe(0.0025);
  });

  it('leaves a model with no counterpart unpriced rather than guessing', () => {
    // Zero cost is visibly wrong; a fabricated price is not, which is why nothing is invented.
    expect(matchPrices(['some-private-finetune'], reference).size).toBe(0);
  });

  /**
   * Two reference ids can normalize to the same key. If they disagree on price there is no way to
   * know which applies, and a wrong price is worse than none — it looks plausible on an invoice.
   */
  it('refuses an ambiguous match where two references disagree', () => {
    const ambiguous: PricedModel[] = [
      { model: 'vendor/model-1.0', inputUsdPer1k: 0.001, outputUsdPer1k: 0.002 },
      { model: 'vendor/model-1-0', inputUsdPer1k: 0.009, outputUsdPer1k: 0.009 },
    ];
    expect(matchPrices(['model-1-0'], ambiguous).size).toBe(0);
  });

  it('accepts duplicate references that agree', () => {
    const duplicates: PricedModel[] = [
      { model: 'vendor/model-1.0', inputUsdPer1k: 0.001, outputUsdPer1k: 0.002 },
      { model: 'vendor/model-1-0', inputUsdPer1k: 0.001, outputUsdPer1k: 0.002 },
    ];
    expect(matchPrices(['model-1-0'], duplicates).get('model-1-0')?.inputUsdPer1k).toBe(0.001);
  });

  it('returns nothing when there is no reference data at all', () => {
    expect(matchPrices(['gpt-4o'], []).size).toBe(0);
  });
});
