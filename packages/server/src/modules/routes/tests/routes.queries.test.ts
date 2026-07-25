import { describe, it, expect } from 'vitest';
import {
  deleteRouteQuery,
  getRouteByModelQuery,
  getRouteQuery,
  insertRouteQuery,
  insertTargetQuery,
  insertVersionQuery,
  listTargetsQuery,
  maxVersionQuery,
  setActiveVersionQuery,
  setCacheEnabledQuery,
} from '../queries/routes.queries.js';

describe('routes queries — parametrized, never interpolated', () => {
  it('binds every user value, interpolating none', () => {
    expect(getRouteQuery('r1').values).toEqual(['r1']);
    expect(getRouteByModelQuery("gpt'; DROP").values).toEqual(["gpt'; DROP"]);
    expect(getRouteQuery('r1').text).not.toContain('r1');
  });

  it('insertRoute binds org, model, cache flag in order', () => {
    const q = insertRouteQuery('org-1', 'fast', true);
    expect(q.values).toEqual(['org-1', 'fast', true]);
    expect(q.text).toContain('$1');
    expect(q.text).toContain('$3');
  });

  it('insertVersion binds org, route, ordinal, strategy', () => {
    expect(insertVersionQuery('org-1', 'r1', 2, 'weighted').values).toEqual([
      'org-1',
      'r1',
      2,
      'weighted',
    ]);
  });

  it('insertTarget applies priority/weight defaults (100 / 1)', () => {
    const q = insertTargetQuery('org-1', 'v1', {
      credential_id: 'c1',
      provider: 'openai',
      model: 'gpt-4o',
    });
    expect(q.values).toEqual(['org-1', 'v1', 'c1', 'openai', 'gpt-4o', 100, 1]);
  });

  it('insertTarget preserves explicit priority/weight', () => {
    const q = insertTargetQuery('org-1', 'v1', {
      credential_id: 'c1',
      provider: 'anthropic',
      model: 'claude',
      priority: 5,
      weight: 3,
    });
    expect(q.values.slice(-2)).toEqual([5, 3]);
  });

  it('listTargets casts the id list to uuid[] and binds it', () => {
    const q = listTargetsQuery(['v1', 'v2']);
    expect(q.text).toContain('= ANY($1::uuid[])');
    expect(q.values).toEqual([['v1', 'v2']]);
  });

  it('maxVersion / setActiveVersion / setCacheEnabled / delete all bind', () => {
    expect(maxVersionQuery('r1').values).toEqual(['r1']);
    expect(setActiveVersionQuery('r1', 'v1').values).toEqual(['r1', 'v1']);
    expect(setCacheEnabledQuery('r1', false).values).toEqual(['r1', false]);
    expect(deleteRouteQuery('r1').values).toEqual(['r1']);
  });
});
