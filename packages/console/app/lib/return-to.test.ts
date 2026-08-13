import { describe, it, expect } from 'vitest';
import { isSafeReturnPath } from './return-to';

// The post-sign-in destination is attacker-reachable: an invitation link is something people are
// already primed to click, and the callback redirects wherever this says. Only same-site paths pass.
describe('isSafeReturnPath', () => {
  it('accepts same-site paths', () => {
    expect(isSafeReturnPath('/dashboard')).toBe(true);
    expect(isSafeReturnPath('/invitations/abc123')).toBe(true);
    expect(isSafeReturnPath('/orgs/1?tab=members')).toBe(true);
  });

  it('rejects anything that could leave the site', () => {
    expect(isSafeReturnPath('//evil.example/phish')).toBe(false); // protocol-relative
    expect(isSafeReturnPath('https://evil.example')).toBe(false);
    expect(isSafeReturnPath('javascript:alert(1)')).toBe(false);
    expect(isSafeReturnPath('dashboard')).toBe(false); // relative — resolves unpredictably
  });

  it('rejects a missing value', () => {
    expect(isSafeReturnPath(undefined)).toBe(false);
    expect(isSafeReturnPath(null)).toBe(false);
    expect(isSafeReturnPath('')).toBe(false);
  });
});
