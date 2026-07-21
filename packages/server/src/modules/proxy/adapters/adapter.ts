/**
 * Provider adapters (playbook §4 · §6) — Layer-1 implementations. Interfaces live in
 * proxy.types.ts. A provider changing its wire format = editing one adapter + its golden
 * fixture; nothing else. Phase-1 ships `openai` (canonical passthrough) and `anthropic`
 * (translates the request and normalizes Anthropic's typed SSE events back to canonical).
 */
import type {
  CanonicalRequest,
  CanonicalResponse,
  ContentPart,
  ProviderAdapter,
  ProviderName,
} from '../types/proxy.types.js';

/** Concatenate the text of a message's content, ignoring non-text (image) parts. */
function textOf(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

function estimateTokens(req: CanonicalRequest): number {
  const chars = req.messages.reduce((n, m) => n + textOf(m.content).length, 0);
  return Math.ceil(chars / 4) + (req.max_tokens ?? 0);
}

// ── OpenAI adapter — canonical is already OpenAI, so translate is near-identity ──────
export const openaiAdapter: ProviderAdapter = {
  name: 'openai',
  translate(req, target) {
    return {
      url: `${target.baseUrl}/v1/chat/completions`,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${target.apiKey}` },
      body: JSON.stringify({
        model: target.model,
        messages: req.messages,
        stream: req.stream ?? false,
        ...(req.max_tokens !== undefined ? { max_tokens: req.max_tokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.stream ? { stream_options: { include_usage: true } } : {}),
      }),
    };
  },
  toDelta(event) {
    if (event.data === '[DONE]') return { done: true };
    try {
      const j = JSON.parse(event.data) as {
        choices?: { delta?: { content?: string } }[];
        usage?: { prompt_tokens: number; completion_tokens: number };
      };
      const text = j.choices?.[0]?.delta?.content;
      const usage = j.usage
        ? { inputTokens: j.usage.prompt_tokens, outputTokens: j.usage.completion_tokens }
        : undefined;
      if (text === undefined && usage === undefined) return null;
      return { ...(text !== undefined ? { text } : {}), ...(usage ? { usage } : {}) };
    } catch {
      return null;
    }
  },
  // Canonical IS OpenAI, so the body passes through; we only lift usage for metering/budget settle.
  toResponse(json) {
    const usage = (json as { usage?: { prompt_tokens?: number; completion_tokens?: number } })
      .usage;
    return {
      body: json,
      ...(usage
        ? {
            usage: {
              inputTokens: usage.prompt_tokens ?? 0,
              outputTokens: usage.completion_tokens ?? 0,
            },
          }
        : {}),
    };
  },
  countTokens: estimateTokens,
};

/** Map Anthropic's stop_reason to the OpenAI finish_reason vocabulary. */
function anthropicFinishReason(stop: string | null | undefined): string {
  if (stop === 'max_tokens') return 'length';
  if (stop === 'tool_use') return 'tool_calls';
  return 'stop'; // end_turn, stop_sequence, null → stop
}

/** Translate canonical (OpenAI-style) content to Anthropic's content blocks. A plain string stays a
 * string; parts map text→text blocks and image_url→a URL image source (Anthropic's vision format). */
function toAnthropicContent(content: string | ContentPart[]): unknown {
  if (typeof content === 'string') return content;
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image', source: { type: 'url', url: part.image_url.url } },
  );
}

// ── Anthropic adapter — different request shape AND typed event stream ──────────────
export const anthropicAdapter: ProviderAdapter = {
  name: 'anthropic',
  translate(req, target) {
    const system = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => textOf(m.content))
      .join('\n');
    const messages = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: toAnthropicContent(m.content) }));
    return {
      url: `${target.baseUrl}/v1/messages`,
      headers: {
        'content-type': 'application/json',
        'x-api-key': target.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: target.model,
        max_tokens: req.max_tokens ?? 1024,
        stream: req.stream ?? false,
        ...(system ? { system } : {}),
        messages,
      }),
    };
  },
  toDelta(event) {
    try {
      const j = JSON.parse(event.data) as {
        type?: string;
        delta?: { text?: string };
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (j.type === 'content_block_delta' && j.delta?.text !== undefined) {
        return { text: j.delta.text };
      }
      if (j.type === 'message_delta' && j.usage) {
        return {
          usage: {
            inputTokens: j.usage.input_tokens ?? 0,
            outputTokens: j.usage.output_tokens ?? 0,
          },
        };
      }
      if (j.type === 'message_stop') return { done: true };
      return null;
    } catch {
      return null;
    }
  },
  // Anthropic's Messages body differs from OpenAI's: rebuild it as a Chat Completion so clients
  // using the OpenAI SDK get the shape they expect, and lift usage for metering/budget settle.
  toResponse(json, req): CanonicalResponse {
    const j = json as {
      id?: string;
      model?: string;
      stop_reason?: string | null;
      content?: { type?: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (j.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
    const inputTokens = j.usage?.input_tokens ?? 0;
    const outputTokens = j.usage?.output_tokens ?? 0;
    return {
      body: {
        id: j.id ?? 'chatcmpl-anthropic',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: j.model ?? req.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: anthropicFinishReason(j.stop_reason),
          },
        ],
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        },
      },
      usage: { inputTokens, outputTokens },
    };
  },
  countTokens: estimateTokens,
};

// ── OpenAI-compatible adapter (vLLM / Ollama / LM Studio) ────────────────────────────
// Same wire format as OpenAI, but these are self-hosted at an arbitrary base URL and many run
// without auth. So we reuse the OpenAI translation and rewrite one header: send Authorization only
// when a key is actually configured, so a local Ollama (no key) isn't handed a bogus "Bearer ".
export const openaiCompatAdapter: ProviderAdapter = {
  name: 'openai_compat',
  translate(req, target) {
    const base = openaiAdapter.translate(req, target);
    if (target.apiKey) return base;
    // Local servers (e.g. Ollama) need no auth — strip the Authorization header we'd otherwise send.
    const headers = { ...base.headers };
    delete headers.authorization;
    return { ...base, headers };
  },
  toDelta: (event) => openaiAdapter.toDelta(event),
  toResponse: (json, req) => openaiAdapter.toResponse(json, req),
  countTokens: estimateTokens,
};

const ADAPTERS: Record<ProviderName, ProviderAdapter> = {
  openai: openaiAdapter,
  openai_compat: openaiCompatAdapter,
  anthropic: anthropicAdapter,
};

export function adapterFor(provider: ProviderName): ProviderAdapter {
  return ADAPTERS[provider];
}
