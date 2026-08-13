import { describe, it, expect } from 'vitest';
import { usageOfCredential, healthTone } from './providers';
import type { RouteDetail } from './api';

const ROUTES = [
  {
    id: 'route-b',
    model_name: 'fast-chat',
    versions: [
      {
        id: 'v2',
        version: 2,
        is_active: true,
        targets: [{ credential_id: 'cred-1', provider: 'openai', model: 'gpt-4o-mini' }],
      },
      {
        id: 'v1',
        version: 1,
        is_active: false,
        targets: [
          { credential_id: 'cred-1', provider: 'openai', model: 'gpt-4o' },
          { credential_id: 'cred-2', provider: 'anthropic', model: 'claude-sonnet' },
        ],
      },
    ],
  },
  {
    id: 'route-a',
    model_name: 'deep-chat',
    versions: [
      {
        id: 'v1',
        version: 1,
        is_active: true,
        targets: [{ credential_id: 'cred-1', provider: 'openai', model: 'o3' }],
      },
    ],
  },
] as unknown as RouteDetail[];

describe('usageOfCredential', () => {
  it('finds every target bound to the credential across routes and versions', () => {
    expect(usageOfCredential(ROUTES, 'cred-1')).toHaveLength(3);
  });

  it('puts live versions first — those are the ones a delete would break', () => {
    const usage = usageOfCredential(ROUTES, 'cred-1');
    expect(usage.map((u) => [u.modelName, u.version, u.isActive])).toEqual([
      ['deep-chat', 1, true],
      ['fast-chat', 2, true],
      ['fast-chat', 1, false],
    ]);
  });

  it('ignores targets on other credentials', () => {
    expect(usageOfCredential(ROUTES, 'cred-2').map((u) => u.model)).toEqual(['claude-sonnet']);
  });

  it('is empty for an unused credential, which is what makes a delete safe', () => {
    expect(usageOfCredential(ROUTES, 'cred-none')).toEqual([]);
  });
});

describe('healthTone', () => {
  it('reads an absent score as unknown rather than unhealthy', () => {
    expect(healthTone(undefined)).toEqual({ label: 'unknown', variant: 'secondary' });
    expect(healthTone(null)).toEqual({ label: 'unknown', variant: 'secondary' });
  });

  it('buckets the score', () => {
    expect(healthTone(1)).toEqual({ label: '100%', variant: 'success' });
    expect(healthTone(0.9)).toEqual({ label: '90%', variant: 'success' });
    expect(healthTone(0.7)).toEqual({ label: '70%', variant: 'secondary' });
    expect(healthTone(0.2)).toEqual({ label: '20%', variant: 'destructive' });
  });
});
