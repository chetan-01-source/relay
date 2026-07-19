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
  not_found: { status: 404, type: 'not_found_error', message: 'Resource not found.' },
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
  // unknown: return a safe generic 500 (details go to logs, not the client)
  return new RelayError('internal_error').toResponse();
}
