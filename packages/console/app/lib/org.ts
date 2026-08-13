/**
 * Which organization the console acts as — PURE, so it is unit-tested without Next or a Logto
 * session (the session read that feeds it lives in api.ts, next to the token mint it serves).
 *
 * The gateway derives the caller's tenant from the JWT's `organization_id` claim
 * (server: modules/identity/services/jwt.ts). Logto only sets that claim on an **organization-scoped**
 * token — a plain API-resource token names no tenant at all. So the console must say which org it
 * wants a token for, and this is the rule for choosing.
 *
 * The candidate list is the ID token's `organizations` claim, which Logto populates only when
 * `urn:logto:scope:organizations` was requested at sign-in (see lib/logto.ts).
 */

/**
 * Choose the organization to act as, given the user's memberships.
 *
 * `preferred` wins when the user is actually a member of it (a future org switcher can pass the
 * user's stored choice); membership is re-checked rather than trusted, so a stale preference for an
 * org the user was removed from falls back instead of minting a token the gateway would reject.
 *
 * Sorted before picking, so a multi-org user gets a stable org across requests rather than one that
 * depends on the order Logto happened to return.
 */
export function pickOrgId(
  organizations: readonly string[] | undefined,
  preferred?: string,
): string | null {
  const ids = [...(organizations ?? [])].filter(Boolean).sort((a, b) => a.localeCompare(b));
  if (ids.length === 0) return null;
  if (preferred && ids.includes(preferred)) return preferred;
  return ids[0] ?? null;
}
