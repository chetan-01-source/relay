/**
 * Catalog SQL. These queries are built from strings that arrived in a third-party HTTP response, so
 * "every value is a bound parameter" is a security property here, not a style rule (§3.4).
 */
import { describe, expect, it } from 'vitest';
import {
  closePriceQuery,
  currentPricesQuery,
  insertPriceQuery,
  listForProviderQuery,
  upsertModelQuery,
} from '../queries/catalog.queries.js';

/** A provider id shaped like an injection attempt — a hostile /models response could carry one. */
const HOSTILE = "openai'; DROP TABLE rate_cards; --";

describe('catalog queries', () => {
  it('binds every value as a parameter, never interpolating', () => {
    const queries = [
      listForProviderQuery(HOSTILE),
      upsertModelQuery(HOSTILE, HOSTILE, { modalities: ['text'] }),
      currentPricesQuery(HOSTILE),
      closePriceQuery(HOSTILE, HOSTILE),
      insertPriceQuery(HOSTILE, HOSTILE, 1, 2),
    ];
    for (const query of queries) {
      expect(query.text).not.toContain('DROP TABLE');
      expect(query.values).toContain(HOSTILE);
    }
  });

  it('lists one provider in a stable order', () => {
    const query = listForProviderQuery('openrouter');
    expect(query.text).toContain('FROM model_catalog');
    expect(query.text).toContain('ORDER BY model');
    expect(query.values).toEqual(['openrouter']);
  });

  it('upserts a model so a re-sync is idempotent', () => {
    const query = upsertModelQuery('groq', 'llama-3.3', { modalities: ['text'] });
    expect(query.text).toContain('ON CONFLICT (provider, model) DO UPDATE');
    // Capabilities are serialized here and cast in SQL — the driver must never see an object.
    expect(query.values[2]).toBe('{"modalities":["text"]}');
  });

  it('reads only the OPEN rate card, newest first', () => {
    const query = currentPricesQuery('openrouter');
    // A closed version is history: settling against it would price requests at last month's rate.
    expect(query.text).toContain('effective_to IS NULL');
    expect(query.text).toContain('DISTINCT ON (model)');
  });

  it('closes a price by dating it, never by deleting it', () => {
    const query = closePriceQuery('openrouter', 'openai/gpt-4o');
    // Billing history has to stay explainable — a usage event settled last week must still resolve
    // to the price that was effective when it ran.
    expect(query.text).toContain('SET effective_to = now()');
    expect(query.text).not.toContain('DELETE');
    expect(query.values).toEqual(['openrouter', 'openai/gpt-4o']);
  });

  it('opens a new price with both directions bound', () => {
    const query = insertPriceQuery('openrouter', 'openai/gpt-4o', 0.0025, 0.01);
    expect(query.text).toContain('INSERT INTO rate_cards');
    expect(query.values).toEqual(['openrouter', 'openai/gpt-4o', 0.0025, 0.01]);
  });
});
