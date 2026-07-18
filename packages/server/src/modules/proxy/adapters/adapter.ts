/**
 * Provider adapters (playbook §4 · §6) — Layer-1 implementations. Interfaces live in
 * proxy.types.ts. A provider changing its wire format = editing one adapter + its golden
 * fixture; nothing else. Phase-1 ships `openai` (canonical passthrough) and `anthropic`
 * (translates the request and normalizes Anthropic's typed SSE events back to canonical).
 */
import type { CanonicalRequest, ProviderAdapter, ProviderName } from '../types/proxy.types.js';

function estimateTokens(req: CanonicalRequest): number {
  const chars = req.messages.reduce((n, m) => n + m.content.length, 0);
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
  countTokens: estimateTokens,
};

// ── Anthropic adapter — different request shape AND typed event stream ──────────────
export const anthropicAdapter: ProviderAdapter = {
  name: 'anthropic',
  translate(req, target) {
    const system = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    const messages = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));
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
  countTokens: estimateTokens,
};

const ADAPTERS: Record<ProviderName, ProviderAdapter> = {
  openai: openaiAdapter,
  openai_compat: openaiAdapter, // OpenAI-compatible providers reuse the OpenAI adapter
  anthropic: anthropicAdapter,
};

export function adapterFor(provider: ProviderName): ProviderAdapter {
  return ADAPTERS[provider];
}
