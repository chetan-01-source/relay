/**
 * The transport. One `fetch` wrapper shared by both planes: it attaches the right credential,
 * normalizes every failure to `RelayApiError`, and applies the retry policy.
 *
 * Deliberately dependency-free. `fetch`, `AbortController` and `ReadableStream` are standard in
 * Node 18+, Bun, Deno, Cloudflare Workers and browsers — a gateway SDK that drags in a transport
 * library is a gateway SDK that breaks on the edge.
 */
import { RelayApiError, RelayConnectionError, type RelayErrorBody } from './errors.js';

export interface RetryOptions {
  /** Total attempts, including the first. 1 (the default) means no retrying. */
  attempts?: number;
  /** Base backoff in ms; each attempt waits `base * 2^n` plus jitter. */
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface HttpOptions {
  baseUrl: string;
  /** Sent as `authorization: Bearer …`. */
  token: string;
  /** Merged into every request. Per-call headers win. */
  headers?: Record<string, string>;
  timeoutMs?: number;
  retry?: RetryOptions;
  /** Injectable for tests and for runtimes with a custom fetch (proxies, instrumentation). */
  fetch?: typeof fetch;
}

export interface RequestOptions {
  method?: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Streaming responses must not be retried once bytes are flowing — see `send`. */
  stream?: boolean;
}

/** Identifies the client to the gateway, so a deployment can see its client-version spread. */
const SDK_VERSION = '1.0.0';
const USER_AGENT = `relay-sdk-ts/${SDK_VERSION}`;

/**
 * Drop trailing slashes from a base URL.
 *
 * Deliberately not `replace(/\/+$/, '')`. That regex is anchored with a `+` quantifier, so on a
 * string with many slashes the engine retries the match from each one and the work becomes
 * quadratic in the input length — the polynomial-ReDoS shape CodeQL flags (js/polynomial-redos).
 * `baseUrl` is caller-supplied, and in a server that builds it from a request this would be
 * reachable from outside. Scanning backwards is linear and obviously correct.
 */
function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* '/' */) end -= 1;
  return url.slice(0, end);
}

export class Http {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly doFetch: typeof fetch;

  constructor(options: HttpOptions) {
    this.baseUrl = stripTrailingSlashes(options.baseUrl);
    this.token = options.token;
    this.extraHeaders = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.attempts = Math.max(1, options.retry?.attempts ?? 1);
    this.baseDelayMs = options.retry?.baseDelayMs ?? 250;
    this.maxDelayMs = options.retry?.maxDelayMs ?? 8_000;
    const bound = options.fetch ?? globalThis.fetch;
    if (typeof bound !== 'function') {
      throw new Error(
        'No global fetch is available. Use Node 18+, or pass a fetch implementation via `fetch`.',
      );
    }
    this.doFetch = bound.bind(globalThis);
  }

  /** A request whose JSON body you want. Throws `RelayApiError` on any non-2xx. */
  async json<T>(options: RequestOptions): Promise<{ data: T; headers: Headers }> {
    const response = await this.send(options);
    if (response.status === 204) return { data: undefined as T, headers: response.headers };
    const data = (await response.json()) as T;
    return { data, headers: response.headers };
  }

  /**
   * The raw response — used by the streaming path, which needs the body as a stream rather than
   * parsed. Retries are applied here and NOT after the body has been touched: a completion that has
   * already streamed a byte must never be re-sent, or the caller is billed twice for one answer.
   */
  async send(options: RequestOptions): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.attempts; attempt += 1) {
      if (attempt > 0) await sleep(this.backoffFor(attempt, lastError));
      try {
        const response = await this.once(options);
        if (response.ok) return response;
        const error = await this.toError(response);
        if (!error.retryable || attempt === this.attempts - 1) throw error;
        lastError = error;
      } catch (err) {
        if (err instanceof RelayApiError) {
          if (!err.retryable || attempt === this.attempts - 1) throw err;
          lastError = err;
          continue;
        }
        // A transport failure. Retry it like a 502 — the request may never have reached the gateway.
        if (attempt === this.attempts - 1) {
          throw new RelayConnectionError(`Request to ${options.path} failed.`, err);
        }
        lastError = err;
      }
    }
    throw new RelayConnectionError(`Request to ${options.path} failed.`, lastError);
  }

  private async once(options: RequestOptions): Promise<Response> {
    const url = new URL(this.baseUrl + options.path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: options.stream ? 'text/event-stream' : 'application/json',
      'user-agent': USER_AGENT,
      'x-relay-sdk': `ts/${SDK_VERSION}`,
      ...this.extraHeaders,
      ...options.headers,
    };
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    // The caller's own signal and our timeout both have to be able to abort the request. Chained
    // manually rather than with AbortSignal.any(), which is still absent from some runtimes we
    // claim to support.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      return await this.doFetch(url.toString(), {
        method: options.method ?? 'GET',
        headers,
        signal: controller.signal,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  private async toError(response: Response): Promise<RelayApiError> {
    // A gateway in front of Relay can return HTML; never let a parse failure mask the real status.
    const body = await response
      .json()
      .then((value) => value as RelayErrorBody)
      .catch(() => undefined);
    return new RelayApiError({
      status: response.status,
      body,
      headers: response.headers,
      fallbackMessage: `Relay responded ${response.status}.`,
    });
  }

  /** Exponential backoff with jitter — but a server-supplied `retry-after` always wins. */
  private backoffFor(attempt: number, lastError: unknown): number {
    if (lastError instanceof RelayApiError && lastError.retryAfterSeconds !== null) {
      return Math.min(this.maxDelayMs, lastError.retryAfterSeconds * 1000);
    }
    const exponential = this.baseDelayMs * 2 ** (attempt - 1);
    return Math.min(this.maxDelayMs, exponential) * (0.5 + Math.random() / 2);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
