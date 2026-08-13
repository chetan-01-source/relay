import { describe, it, expect } from 'vitest';
import { listActiveRouteTargetsQuery } from '../queries/routing.queries.js';

describe('routing queries', () => {
  it('binds the client model and selects the sealed credential only for internal routing', () => {
    const q = listActiveRouteTargetsQuery("gpt-4o'; DROP TABLE routes;--", 'app-1');
    expect(q.values).toEqual(["gpt-4o'; DROP TABLE routes;--", 'app-1']);
    expect(q.text).toContain('JOIN provider_credentials pc');
    expect(q.text).toContain('pc.ciphertext');
    expect(q.text).toContain('LEFT JOIN model_catalog');
    expect(q.text).toContain('LEFT JOIN rate_cards');
  });

  it('prefers the application’s own route and falls back to the org-wide one', () => {
    const q = listActiveRouteTargetsQuery('fast', 'app-1');
    // Both scopes are candidates…
    expect(q.text).toContain('r.app_id IS NULL OR r.app_id = $2::uuid');
    // …and the app-scoped row sorts first, because `false` orders before `true`.
    expect(q.text).toContain('ORDER BY (r.app_id IS NULL)');
    expect(q.text).toContain('LIMIT 1');
  });

  it('binds a null application (a key with no app resolves the org route)', () => {
    expect(listActiveRouteTargetsQuery('fast', null).values).toEqual(['fast', null]);
  });
});
