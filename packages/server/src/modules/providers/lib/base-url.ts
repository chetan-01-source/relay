/**
 * Upstream base-URL validation — PURE, so every hostile shape is unit-testable without a network.
 *
 * A provider credential's `base_url` becomes the address the gateway itself fetches
 * (`adapter.translate` builds `${baseUrl}/v1/chat/completions`). That makes it server-side request
 * forgery by construction: whoever sets it chooses where the gateway's own process, inside the
 * gateway's own network, sends a request — and the response comes back to the caller.
 *
 * Two separate concerns, and conflating them is how this gets fixed wrongly:
 *
 *   1. **Scheme.** `javascript:`, `file:`, `data:`, `gopher:` have no legitimate use as an LLM
 *      upstream. Rejected always, in every edition. Cheap and total.
 *   2. **Address.** A private address is legitimate for a self-hosted deployment — Ollama on
 *      localhost, vLLM on the LAN — and illegitimate for a multi-tenant one, where the org admin is
 *      a CUSTOMER and must not be able to point the gateway at its operator's internal network.
 *      So this is edition-dependent rather than a flat ban.
 *
 * The link-local range is the exception to (2): `169.254.0.0/16` and `fe80::/10` carry the cloud
 * metadata endpoint (`169.254.169.254`), which hands out IAM credentials to anything that asks from
 * inside the instance. It is never a legitimate LLM upstream in any edition, so it is refused even
 * on a self-hosted box, where the blast radius would be the operator's own cloud account.
 *
 * This is validation at the boundary, not a network policy. A determined attacker can still point a
 * DNS name at a private address (rebinding); defeating that needs resolution-time checks in the
 * proxy's HTTP agent. What this does is close the trivial path and make the intent explicit.
 */
import { RelayError } from 'relay-shared';

/** The only schemes an upstream can meaningfully speak. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export interface BaseUrlPolicy {
  /**
   * Allow private and loopback addresses. True for a self-hosted deployment, where the operator and
   * the org admin are the same person and `http://localhost:11434` is the documented Ollama setup.
   * False for a multi-tenant one, where they are not.
   */
  allowPrivateAddresses: boolean;
}

/** Reject the literal forms of the cloud metadata service and other link-local addresses. */
function isLinkLocal(hostname: string): boolean {
  // 169.254.0.0/16 — AWS/GCP/Azure metadata all live at 169.254.169.254.
  if (/^169\.254\./.test(hostname)) return true;
  // IPv6 link-local, with or without the brackets the URL parser leaves on.
  const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return bare.startsWith('fe80:') || bare === 'fd00:ec2::254';
}

/** Loopback, RFC-1918 and IPv6 unique-local. */
function isPrivateAddress(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (bare === 'localhost' || bare.endsWith('.localhost')) return true;
  if (bare === '::1' || bare === '0.0.0.0') return true;
  if (bare.startsWith('fc') || bare.startsWith('fd')) return true; // fc00::/7 unique-local
  if (/^127\./.test(bare)) return true;
  if (/^10\./.test(bare)) return true;
  if (/^192\.168\./.test(bare)) return true;
  // 172.16.0.0/12 — only 16–31, so 172.15 and 172.32 are public and must not be caught.
  const match = /^172\.(\d{1,3})\./.exec(bare);
  if (match) {
    const second = Number(match[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

/**
 * Validate an operator-supplied upstream base URL, or throw `invalid_request` naming `base_url`.
 * Returns the normalized URL — trailing slashes removed, since the adapters append their own path
 * and `https://host//v1/chat/completions` is a 404 on some gateways.
 */
export function validateBaseUrl(rawUrl: string, policy: BaseUrlPolicy): string {
  const trimmed = rawUrl.trim();

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new RelayError('invalid_request', {
      message: 'base_url must be an absolute http(s) URL.',
      param: 'base_url',
    });
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new RelayError('invalid_request', {
      message: `base_url must use http or https, not "${url.protocol.replace(':', '')}".`,
      param: 'base_url',
    });
  }

  if (isLinkLocal(url.hostname)) {
    throw new RelayError('invalid_request', {
      message: 'base_url must not point at a link-local address.',
      param: 'base_url',
    });
  }

  if (!policy.allowPrivateAddresses && isPrivateAddress(url.hostname)) {
    throw new RelayError('invalid_request', {
      message: 'base_url must be a public address on this deployment.',
      param: 'base_url',
    });
  }

  // Strip a trailing slash without a backtracking regex (see http.ts in the SDK for the same shape).
  let end = trimmed.length;
  while (end > 0 && trimmed.charCodeAt(end - 1) === 47 /* '/' */) end -= 1;
  return trimmed.slice(0, end);
}
