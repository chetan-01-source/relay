/**
 * Catalogue view model — PURE, so the grouping is unit-tested without a gateway.
 */
import { providerInfo } from 'relay-shared';

export interface CatalogGroup {
  provider: string;
  /** Human label from the shared registry, so the page and the picker name vendors identically. */
  label: string;
  models: { model?: string }[];
}

/**
 * Group catalogue rows by provider, preserving the order the gateway returned them in (it sorts by
 * provider then model, so groups come out alphabetical and models stay sorted inside each).
 *
 * A provider id with no registry entry still gets a group rather than being dropped: the catalogue
 * is refreshed independently of the code, so a row can outlive the registry entry that produced it,
 * and silently hiding it would look like the sync had failed.
 */
export function groupByProvider<T extends { provider?: string; model?: string }>(
  models: readonly T[],
): CatalogGroup[] {
  const groups = new Map<string, CatalogGroup>();
  for (const model of models) {
    const provider = model.provider ?? 'unknown';
    let group = groups.get(provider);
    if (!group) {
      group = { provider, label: providerInfo(provider)?.label ?? provider, models: [] };
      groups.set(provider, group);
    }
    group.models.push(model);
  }
  return [...groups.values()];
}
