/**
 * Proxy module interfaces (playbook §4 · §5). All contracts live here so implementations
 * (adapter.ts, proxy.service.ts, proxy.controller.ts) depend on abstractions, not each other.
 * The canonical shape is OpenAI Chat Completions — the gateway's Layer-2 domain type.
 */

export interface CanonicalMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CanonicalRequest {
  model: string;
  messages: CanonicalMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
}

export type ProviderName = 'openai' | 'anthropic' | 'openai_compat';

export interface Target {
  provider: ProviderName;
  model: string; // provider-native model id
  baseUrl: string;
  apiKey: string; // plaintext, decrypted in worker memory (skeleton: dummy)
}

export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A normalized streaming delta — provider-agnostic (Layer 2). */
export interface CanonicalDelta {
  text?: string;
  done?: boolean;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface SseEvent {
  event?: string;
  data: string;
}

/** Layer-1 boundary: the ONLY place a provider's native wire format lives. */
export interface ProviderAdapter {
  readonly name: ProviderName;
  translate(req: CanonicalRequest, target: Target): ProviderRequest;
  toDelta(event: SseEvent): CanonicalDelta | null;
  countTokens(req: CanonicalRequest): number;
}

/**
 * Business logic surface (no HTTP, no DB). The controller depends on this interface only.
 * `stream` yields canonical deltas; serializing them to OpenAI SSE is the controller's job.
 * Both methods throw `RelayError` (code `upstream_error` / `upstream_unreachable`) on failure.
 */
export interface ProxyService {
  complete(req: CanonicalRequest, target: Target): Promise<unknown>;
  stream(req: CanonicalRequest, target: Target): AsyncIterable<CanonicalDelta>;
}
