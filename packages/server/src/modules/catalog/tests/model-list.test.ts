/**
 * Model-list parsers. Every case here is a shape a real provider returns or a malformed one a
 * provider could return — the parsers are the trust boundary between third-party JSON and the
 * catalog that decides routing and billing.
 */
import { describe, expect, it } from 'vitest';
import {
  capabilitiesChanged,
  parseAnthropicModels,
  parseOpenAiModels,
  parseOpenRouterModels,
  parserFor,
  priceChanged,
} from '../lib/model-list.js';

describe('parseOpenAiModels', () => {
  it('reads ids from the standard envelope', () => {
    const models = parseOpenAiModels({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] });
    expect(models.map((m) => m.model)).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(models[0]!.capabilities?.streaming).toBe(true);
  });

  it("strips Google's models/ prefix so the id is what the chat endpoint accepts", () => {
    expect(parseOpenAiModels({ data: [{ id: 'models/gemini-2.0-flash' }] })[0]!.model).toBe(
      'gemini-2.0-flash',
    );
  });

  it('skips entries with no usable id rather than inventing one', () => {
    const models = parseOpenAiModels({
      data: [{ id: 'ok' }, { id: '' }, { id: 42 }, {}, null],
    });
    expect(models.map((m) => m.model)).toEqual(['ok']);
  });

  it('returns nothing for a body that is not a model list', () => {
    expect(parseOpenAiModels({})).toEqual([]);
    expect(parseOpenAiModels({ data: 'nope' })).toEqual([]);
    expect(parseOpenAiModels(null)).toEqual([]);
  });
});

describe('parseOpenRouterModels', () => {
  const entry = {
    id: 'openai/gpt-4o',
    context_length: 128000,
    architecture: { input_modalities: ['text', 'image'] },
    pricing: { prompt: '0.0000025', completion: '0.00001' },
  };

  it('scales per-token prices to Relay per-1k units', () => {
    const [model] = parseOpenRouterModels({ data: [entry] });
    // $0.0000025/token → $2.50 per million → $0.0025 per thousand.
    expect(model!.inputUsdPer1k).toBeCloseTo(0.0025, 10);
    expect(model!.outputUsdPer1k).toBeCloseTo(0.01, 10);
  });

  it('carries modalities and context length into capabilities', () => {
    const [model] = parseOpenRouterModels({ data: [entry] });
    expect(model!.capabilities).toMatchObject({
      modalities: ['text', 'image'],
      max_tokens: 128000,
    });
  });

  it('keeps a free model priced at zero rather than treating zero as absent', () => {
    const [model] = parseOpenRouterModels({
      data: [{ id: 'free/model', pricing: { prompt: '0', completion: '0' } }],
    });
    expect(model!.inputUsdPer1k).toBe(0);
    expect(model!.outputUsdPer1k).toBe(0);
  });

  it('catalogues a model with unusable pricing, but gives it no price', () => {
    const [model] = parseOpenRouterModels({
      data: [{ id: 'weird/model', pricing: { prompt: '-1', completion: 'free' } }],
    });
    expect(model!.model).toBe('weird/model');
    expect(model!.inputUsdPer1k).toBeUndefined();
    expect(model!.outputUsdPer1k).toBeUndefined();
  });

  it('refuses a half-priced model — one real side and one missing is worse than none', () => {
    const [model] = parseOpenRouterModels({
      data: [{ id: 'half/model', pricing: { prompt: '0.000001' } }],
    });
    expect(model!.inputUsdPer1k).toBeUndefined();
  });
});

describe('parseAnthropicModels', () => {
  it('reads ids and grants the Claude capability set', () => {
    const models = parseAnthropicModels({
      data: [{ id: 'claude-3-5-sonnet-20241022', display_name: 'Claude 3.5 Sonnet' }],
    });
    expect(models[0]!.model).toBe('claude-3-5-sonnet-20241022');
    expect(models[0]!.capabilities).toMatchObject({ modalities: ['text', 'image'], tools: true });
  });
});

describe('parserFor', () => {
  it('routes each provider to the parser that understands its body', () => {
    expect(parserFor('openrouter')).toBe(parseOpenRouterModels);
    expect(parserFor('anthropic')).toBe(parseAnthropicModels);
    // Everything else is OpenAI-shaped — that is the point of the registry's `wire` field.
    expect(parserFor('groq')).toBe(parseOpenAiModels);
    expect(parserFor('openai')).toBe(parseOpenAiModels);
  });
});

describe('priceChanged', () => {
  it('is quiet when nothing moved', () => {
    expect(priceChanged('0.002500', '0.010000', 0.0025, 0.01)).toBe(false);
  });

  it('notices a real change on either side', () => {
    expect(priceChanged('0.002500', '0.010000', 0.003, 0.01)).toBe(true);
    expect(priceChanged('0.002500', '0.010000', 0.0025, 0.011)).toBe(true);
  });

  /**
   * The regression that made every sync rewrite this row. Postgres numeric rounds 0.0000375 half-up
   * to 0.000038; `toFixed(6)` on the binary double rounds it down to 0.000037, so the two never
   * agreed and the sync wrote a new rate-card version on every single run.
   */
  it('agrees with Postgres on a half-way value', () => {
    expect(priceChanged('0.000038', '0.000150', 0.0000375, 0.00015)).toBe(false);
  });

  it('ignores binary noise below the stored scale', () => {
    expect(priceChanged('0.002500', '0.010000', 0.0000025 * 1000, 0.00001 * 1000)).toBe(false);
  });
});

describe('capabilitiesChanged', () => {
  it('ignores key order', () => {
    expect(
      capabilitiesChanged(
        { modalities: ['text'], streaming: true, tools: false },
        { tools: false, streaming: true, modalities: ['text'] },
      ),
    ).toBe(false);
  });

  it('reports a genuine difference', () => {
    expect(capabilitiesChanged({ modalities: ['text'] }, { modalities: ['text', 'image'] })).toBe(
      true,
    );
  });

  it('treats a never-seen model as changed so it gets written', () => {
    expect(capabilitiesChanged(undefined, { modalities: ['text'] })).toBe(true);
  });
});
