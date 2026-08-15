/**
 * Provider model-list parsers — PURE, so every shape a provider might return is unit-testable
 * without a network. This is where vendor quirks are absorbed; nothing above this file knows that
 * OpenRouter quotes prices per token as strings or that Anthropic omits a `data` envelope key.
 *
 * The governing rule: **an unparseable entry is skipped, never guessed at.** A model we fail to read
 * simply does not enter the catalog, and a route naming it 404s with `model_not_found` — a clear,
 * correct failure. Inventing a default price instead would put a wrong number into billing, which
 * nobody would notice until an invoice was wrong.
 */
import type { DiscoveredModel, ModelCapabilities } from '../types/catalog.types.js';

/**
 * What we assume when a provider lists a model but says nothing about it — which is the common case,
 * since OpenAI-style `/v1/models` returns little more than ids. Text and streaming are the floor for
 * anything reachable through a chat-completions endpoint; `tools` is left false because claiming a
 * capability the model lacks turns a clean routing rejection into an upstream error.
 */
const DEFAULT_CAPABILITIES: ModelCapabilities = {
  modalities: ['text'],
  streaming: true,
  tools: false,
};

/**
 * The `data` array out of any provider's envelope, or `[]` for anything else.
 *
 * Guards the null case explicitly: `null` is typeof 'object', so reading `.data` off it throws, and
 * a provider (or a proxy in front of one) answering `200` with a `null` body is exactly the kind of
 * thing that happens during an incident. A sync must degrade to "found no models" there, not crash
 * and abandon the remaining providers.
 */
function entriesOf(json: unknown): Record<string, unknown>[] {
  if (json === null || typeof json !== 'object') return [];
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  // Non-object entries are dropped here rather than in each parser, so no caller has to remember
  // that `null` passes a `typeof === 'object'` check and then throws on property access.
  return data.filter(
    (entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object',
  );
}

/** Anything that is a finite, non-negative number after coercion. Rejects NaN, Infinity, and junk. */
function finiteNumber(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * OpenAI's `/v1/models` shape — `{ data: [{ id }] }` — which Groq, Together, Mistral, DeepSeek,
 * Fireworks, xAI and the self-hosted servers all copy. Google's compatibility endpoint returns the
 * same envelope but spells ids `models/gemini-…`, so the prefix is trimmed to leave the id the
 * chat endpoint actually accepts.
 */
export function parseOpenAiModels(json: unknown): DiscoveredModel[] {
  const models: DiscoveredModel[] = [];
  for (const entry of entriesOf(json)) {
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== 'string' || id.length === 0) continue;
    models.push({
      model: id.startsWith('models/') ? id.slice('models/'.length) : id,
      capabilities: DEFAULT_CAPABILITIES,
    });
  }
  return models;
}

/**
 * OpenRouter's `/v1/models` — the only provider that publishes prices, and the reason this whole
 * command exists. Prices arrive as decimal strings in USD **per single token** (`"0.0000005"`), so
 * they are scaled to Relay's per-1,000-token unit.
 *
 * A model whose prices are missing or unparseable is still catalogued, just without a rate card:
 * routing to it should work, and its cost is reported as zero rather than as a fabricated number.
 * `"0"` is a real price — several free models use it — so zero is preserved, not treated as absent.
 */
export function parseOpenRouterModels(json: unknown): DiscoveredModel[] {
  const models: DiscoveredModel[] = [];
  for (const entry of entriesOf(json)) {
    const row = entry as {
      id?: unknown;
      context_length?: unknown;
      architecture?: { input_modalities?: unknown };
      pricing?: { prompt?: unknown; completion?: unknown };
    };
    if (typeof row.id !== 'string' || row.id.length === 0) continue;

    const modalities = Array.isArray(row.architecture?.input_modalities)
      ? row.architecture.input_modalities.filter((m): m is string => typeof m === 'string')
      : [];
    const maxTokens = finiteNumber(row.context_length);

    const promptPerToken = finiteNumber(row.pricing?.prompt);
    const completionPerToken = finiteNumber(row.pricing?.completion);

    models.push({
      model: row.id,
      capabilities: {
        modalities: modalities.length > 0 ? modalities : DEFAULT_CAPABILITIES.modalities,
        streaming: true,
        tools: false,
        ...(maxTokens !== undefined ? { max_tokens: Math.round(maxTokens) } : {}),
      },
      // Both halves or neither: a rate card with a price for one direction and a guess for the other
      // would mis-bill every request rather than simply not billing.
      ...(promptPerToken !== undefined && completionPerToken !== undefined
        ? {
            inputUsdPer1k: promptPerToken * 1000,
            outputUsdPer1k: completionPerToken * 1000,
          }
        : {}),
    });
  }
  return models;
}

/**
 * Anthropic's `/v1/models` — `{ data: [{ id, display_name }] }`. Same envelope as OpenAI's, but
 * kept separate because Anthropic's request needs different headers and because the two are free to
 * diverge without one silently breaking the other.
 */
export function parseAnthropicModels(json: unknown): DiscoveredModel[] {
  const models: DiscoveredModel[] = [];
  for (const entry of entriesOf(json)) {
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== 'string' || id.length === 0) continue;
    models.push({
      // Every current Claude model accepts images and tools; the catalog's capability filter is what
      // decides whether an image request may route here at all.
      model: id,
      capabilities: { modalities: ['text', 'image'], streaming: true, tools: true },
    });
  }
  return models;
}

/** Pick the parser for a provider. The wire format decides, not the vendor name. */
export function parserFor(providerId: string): (json: unknown) => DiscoveredModel[] {
  if (providerId === 'openrouter') return parseOpenRouterModels;
  if (providerId === 'anthropic') return parseAnthropicModels;
  return parseOpenAiModels;
}

/**
 * Round to `rate_cards`' stored scale the way POSTGRES does, which is not the way `toFixed` does.
 *
 * `numeric(12,6)` rounds half away from zero, so it stores 0.0000375 as 0.000038. `toFixed(6)` works
 * on the binary double, where 0.0000375 is really 0.00003749999…, and rounds it DOWN to 0.000037.
 * Comparing a stored value against a `toFixed` one therefore reports a difference that does not
 * exist — and since the sync reacts by writing a new rate-card version, the row would be rewritten
 * on every run forever: unbounded growth, and a price history full of changes that never happened.
 * (Observed exactly once in a 413-model OpenRouter sync, on `cohere/command-r7b-12-2024`.)
 *
 * `toPrecision(15)` first discards the binary noise below the 15th significant digit, leaving a
 * value whose decimal expansion is what the provider actually published; only then is it rounded.
 */
function toStoredScale(value: number): string {
  const scaled = Number((value * 1e6).toPrecision(15));
  return (Math.round(scaled) / 1e6).toFixed(6);
}

/**
 * Has the price actually moved? Compared at the stored scale rather than as raw floats, so that
 * re-syncing unchanged prices writes nothing.
 */
export function priceChanged(
  storedInput: string,
  storedOutput: string,
  nextInput: number,
  nextOutput: number,
): boolean {
  return (
    toStoredScale(Number(storedInput)) !== toStoredScale(nextInput) ||
    toStoredScale(Number(storedOutput)) !== toStoredScale(nextOutput)
  );
}

/** Capabilities differ in a way worth writing? Key order must not count as a change. */
export function capabilitiesChanged(
  stored: ModelCapabilities | undefined,
  next: ModelCapabilities,
): boolean {
  return stableJson(stored ?? {}) !== stableJson(next);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}
