/**
 * Every non-2xx from Relay arrives in the same OpenAI-compatible envelope, so the SDK can turn all
 * of them into ONE error type carrying the catalog code. That is the whole point: callers branch on
 * `err.code === 'budget_exceeded'`, not on a status number they have to look up.
 *
 * Kept in step with `packages/shared/src/errors.ts`, but declared here rather than imported: the SDK
 * ships to npm with zero runtime dependencies, and a published package that reaches into a private
 * workspace package cannot be installed.
 */

/** The Relay error catalog. Widened with `(string & {})` so a newer gateway's code still narrows to
 * a string here instead of failing to compile against an older SDK. */
export type RelayErrorCode =
  | 'invalid_request'
  | 'invalid_api_key'
  | 'key_revoked'
  | 'insufficient_scope'
  | 'org_suspended'
  | 'plan_upgrade_required'
  | 'not_found'
  | 'quota_exceeded'
  | 'conflict'
  | 'model_not_found'
  | 'model_capability_mismatch'
  | 'payload_too_large'
  | 'rate_limited'
  | 'budget_exceeded'
  | 'upstream_error'
  | 'upstream_unreachable'
  | 'internal_error'
  | 'service_unavailable'
  | (string & Record<never, never>);

export interface RelayErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: string;
    param?: string | null;
  };
}

export class RelayApiError extends Error {
  readonly status: number;
  readonly code: RelayErrorCode;
  readonly type: string;
  /**
   * What the error is about. For `quota_exceeded` this is the limit key (`apps.max`); for
   * `plan_upgrade_required` the capability (`modalities.image`); for a validation error the field.
   */
  readonly param: string | null;
  /** Present on 429s that carry `retry-after`. Seconds, already parsed. */
  readonly retryAfterSeconds: number | null;
  /** Correlates with the console's traffic view and the gateway's logs. */
  readonly traceId: string | null;
  readonly headers: Headers;

  constructor(input: {
    status: number;
    body: RelayErrorBody | undefined;
    headers: Headers;
    fallbackMessage: string;
  }) {
    const error = input.body?.error;
    super(error?.message ?? input.fallbackMessage);
    this.name = 'RelayApiError';
    this.status = input.status;
    this.code = error?.code ?? codeForStatus(input.status);
    this.type = error?.type ?? 'api_error';
    this.param = error?.param ?? null;
    this.headers = input.headers;
    this.traceId = input.headers.get('x-relay-trace-id');
    const retryAfter = Number(input.headers.get('retry-after'));
    this.retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
  }

  /** True for the errors a retry could plausibly resolve. Drives the built-in retry policy. */
  get retryable(): boolean {
    return this.status === 429 || this.status === 502 || this.status === 503;
  }
}

/** A gateway that returned no envelope at all (a proxy 502, an HTML error page) still gets a code. */
function codeForStatus(status: number): RelayErrorCode {
  if (status === 401) return 'invalid_api_key';
  if (status === 403) return 'insufficient_scope';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 413) return 'payload_too_large';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'internal_error';
  return 'invalid_request';
}

/** Thrown when a request is aborted or the transport fails before any response arrives. */
export class RelayConnectionError extends Error {
  override readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'RelayConnectionError';
    this.cause = cause;
  }
}

export function isRelayApiError(err: unknown): err is RelayApiError {
  return err instanceof RelayApiError;
}
