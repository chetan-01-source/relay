import { describe, expect, it } from 'vitest';
import { statusTone } from './logs';

describe('statusTone', () => {
  it('marks a successful request green', () => {
    expect(statusTone('ok')).toBe('success');
  });

  it('marks only a genuine failure red', () => {
    expect(statusTone('error')).toBe('destructive');
  });

  /**
   * An enforced ceiling is the gateway working, not breaking. Colouring it like an upstream failure
   * teaches operators to ignore red, which is the opposite of what the colour is for.
   */
  it('treats an enforced limit as a warning, not a fault', () => {
    expect(statusTone('rate_limited')).toBe('secondary');
    expect(statusTone('budget_exceeded')).toBe('secondary');
  });

  it('falls back to neutral for an unknown or missing status', () => {
    expect(statusTone(undefined)).toBe('secondary');
    expect(statusTone(null)).toBe('secondary');
    expect(statusTone('something-new')).toBe('secondary');
  });
});
