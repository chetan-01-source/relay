import { describe, it, expect } from 'vitest';
import { buildChecklist, checklistProgress } from './checklist';

describe('buildChecklist', () => {
  it('marks each step done from the observable counts', () => {
    const steps = buildChecklist({ appCount: 1, keyCount: 0, providerCount: 2, requestCount: 0 });
    expect(steps.map((s) => [s.id, s.done])).toEqual([
      ['app', true],
      ['provider', true],
      ['key', false],
      ['request', false],
    ]);
  });

  it('is all-false at zero and all-true once everything exists', () => {
    const empty = buildChecklist({ appCount: 0, keyCount: 0, providerCount: 0, requestCount: 0 });
    expect(empty.every((s) => !s.done)).toBe(true);
    const full = buildChecklist({ appCount: 1, keyCount: 1, providerCount: 1, requestCount: 1 });
    expect(full.every((s) => s.done)).toBe(true);
  });
});

describe('checklistProgress', () => {
  it('is the done fraction', () => {
    const steps = buildChecklist({ appCount: 1, keyCount: 1, providerCount: 0, requestCount: 0 });
    expect(checklistProgress(steps)).toBe(0.5);
    expect(checklistProgress([])).toBe(0);
  });
});
