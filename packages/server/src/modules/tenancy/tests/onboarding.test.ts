import { describe, it, expect } from 'vitest';
import { canAdvance, nextState, ONBOARDING_ORDER } from '../lib/onboarding.js';

describe('onboarding state machine', () => {
  it('allows exactly one forward step', () => {
    expect(canAdvance('created', 'admin_invited')).toBe(true);
    expect(canAdvance('admin_invited', 'provider_added')).toBe(true);
    expect(canAdvance('provider_added', 'first_request')).toBe(true);
  });

  it('rejects skips, self-loops, and moving backwards', () => {
    expect(canAdvance('created', 'provider_added')).toBe(false); // skip
    expect(canAdvance('created', 'created')).toBe(false); // self
    expect(canAdvance('admin_invited', 'created')).toBe(false); // backwards
    expect(canAdvance('first_request', 'first_request')).toBe(false); // terminal
  });

  it('nextState walks the chain and stops at the end', () => {
    expect(nextState('created')).toBe('admin_invited');
    expect(nextState('first_request')).toBeNull();
    expect(ONBOARDING_ORDER).toHaveLength(4);
  });
});
