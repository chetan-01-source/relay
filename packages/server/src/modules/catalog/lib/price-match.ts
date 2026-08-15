/**
 * Matching a direct provider's model id to the same model on OpenRouter — PURE, so the id shapes
 * are unit-testable without a network.
 *
 * The problem this solves: OpenAI and Anthropic do not publish prices through their APIs, so a
 * request through a direct credential settles at cost 0 while the identical model through OpenRouter
 * settles correctly. OpenRouter DOES publish per-token prices, and it carries the same vendor
 * models — so its price for `anthropic/claude-haiku-4.5` is a usable figure for Anthropic's own
 * `claude-haiku-4-5-20251001`.
 *
 * These are OPENROUTER'S published prices, not the vendor's own rate card. They are the right
 * order of magnitude and generally the vendor's list price, but a negotiated or promotional rate on
 * a direct account will differ. That is why the derivation is opt-in, why every mapping is logged,
 * and why a price the provider reports at request time always wins over one derived here.
 */

/**
 * Reduce a model id to what identifies the MODEL, discarding how a particular vendor spells it.
 *
 *   anthropic/claude-haiku-4.5      → claudehaiku45
 *   claude-haiku-4-5-20251001       → claudehaiku45
 *
 * Three transformations, each earning its place:
 *   1. the vendor prefix goes — OpenRouter namespaces ids, the vendor does not;
 *   2. a trailing 8-digit date goes — Anthropic pins snapshots, OpenRouter tracks the family;
 *   3. separators go — the same version is `4.5` on one and `4-5` on the other.
 *
 * Deliberately NOT fuzzy beyond that. Suffixed variants (`-fast`, `:batch`) normalize to a different
 * string and therefore do not match, which is correct: they are priced differently.
 */
export function normalizeModelId(id: string): string {
  const withoutVendor = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
  const withoutDate = withoutVendor.replace(/-\d{8}$/, '');
  return withoutDate.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface PricedModel {
  model: string;
  inputUsdPer1k: number;
  outputUsdPer1k: number;
}

/**
 * For each model of a direct provider, the OpenRouter price of the same model — where one exists.
 *
 * Ambiguity is refused rather than guessed: if two OpenRouter ids normalize to the same key with
 * DIFFERENT prices, neither is used. A wrong price is worse than no price, because a missing one is
 * visibly zero while a wrong one looks plausible on an invoice.
 */
export function matchPrices(
  providerModels: readonly string[],
  openRouterPrices: readonly PricedModel[],
): Map<string, PricedModel> {
  const byKey = new Map<string, PricedModel | null>();
  for (const priced of openRouterPrices) {
    const key = normalizeModelId(priced.model);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, priced);
      continue;
    }
    if (existing === null) continue; // already known-ambiguous
    const differs =
      existing.inputUsdPer1k !== priced.inputUsdPer1k ||
      existing.outputUsdPer1k !== priced.outputUsdPer1k;
    if (differs) byKey.set(key, null);
  }

  const matched = new Map<string, PricedModel>();
  for (const model of providerModels) {
    const candidate = byKey.get(normalizeModelId(model));
    if (candidate) matched.set(model, candidate);
  }
  return matched;
}
