/**
 * Entitlement templates (Week 2 Day 7). Named bundles of feature flags applied to org_features at
 * onboarding. Pure data + a resolver — no IO. Feature keys match those the policy/routing snapshot
 * reads later (e.g. 'cache.exact', 'modalities.image'); values are JSON, stored per-org.
 */
import type { EntitlementTemplateName } from '../types/tenancy.types.js';

export const ENTITLEMENT_TEMPLATES: Record<EntitlementTemplateName, Record<string, unknown>> = {
  // The baseline every paying org gets.
  default: {
    'cache.exact': true,
    'modalities.image': false,
    'routing.failover': true,
  },
  // A time-boxed evaluation: core features on, advanced ones off.
  trial: {
    'cache.exact': false,
    'modalities.image': false,
    'routing.failover': false,
  },
  // Dogfooding / internal orgs: everything on.
  internal: {
    'cache.exact': true,
    'modalities.image': true,
    'routing.failover': true,
  },
};

export const DEFAULT_TEMPLATE: EntitlementTemplateName = 'default';

/** Resolve a template name to its feature map. Unknown names fall back to `default`. */
export function resolveTemplate(
  name: EntitlementTemplateName | undefined,
): Record<string, unknown> {
  return ENTITLEMENT_TEMPLATES[name ?? DEFAULT_TEMPLATE] ?? ENTITLEMENT_TEMPLATES[DEFAULT_TEMPLATE];
}
