import { describe, it, expect } from 'vitest';
import { listActiveRouteTargetsQuery } from '../queries/routing.queries.js';

describe('routing queries', () => {
  it('binds the client model and selects the sealed credential only for internal routing', () => {
    const q = listActiveRouteTargetsQuery("gpt-4o'; DROP TABLE routes;--");
    expect(q.values).toEqual(["gpt-4o'; DROP TABLE routes;--"]);
    expect(q.text).toContain('JOIN provider_credentials pc');
    expect(q.text).toContain('pc.ciphertext');
    expect(q.text).toContain('LEFT JOIN model_catalog');
    expect(q.text).toContain('LEFT JOIN rate_cards');
  });
});
