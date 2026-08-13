import { describe, it, expect } from 'vitest';
import { isOnboardingState, nextOnboardingState, ONBOARDING_STEPS } from './onboarding';

describe('isOnboardingState', () => {
  it('accepts the three settable states', () => {
    expect(isOnboardingState('admin_invited')).toBe(true);
    expect(isOnboardingState('provider_added')).toBe(true);
    expect(isOnboardingState('first_request')).toBe(true);
  });

  it('rejects the `created` seed — the gateway assigns it and will not accept it back', () => {
    expect(isOnboardingState('created')).toBe(false);
  });

  it('rejects an unknown value from a form post', () => {
    expect(isOnboardingState('')).toBe(false);
    expect(isOnboardingState('done')).toBe(false);
  });
});

describe('nextOnboardingState', () => {
  it('walks the machine one step at a time', () => {
    expect(nextOnboardingState('created')).toBe('admin_invited');
    expect(nextOnboardingState('admin_invited')).toBe('provider_added');
    expect(nextOnboardingState('provider_added')).toBe('first_request');
  });

  it('returns null at the end, which is what renders "onboarding complete"', () => {
    expect(nextOnboardingState('first_request')).toBeNull();
  });

  it('returns null for an unknown current state instead of guessing', () => {
    expect(nextOnboardingState('archived')).toBeNull();
  });

  it('covers every step in the machine', () => {
    expect(ONBOARDING_STEPS).toHaveLength(4);
  });
});
