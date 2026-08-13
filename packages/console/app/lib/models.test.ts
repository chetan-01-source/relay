import { describe, it, expect } from 'vitest';
import { groupByOwner, routedModelNames } from './models';
import type { ModelObject, RouteSummary } from './api';

const model = (id: string, owner: string): ModelObject => ({
  id,
  object: 'model',
  owned_by: owner,
  created: 1,
});

describe('groupByOwner', () => {
  it('groups by provider, providers and models both alphabetical', () => {
    const groups = groupByOwner([
      model('gpt-4o', 'openai'),
      model('claude-sonnet', 'anthropic'),
      model('gpt-4o-mini', 'openai'),
    ]);
    expect(groups.map((g) => [g.owner, g.models.map((m) => m.id)])).toEqual([
      ['anthropic', ['claude-sonnet']],
      ['openai', ['gpt-4o', 'gpt-4o-mini']],
    ]);
  });

  it('buckets a missing owner rather than dropping the model', () => {
    const groups = groupByOwner([{ id: 'mystery', object: 'model' }]);
    expect(groups).toEqual([{ owner: 'unknown', models: [{ id: 'mystery', object: 'model' }] }]);
  });

  it('is empty for an empty catalogue', () => {
    expect(groupByOwner([])).toEqual([]);
  });
});

describe('routedModelNames', () => {
  it('collects the client-facing names the org has routes for', () => {
    const routes = [
      { id: 'r1', model_name: 'fast-chat' },
      { id: 'r2', model_name: 'deep-chat' },
    ] as RouteSummary[];
    expect([...routedModelNames(routes)].sort()).toEqual(['deep-chat', 'fast-chat']);
  });

  it('skips a route with no model name instead of adding undefined to the set', () => {
    const routes = [{ id: 'r1' }, { id: 'r2', model_name: 'fast-chat' }] as RouteSummary[];
    expect([...routedModelNames(routes)]).toEqual(['fast-chat']);
  });
});
