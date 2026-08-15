/**
 * Why sign-in failed, in words that name the actual cause.
 *
 * Logto reports a missing sign-in session as `sign_in_session.not_found`, which is accurate and
 * useless: it describes the symptom (no cookie) rather than the reason (the cookie was set on one
 * origin and the callback landed on another). The overwhelmingly common trigger in development is
 * browsing the console by LAN IP or hostname while `LOGTO_BASE_URL` still says `localhost`:
 *
 *   1. sign-in starts on http://192.168.1.4:3100 — the session cookie is set for THAT origin
 *   2. Logto redirects to `${LOGTO_BASE_URL}/callback` = http://localhost:3100/callback
 *   3. different origin, so the browser does not send the cookie
 *   4. handleSignIn finds no session and throws
 *
 * Pure functions, no framework imports, so the whole thing is unit-testable without a request.
 */

/** The subset of `Headers` this module needs — keeps the helpers testable with a plain object. */
export interface HeaderLookup {
  get(name: string): string | null;
}

export type SignInFailureKind = 'origin_mismatch' | 'session_expired' | 'unknown';

export interface SignInDiagnosis {
  kind: SignInFailureKind;
  /** One-line summary. */
  title: string;
  /** What actually happened, and what to change. Plain sentences, safe to show a developer. */
  detail: string;
  requestOrigin: string;
  configuredOrigin: string;
}

/**
 * The origin the browser actually used, which is NOT always `request.nextUrl.origin` — behind a
 * proxy or tunnel that reflects the internal address. The forwarded headers win when present, which
 * is what makes this correct behind Cloudflare or nginx as well as on a laptop.
 */
export function originFromHeaders(headers: HeaderLookup, fallbackUrl: string): string {
  const host = headers.get('x-forwarded-host') ?? headers.get('host');
  if (!host) return safeOrigin(fallbackUrl);
  const forwardedProto = headers.get('x-forwarded-proto');
  // `x-forwarded-proto` may carry a list ("https,http") when more than one proxy appended to it.
  const proto = forwardedProto?.split(',')[0]?.trim() || protocolOf(fallbackUrl);
  return `${proto}://${host}`;
}

/**
 * Classify a failed callback. `configuredBaseUrl` is `logtoConfig.baseUrl` — the value Logto built
 * the redirect URI from, and therefore the origin the cookie had to be readable on.
 */
export function diagnoseSignInFailure(
  requestOrigin: string,
  configuredBaseUrl: string,
  error?: unknown,
): SignInDiagnosis {
  const configuredOrigin = safeOrigin(configuredBaseUrl);

  if (requestOrigin !== configuredOrigin) {
    return {
      kind: 'origin_mismatch',
      title:
        'Sign-in failed: the console was opened on a different origin than it is configured for',
      detail:
        `This callback arrived on ${requestOrigin}, but LOGTO_BASE_URL is ${configuredOrigin}. ` +
        `The sign-in cookie was set on one origin and the callback landed on the other, so the ` +
        `browser never sent it.\n\n` +
        `Either open the console at ${configuredOrigin}, or set LOGTO_BASE_URL to ${requestOrigin} ` +
        `and add ${requestOrigin}/callback as a redirect URI on the Logto application. Both have to ` +
        `agree — changing one alone produces this same error.`,
      requestOrigin,
      configuredOrigin,
    };
  }

  // Same origin, so the cookie should have been sent. The other routine cause is a stale attempt:
  // an authorization code is single-use and the session cookie is short-lived, so refreshing a
  // spent callback URL fails exactly like a missing session.
  if (isSessionNotFound(error)) {
    return {
      kind: 'session_expired',
      title: 'Sign-in failed: that sign-in attempt is no longer valid',
      detail:
        'The sign-in session expired, or this callback URL was already used — an authorization ' +
        'code can only be exchanged once, so reloading the callback page always fails.\n\n' +
        'Start again from the console home page rather than retrying this URL.',
      requestOrigin,
      configuredOrigin,
    };
  }

  return {
    kind: 'unknown',
    title: 'Sign-in failed',
    detail:
      'Logto rejected the callback. Check that LOGTO_APP_ID, LOGTO_APP_SECRET and LOGTO_ENDPOINT ' +
      'match the application in the Logto admin console, and that the gateway and console agree on ' +
      'RELAY_API_RESOURCE.',
    requestOrigin,
    configuredOrigin,
  };
}

/** Logto's error for a missing sign-in cookie, matched structurally (no @logto import needed). */
export function isSessionNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'sign_in_session.not_found';
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function protocolOf(url: string): string {
  try {
    return new URL(url).protocol.replace(':', '');
  } catch {
    return 'http';
  }
}
