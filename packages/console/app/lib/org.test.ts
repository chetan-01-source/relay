import { describe, it, expect } from 'vitest';
import { pickOrgId } from './org';

describe('pickOrgId', () => {
  it('returns null when the user belongs to no organization', () => {
    // A platform admin with no membership is legitimate — the admin screens need no tenant.
    expect(pickOrgId([])).toBeNull();
    expect(pickOrgId(undefined)).toBeNull();
  });

  it('returns the only organization', () => {
    expect(pickOrgId(['9rfrjhfmx0hk'])).toBe('9rfrjhfmx0hk');
  });

  it('is stable for a multi-org user regardless of the order Logto returned', () => {
    expect(pickOrgId(['zeta', 'alpha', 'mid'])).toBe('alpha');
    expect(pickOrgId(['mid', 'zeta', 'alpha'])).toBe('alpha');
  });

  it('honours a preference the user is actually a member of', () => {
    expect(pickOrgId(['alpha', 'zeta'], 'zeta')).toBe('zeta');
  });

  it('ignores a stale preference for an org the user was removed from', () => {
    // Trusting it would mint a token the gateway rejects; falling back keeps the console usable.
    expect(pickOrgId(['alpha', 'zeta'], 'gone')).toBe('alpha');
  });

  it('drops empty ids rather than returning one', () => {
    expect(pickOrgId(['', 'alpha'])).toBe('alpha');
    expect(pickOrgId([''])).toBeNull();
  });
});
