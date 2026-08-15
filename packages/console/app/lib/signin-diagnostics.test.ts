import { describe, it, expect } from 'vitest';
import { diagnoseSignInFailure, isSessionNotFound, originFromHeaders } from './signin-diagnostics';

/** A stand-in for `Headers` — the helpers only ever call `.get()`. */
function headers(map: Record<string, string>) {
  return { get: (name: string) => map[name.toLowerCase()] ?? null };
}

describe('originFromHeaders', () => {
  it('uses the Host the browser actually sent, not the configured base', () => {
    // The whole point: on a laptop, `host` is what reveals that someone typed the LAN IP.
    expect(originFromHeaders(headers({ host: '192.168.1.4:3100' }), 'http://localhost:3100')).toBe(
      'http://192.168.1.4:3100',
    );
  });

  it('prefers the forwarded headers, so it stays correct behind a proxy or tunnel', () => {
    const h = headers({
      host: 'console:3100', // the internal address a proxy connected to
      'x-forwarded-host': 'app.example.com',
      'x-forwarded-proto': 'https',
    });
    expect(originFromHeaders(h, 'http://localhost:3100')).toBe('https://app.example.com');
  });

  it('takes the first protocol when several proxies appended to x-forwarded-proto', () => {
    const h = headers({ 'x-forwarded-host': 'app.example.com', 'x-forwarded-proto': 'https,http' });
    expect(originFromHeaders(h, 'http://localhost:3100')).toBe('https://app.example.com');
  });

  it('falls back to the configured origin when there is no Host at all', () => {
    expect(originFromHeaders(headers({}), 'http://localhost:3100')).toBe('http://localhost:3100');
  });
});

describe('diagnoseSignInFailure', () => {
  it('names the origin mismatch, and both sides of it', () => {
    const d = diagnoseSignInFailure('http://192.168.1.4:3100', 'http://localhost:3100');
    expect(d.kind).toBe('origin_mismatch');
    // The message has to carry both origins — that pairing IS the diagnosis.
    expect(d.detail).toContain('http://192.168.1.4:3100');
    expect(d.detail).toContain('http://localhost:3100');
    expect(d.detail).toContain('LOGTO_BASE_URL');
  });

  it('ignores path and query on the configured base — only the origin can differ', () => {
    const d = diagnoseSignInFailure('http://localhost:3100', 'http://localhost:3100/');
    expect(d.kind).not.toBe('origin_mismatch');
  });

  it('reports a spent or expired attempt when the origins agree', () => {
    const d = diagnoseSignInFailure('http://localhost:3100', 'http://localhost:3100', {
      code: 'sign_in_session.not_found',
    });
    expect(d.kind).toBe('session_expired');
    expect(d.detail).toContain('only be exchanged once');
  });

  it('falls back to a configuration hint for anything else', () => {
    const d = diagnoseSignInFailure(
      'http://localhost:3100',
      'http://localhost:3100',
      new Error('boom'),
    );
    expect(d.kind).toBe('unknown');
    expect(d.detail).toContain('LOGTO_APP_ID');
  });
});

describe('isSessionNotFound', () => {
  it('matches Logto’s code structurally, without importing @logto', () => {
    expect(isSessionNotFound({ code: 'sign_in_session.not_found' })).toBe(true);
  });

  it('does not match anything else', () => {
    expect(isSessionNotFound(new Error('nope'))).toBe(false);
    expect(isSessionNotFound({ code: 'other' })).toBe(false);
    expect(isSessionNotFound(null)).toBe(false);
    expect(isSessionNotFound(undefined)).toBe(false);
  });
});
