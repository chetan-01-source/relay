/**
 * Relay error catalog — the single source of truth for every error the gateway returns (PRD §15).
 * Wire format mirrors OpenAI's error envelope so client SDKs treat Relay errors as native:
 *
 *   { "error": { "message": string, "type": string, "code": string, "param": string | null } }
 *
 * Framework-agnostic on purpose (no fastify import): the server wires these into a Fastify
 * errorHandler/notFoundHandler; any layer just `throw new RelayError('code', ...)`.
 */

/** Each code maps to a fixed HTTP status, an OpenAI-style `type`, and a default message. */
export const ERROR_CATALOG = {
  invalid_request: {
    status: 400,
    type: 'invalid_request_error',
    message: 'The request was malformed.',
  },
  invalid_api_key: {
    status: 401,
    type: 'authentication_error',
    message: 'Missing or invalid virtual key.',
  },
  key_revoked: { status: 401, type: 'authentication_error', message: 'This key has been revoked.' },
  insufficient_scope: {
    status: 403,
    type: 'permission_error',
    message: 'The key lacks the required scope.',
  },
  org_suspended: {
    status: 403,
    type: 'permission_error',
    message: 'This organization is suspended.',
  },
  /**
   * A capability the organization's plan does not include (ADR-0014). Distinct from
   * insufficient_scope, which is about who the caller is; this is about what the tenant bought, and
   * the console branches on it to offer an upgrade rather than an access-denied dead end.
   */
  plan_upgrade_required: {
    status: 403,
    type: 'permission_error',
    message: 'This capability is not included in the current plan.',
  },
  not_found: { status: 404, type: 'not_found_error', message: 'Resource not found.' },
  /**
   * A countable plan quota is exhausted — applications, providers, routes, keys or members. 409
   * rather than 400 because the request is well-formed and the state is what refuses it: deleting
   * something or upgrading both make the identical request succeed. `param` names the quota.
   */
  quota_exceeded: {
    status: 409,
    type: 'invalid_request_error',
    message: 'A plan quota is exhausted.',
  },
  conflict: {
    status: 409,
    type: 'invalid_request_error',
    message: 'The resource already exists or conflicts with an existing one.',
  },
  model_not_found: { status: 404, type: 'not_found_error', message: 'The model does not exist.' },
  model_capability_mismatch: {
    status: 400,
    type: 'invalid_request_error',
    message: 'No target supports the requested capability.',
  },
  payload_too_large: {
    status: 413,
    type: 'invalid_request_error',
    message: 'The request body is too large.',
  },
  rate_limited: { status: 429, type: 'rate_limit_error', message: 'Rate limit exceeded.' },
  budget_exceeded: { status: 429, type: 'rate_limit_error', message: 'Budget limit reached.' },
  upstream_error: { status: 502, type: 'api_error', message: 'The upstream provider errored.' },
  upstream_unreachable: {
    status: 502,
    type: 'api_error',
    message: 'The upstream provider is unreachable.',
  },
  internal_error: { status: 500, type: 'api_error', message: 'An internal error occurred.' },
  service_unavailable: {
    status: 503,
    type: 'api_error',
    message: 'A required dependency is unavailable. Try again shortly.',
  },
} as const satisfies Record<string, { status: number; type: string; message: string }>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

/** The OpenAI-compatible error envelope returned on the wire. */
export interface ErrorEnvelope {
  error: {
    message: string;
    type: string;
    code: ErrorCode;
    param: string | null;
  };
}

export interface ErrorResponse {
  status: number;
  body: ErrorEnvelope;
}

/**
 * A thrown gateway error. Carries the catalog `code` (which fixes `type` + default status/message).
 * `status` may be overridden — e.g. to pass an upstream provider's status through unchanged.
 */
export class RelayError extends Error {
  readonly code: ErrorCode;
  readonly type: string;
  readonly status: number;
  readonly param: string | null;

  constructor(code: ErrorCode, opts: { message?: string; status?: number; param?: string } = {}) {
    const entry = ERROR_CATALOG[code];
    super(opts.message ?? entry.message);
    this.name = 'RelayError';
    this.code = code;
    this.type = entry.type;
    this.status = opts.status ?? entry.status;
    this.param = opts.param ?? null;
  }

  toResponse(): ErrorResponse {
    return {
      status: this.status,
      body: {
        error: { message: this.message, type: this.type, code: this.code, param: this.param },
      },
    };
  }
}

export function isRelayError(err: unknown): err is RelayError {
  return err instanceof RelayError;
}

/** Minimal shape of a Fastify schema-validation error, matched structurally (no fastify import). */
interface ValidationLike {
  validation: unknown;
  message?: string;
}
function isValidationError(err: unknown): err is ValidationLike {
  return typeof err === 'object' && err !== null && 'validation' in err;
}

/**
 * Minimal shape of a framework error that already carries an HTTP status. Fastify sets `statusCode`
 * on failures it raises before any handler runs — content-type parsing, malformed/empty JSON,
 * oversized payloads, unsupported media types. Matched structurally (no fastify import).
 */
interface StatusCarrying {
  statusCode?: unknown;
  message?: string;
}

/** The 4xx status a framework error already decided on, or null when it isn't a client error. */
function clientStatusOf(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const status = (err as StatusCarrying).statusCode;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : null;
}

/** Catalog code for a bare 4xx status, so a framework client error keeps its meaning on the wire. */
function codeForClientStatus(status: number): ErrorCode {
  switch (status) {
    case 401:
      return 'invalid_api_key';
    case 403:
      return 'insufficient_scope';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 413:
      return 'payload_too_large';
    case 429:
      return 'rate_limited';
    default:
      return 'invalid_request'; // 400/415/422/… — the caller sent something we can't accept
  }
}

/**
 * Normalize ANY thrown value to the wire envelope. Used by the server's central error handler so
 * every error — thrown RelayError, Fastify validation failure, or an unexpected exception —
 * leaves as the same OpenAI-compatible shape. Unknown errors never leak internals to the client.
 */
export function toErrorEnvelope(err: unknown): ErrorResponse {
  if (isRelayError(err)) return err.toResponse();
  if (isValidationError(err)) {
    return new RelayError('invalid_request', {
      message: err.message ?? 'Validation failed.',
    }).toResponse();
  }
  // A framework error that already settled on a 4xx is the CALLER's fault, not ours — report it as
  // such. Without this, Fastify's pre-handler failures (an empty body sent with
  // `content-type: application/json`, malformed JSON, an unsupported media type) fell through to the
  // generic 500 below, so a client mistake looked like a gateway outage and paged whoever was on
  // call. Fastify's own message is safe to pass through: it describes the request, not our internals.
  const clientStatus = clientStatusOf(err);
  if (clientStatus !== null) {
    const message = (err as StatusCarrying).message;
    return new RelayError(codeForClientStatus(clientStatus), {
      status: clientStatus,
      ...(typeof message === 'string' && message ? { message } : {}),
    }).toResponse();
  }
  // unknown: return a safe generic 500 (details go to logs, not the client)
  return new RelayError('internal_error').toResponse();
}
