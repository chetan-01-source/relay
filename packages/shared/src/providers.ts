/**
 * The provider registry — ONE list of every upstream Relay can talk to, shared by the gateway and
 * the console.
 *
 * It lives in `shared` because the same facts were otherwise needed in four places that drift
 * independently: the proxy's adapter lookup, the providers route schema's enum, the console's
 * "add a credential" form, and the SQL CHECK constraint. Four hand-maintained copies of one list is
 * three chances to add a provider the UI cannot create or the gateway cannot route. Here, adding a
 * provider is one entry plus one migration line.
 *
 * The key insight this encodes: **most providers are not new wire formats.** OpenRouter, Groq,
 * Together, DeepSeek, Mistral, Fireworks, xAI, Perplexity and Google's compatibility endpoint all
 * speak OpenAI's protocol. They differ only in base URL, branding, and which models they carry. So
 * `wire` — the thing the proxy dispatches on — has three values, while `PROVIDERS` has many. A new
 * OpenAI-compatible vendor costs an entry here and no adapter code at all.
 */

/** The wire protocols the proxy actually implements. One adapter per value, no more. */
export type ProviderWire = 'openai' | 'anthropic' | 'azure';

export interface ProviderInfo {
  /** Stable id: the value stored in `provider_credentials.provider` and sent over the API. */
  id: string;
  /** Human label for the console. */
  label: string;
  /** Which adapter serves it. */
  wire: ProviderWire;
  /**
   * Default upstream base URL. The proxy appends the wire format's path (`/v1/chat/completions` for
   * OpenAI-shaped providers), so this is the origin plus any vendor prefix and no trailing slash.
   * `null` means the operator must supply one — a self-hosted server has no canonical address.
   */
  defaultBaseUrl: string | null;
  /**
   * Where `relay sync-models` reads this provider's catalog, relative to the base URL. `null` means
   * the provider publishes no machine-readable list and its models come from the static seed.
   */
  modelsPath: string | null;
  /**
   * True when the models endpoint also returns per-token prices. Only OpenRouter does today, and it
   * is the difference between rate cards that are correct by construction and rate cards that are
   * someone's best guess going stale in a migration.
   */
  publishesPricing: boolean;
  /** False for servers that legitimately run unauthenticated, e.g. a local Ollama. */
  requiresApiKey: boolean;
  /** One line for the console, explaining what this is when the name is not self-evident. */
  hint: string;
}

/**
 * Every supported provider. Ordered roughly by how likely someone is to reach for it, because this
 * order is what the console's dropdown renders.
 */
export const PROVIDERS = [
  {
    id: 'openai',
    label: 'OpenAI',
    wire: 'openai',
    defaultBaseUrl: 'https://api.openai.com',
    modelsPath: '/v1/models',
    publishesPricing: false,
    requiresApiKey: true,
    hint: 'GPT models direct from OpenAI.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    wire: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    modelsPath: '/v1/models',
    publishesPricing: false,
    requiresApiKey: true,
    hint: 'Claude models direct from Anthropic.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    wire: 'openai',
    defaultBaseUrl: 'https://openrouter.ai/api',
    modelsPath: '/v1/models',
    publishesPricing: true,
    requiresApiKey: true,
    hint: 'One key, hundreds of models across vendors. Publishes its own prices.',
  },
  {
    id: 'azure_openai',
    label: 'Azure OpenAI',
    wire: 'azure',
    defaultBaseUrl: null,
    modelsPath: null,
    publishesPricing: false,
    requiresApiKey: true,
    hint: 'Your own Azure resource — base URL is per-resource, e.g. https://acme.openai.azure.com.',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    wire: 'openai',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    modelsPath: '/models',
    publishesPricing: false,
    requiresApiKey: true,
    hint: 'Gemini through its OpenAI-compatible endpoint.',
  },
  {
    id: 'groq',
    label: 'Groq',
    wire: 'openai',
    defaultBaseUrl: 'https://api.groq.com/openai',
    modelsPath: '/v1/models',
    publishesPricing: false,
    requiresApiKey: true,
    hint: 'Open-weight models on Groq hardware.',
  },
  {
    id: 'together',
    label: 'Together AI',
    wire: 'openai',
    defaultBaseUrl: 'https://api.together.xyz',
    modelsPath: '/v1/models',
    publishesPricing: false,
    requiresApiKey: true,
    hint: 'Open-weight models, hosted.',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    wire: 'openai',
    defaultBaseUrl: 'https://api.mistral.ai',
    modelsPath: '/v1/models',
    publishesPricing: false,
    requiresApiKey: true,
    hint: 'Mistral models direct from Mistral.',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    wire: 'openai',
    defaultBaseUrl: 'https://api.deepseek.com',
    modelsPath: '/v1/models',
    publishesPricing: false,
    requiresApiKey: true,
    hint: 'DeepSeek models direct.',
  },
  {
    id: 'fireworks',
    label: 'Fireworks',
    wire: 'openai',
    defaultBaseUrl: 'https://api.fireworks.ai/inference',
    modelsPath: '/v1/models',
    publishesPricing: false,
    requiresApiKey: true,
    hint: 'Open-weight models, hosted.',
  },
  {
    id: 'xai',
    label: 'xAI',
    wire: 'openai',
    defaultBaseUrl: 'https://api.x.ai',
    modelsPath: '/v1/models',
    publishesPricing: false,
    requiresApiKey: true,
    hint: 'Grok models.',
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    wire: 'openai',
    defaultBaseUrl: 'https://api.perplexity.ai',
    modelsPath: null,
    publishesPricing: false,
    requiresApiKey: true,
    hint: 'Sonar models, search-grounded.',
  },
  {
    id: 'openai_compat',
    label: 'OpenAI-compatible (self-hosted)',
    wire: 'openai',
    defaultBaseUrl: null,
    modelsPath: '/v1/models',
    publishesPricing: false,
    requiresApiKey: false,
    hint: 'Anything speaking the OpenAI protocol: Ollama, vLLM, LM Studio, a vendor not listed here.',
  },
] as const satisfies readonly ProviderInfo[];

/**
 * The union of supported provider ids, derived from the list rather than restated. `satisfies` above
 * keeps each entry type-checked while preserving its literal types, so adding a provider to the
 * array extends this type automatically — and a typo in a provider id anywhere becomes a compile
 * error instead of a request that 404s at runtime.
 */
export type ProviderId = (typeof PROVIDERS)[number]['id'];

/** Every provider id, for route schema enums and validation. */
export const PROVIDER_IDS: readonly ProviderId[] = PROVIDERS.map((p) => p.id);

const BY_ID = new Map<string, ProviderInfo>(PROVIDERS.map((p) => [p.id, p]));

/** Look up a provider, or `undefined` if the id is not one we support. */
export function providerInfo(id: string): ProviderInfo | undefined {
  return BY_ID.get(id);
}

/**
 * True when `id` is a provider Relay can route to. A type guard, so validating a string from a form
 * post or a query parameter also narrows it to `ProviderId` — the check and the type then cannot
 * disagree, and no caller needs a cast to pass it on.
 */
export function isKnownProvider(id: string): id is ProviderId {
  return BY_ID.has(id);
}

/**
 * Which adapter serves a provider. Unknown ids fall back to the OpenAI wire rather than throwing:
 * a credential stored by a NEWER gateway, then read by an older one mid-rollout, should degrade to
 * the most likely protocol instead of failing every request during the deploy.
 */
export function wireFor(id: string): ProviderWire {
  return BY_ID.get(id)?.wire ?? 'openai';
}
