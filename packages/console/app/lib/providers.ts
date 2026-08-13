/**
 * Provider view model — PURE, so the credential↔route join is unit-tested without a gateway.
 *
 * Deleting a credential that a route still targets breaks that route at request time, so the detail
 * page has to answer "what depends on this?" before offering the delete. Nothing in the API answers
 * that directly — route targets carry a `credential_id`, so the console walks the route details and
 * inverts the relation here.
 */
import type { RouteDetail } from './api';

export interface CredentialUsage {
  routeId: string;
  modelName: string;
  version: number;
  /** The upstream model this target maps to. */
  model: string;
  /** True when the version holding this target is the one currently serving traffic. */
  isActive: boolean;
}

/** Every route target bound to `credentialId`, active versions first (those are the live ones). */
export function usageOfCredential(
  routes: readonly RouteDetail[],
  credentialId: string,
): CredentialUsage[] {
  const usage: CredentialUsage[] = [];
  for (const route of routes) {
    for (const version of route.versions ?? []) {
      for (const target of version.targets ?? []) {
        if (target.credential_id !== credentialId) continue;
        usage.push({
          routeId: route.id ?? '',
          modelName: route.model_name ?? '—',
          version: version.version ?? 0,
          model: target.model ?? '—',
          isActive: version.is_active === true,
        });
      }
    }
  }
  return usage.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return a.modelName.localeCompare(b.modelName) || b.version - a.version;
  });
}

/** Bucket a provider's 0..1 health score into the badge it should render. A score is only meaningful
 * once the gateway has observed traffic through the credential; `null`/absent reads as "unknown". */
export function healthTone(score: number | null | undefined): {
  label: string;
  variant: 'success' | 'secondary' | 'destructive';
} {
  if (score === null || score === undefined) return { label: 'unknown', variant: 'secondary' };
  const percent = `${Math.round(score * 100)}%`;
  if (score >= 0.9) return { label: percent, variant: 'success' };
  if (score >= 0.5) return { label: percent, variant: 'secondary' };
  return { label: percent, variant: 'destructive' };
}
