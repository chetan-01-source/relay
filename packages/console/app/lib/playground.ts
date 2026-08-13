/**
 * Playground view model — PURE, so response parsing is unit-tested without a gateway.
 *
 * The playground shows two things about a completion: the assistant's text, and what the gateway did
 * to produce it (the `x-relay-*` headers). Both come out of an `unknown` response body — the console
 * never assumes the upstream returned a well-formed OpenAI envelope, because a failing provider can
 * return anything. Every reader here narrows defensively and falls back to null.
 */
import type { RelayHeaders } from './api';

/** The assistant's reply text, or null when the body isn't an OpenAI completion envelope. */
export function completionText(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: { content?: unknown } })?.message;
  return typeof message?.content === 'string' ? message.content : null;
}

/** The gateway's error message, or null. Relay speaks the OpenAI error envelope end to end, so a
 * 4xx/5xx body is `{ error: { message, type, code } }` whatever the upstream failure was. */
export function errorMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const error = (body as { error?: { message?: unknown } }).error;
  return typeof error?.message === 'string' ? error.message : null;
}

export interface TokenUsage {
  input: number;
  output: number;
}

/** Token counts from the `usage` block, or null when the upstream omitted it. */
export function tokenUsage(body: unknown): TokenUsage | null {
  if (typeof body !== 'object' || body === null) return null;
  const usage = (body as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } })
    .usage;
  if (!usage) return null;
  const input = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const output = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
  return { input, output };
}

export interface HeaderFact {
  label: string;
  value: string;
  /** True when this fact is worth calling out visually (a cache hit, a failover, a real cost). */
  notable: boolean;
}

/** Turn the `x-relay-*` headers into labelled facts for the inspector. Headers the gateway didn't
 * send are dropped rather than rendered as "—", so the panel only ever shows what actually happened.
 * Mirrors the contract documented in docs/response-headers.md. */
export function headerFacts(headers: RelayHeaders): HeaderFact[] {
  const facts: HeaderFact[] = [];
  if (headers.provider) {
    facts.push({ label: 'Provider', value: headers.provider, notable: false });
  }
  if (headers.cache) {
    facts.push({ label: 'Cache', value: headers.cache, notable: headers.cache !== 'miss' });
  }
  if (headers.failover) {
    facts.push({
      label: 'Failover',
      value: headers.failover,
      notable: headers.failover === 'true',
    });
  }
  if (headers.costUsd) {
    facts.push({
      label: 'Cost (USD)',
      value: headers.costUsd,
      notable: Number(headers.costUsd) > 0,
    });
  }
  if (headers.modalities) {
    facts.push({ label: 'Modalities', value: headers.modalities, notable: false });
  }
  return facts;
}
