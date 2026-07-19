/**
 * The entitlement flags the console's matrix editor renders. Kept in sync with the server's
 * entitlement templates (tenancy/lib/entitlements.ts). Boolean flags only, for the simple matrix UI.
 */
export const FEATURE_KEYS = ['cache.exact', 'modalities.image', 'routing.failover'] as const;
