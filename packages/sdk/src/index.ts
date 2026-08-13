/**
 * `@relay-ai/sdk` — the TypeScript client for a Relay Gateway.
 *
 * Relay is OpenAI-compatible, so the official OpenAI SDKs already work against it unchanged. This
 * package exists for the two things they structurally cannot do:
 *
 *   1. surface Relay's own per-request metadata — which provider served it, what it cost, whether it
 *      was cached or failed over, its trace id, the plan enforcing the ceilings — as typed fields;
 *   2. drive the control plane, so provisioning a tenant is a script rather than clicking.
 *
 * Zero runtime dependencies, and no Node built-ins: it runs on Node 18+, Bun, Deno, Cloudflare
 * Workers and in browsers.
 */
import { createAdminClient, type AdminClient } from './admin.js';
import { createChat } from './chat.js';
import { Http, type RetryOptions } from './http.js';
import type { ModelObject } from './types.js';

export { RelayApiError, RelayConnectionError, isRelayApiError } from './errors.js';
export type { RelayErrorCode } from './errors.js';
export type { RelayMetadata } from './metadata.js';
export type { RetryOptions } from './http.js';
export type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionParams,
  ChatCompletionStream,
  ChatContentPart,
  ChatMessage,
  ChatRole,
  ChatUsage,
  ModelObject,
} from './types.js';
export { createAdminClient } from './admin.js';
export type {
  AdminClient,
  Application,
  AuditEntry,
  Budget,
  BudgetPeriod,
  CreateApplicationInput,
  CreateProviderInput,
  CreateRouteInput,
  EffectivePlan,
  Identity,
  IssuedKey,
  IssueKeyInput,
  PlanCatalogEntry,
  Provider,
  Route,
  RouteDetail,
  SetBudgetInput,
  Subscription,
  TrafficEvent,
  UsageSummary,
  VirtualKey,
} from './admin.js';

export interface RelayOptions {
  /** e.g. `https://relay.acme.internal` — no trailing `/v1`, the SDK adds the paths. */
  baseUrl: string;
  /** A virtual key: `rk_live_…` / `rk_test_…`. */
  apiKey: string;
  /** Merged into every request; per-call headers win. */
  headers?: Record<string, string>;
  /** Per-request ceiling. Default 120s — completions are legitimately slow. */
  timeoutMs?: number;
  /**
   * Off by default. When enabled, only 429/502/503 are retried, `retry-after` is honoured, and a
   * request that has already streamed a byte is NEVER re-sent — retrying a partially-consumed
   * completion bills you twice for one answer.
   */
  retry?: RetryOptions;
  fetch?: typeof fetch;
  /**
   * A virtual key is a server-side credential. Shipping one to a browser exposes it to every visitor
   * and to your own extensions; set this only when the key is genuinely public (a demo, a key with a
   * tight budget you are content to lose).
   */
  dangerouslyAllowBrowser?: boolean;
}

export class Relay {
  readonly chat: ReturnType<typeof createChat>;
  private readonly options: RelayOptions;

  constructor(options: RelayOptions) {
    if (!options.baseUrl) throw new Error('`baseUrl` is required.');
    if (!options.apiKey) throw new Error('`apiKey` is required (a virtual key, rk_live_…).');
    assertNotLeakingKeyToBrowser(options);
    this.options = options;
    this.chat = createChat(
      new Http({
        baseUrl: options.baseUrl,
        token: options.apiKey,
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.retry ? { retry: options.retry } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }),
    );
  }

  /** Read `RELAY_BASE_URL` and `RELAY_API_KEY` from the environment. Node/Bun/Deno only. */
  static fromEnv(overrides: Partial<RelayOptions> = {}): Relay {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env;
    const baseUrl = overrides.baseUrl ?? env?.RELAY_BASE_URL;
    const apiKey = overrides.apiKey ?? env?.RELAY_API_KEY;
    if (!baseUrl || !apiKey) {
      throw new Error('Set RELAY_BASE_URL and RELAY_API_KEY, or pass them explicitly.');
    }
    return new Relay({ ...overrides, baseUrl, apiKey });
  }

  /** Model discovery — the aliases this key may call. */
  models(): Promise<ModelObject[]> {
    return this.chat.models();
  }

  /**
   * The control-plane client, authenticated with a Logto access token rather than the virtual key.
   * Separate on purpose: a virtual key can never reach the control plane and an admin token can
   * never proxy a completion, and the SDK makes that a type-level fact rather than a convention.
   */
  admin(token: string): AdminClient {
    return createAdminClient({
      baseUrl: this.options.baseUrl,
      token,
      ...(this.options.headers ? { headers: this.options.headers } : {}),
      ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
      ...(this.options.retry ? { retry: this.options.retry } : {}),
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
  }
}

/** Refuse to construct a browser client holding a server-side credential, unless told to. */
function assertNotLeakingKeyToBrowser(options: RelayOptions): void {
  const inBrowser =
    typeof (globalThis as { window?: unknown }).window !== 'undefined' &&
    typeof (globalThis as { document?: unknown }).document !== 'undefined';
  if (inBrowser && !options.dangerouslyAllowBrowser) {
    throw new Error(
      'A Relay virtual key must not be shipped to the browser: anyone can read it from your bundle ' +
        'and spend against your providers. Call Relay from your server, or — if the key really is ' +
        'public — pass `dangerouslyAllowBrowser: true`.',
    );
  }
}
