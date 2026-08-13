/**
 * Id → human label resolution — PURE, so it is unit-tested without a gateway.
 *
 * The API is honest about identity: usage events, rollup buckets and audit rows all carry opaque ids
 * (`app_id`, `route_id`, `key_id`, `actor`), because names are mutable and ids are not. That is right
 * for the wire and wrong for a screen — nobody recognises `1604fdfa-d2de-43c5-b90e-fd892649d8ee`.
 *
 * So the console resolves ids against the lists it already fetches and renders the name with the id
 * kept alongside. The id is never dropped: it is what you paste into a support ticket, a log search
 * or a Postman variable, and a name alone would make the screen useless for that.
 */
import type { Application, RouteSummary, Member } from './api';

/** A resolved id: the name to lead with, and the id it came from. */
export interface Labelled {
  /** Display name, or null when nothing could be resolved. */
  name: string | null;
  /** The raw id, always preserved. */
  id: string;
}

/** Look `id` up, keeping the id whether or not a name was found. */
export function labelOf(
  names: ReadonlyMap<string, string>,
  id: string | null | undefined,
): Labelled {
  const key = id ?? '';
  return { name: names.get(key) ?? null, id: key };
}

/** Applications keyed by id → name. */
export function appNames(apps: readonly Application[]): Map<string, string> {
  return indexBy(
    apps,
    (a) => a.id,
    (a) => a.name,
  );
}

/** Routes keyed by id → the client-facing model name, which is what a route *is* to a caller. */
export function routeNames(routes: readonly RouteSummary[]): Map<string, string> {
  return indexBy(
    routes,
    (r) => r.id,
    (r) => r.model_name,
  );
}

/**
 * Org members keyed by Logto user id → the best available human label.
 *
 * Audit rows record `actor` as the Logto subject, so this is the only way to turn "who did this" into
 * a person. Name is preferred, email is the fallback — one of the two is almost always set, and an
 * email is far more identifying than a 12-character id.
 */
export function memberNames(members: readonly Member[]): Map<string, string> {
  return indexBy(
    members,
    (m) => m.id,
    (m) => m.name ?? m.email,
  );
}

/** Virtual keys keyed by id → a recognisable label (its name, else its last-4 fingerprint). */
export function keyNames(
  keys: readonly { id?: string; name?: string | null; last4?: string }[],
): Map<string, string> {
  return indexBy(
    keys,
    (k) => k.id,
    (k) => k.name ?? (k.last4 ? `…${k.last4}` : undefined),
  );
}

/** Build an id→label map, skipping entries missing either half. */
function indexBy<T>(
  items: readonly T[],
  idOf: (item: T) => string | undefined | null,
  labelOf_: (item: T) => string | undefined | null,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of items) {
    const id = idOf(item);
    const label = labelOf_(item);
    if (id && label) map.set(id, label);
  }
  return map;
}

/**
 * The label for an analytics bucket key, which changes meaning with the grouping: `app`/`route`
 * buckets are keyed by id and need resolving, while `model`/`day` buckets are already human-readable
 * and must be passed through untouched.
 */
export function bucketLabel(
  grouping: string,
  key: string,
  maps: { apps: ReadonlyMap<string, string>; routes: ReadonlyMap<string, string> },
): Labelled {
  if (grouping === 'app') return labelOf(maps.apps, key);
  if (grouping === 'route') return labelOf(maps.routes, key);
  return { name: key, id: '' }; // model / day — the key IS the label
}

/**
 * The label for an audit row's `target`, which is an id whose *type* is implied by the action
 * (`route.delete` targets a route, `provider.create` a credential, and so on). Resolving it turns
 * "route.delete → 1604fdfa…" into "route.delete → gpt-4o-mini", which is the difference between a
 * trail you can read and one you have to cross-reference by hand.
 *
 * An action we don't recognise falls through to the bare id rather than guessing at the wrong map.
 */
export function auditTargetLabel(
  action: string | null | undefined,
  target: string | null | undefined,
  maps: {
    apps: ReadonlyMap<string, string>;
    routes: ReadonlyMap<string, string>;
    providers: ReadonlyMap<string, string>;
  },
): Labelled {
  const id = target ?? '';
  if (!id) return { name: null, id: '' };
  const kind = (action ?? '').split('.')[0];
  if (kind === 'route') return labelOf(maps.routes, id);
  if (kind === 'provider') return labelOf(maps.providers, id);
  if (kind === 'app' || kind === 'key') return labelOf(maps.apps, id);
  return { name: null, id };
}

/** Provider credentials keyed by id → name. */
export function providerNames(
  providers: readonly { id?: string; name?: string }[],
): Map<string, string> {
  return indexBy(
    providers,
    (p) => p.id,
    (p) => p.name,
  );
}

/** Shorten an id for inline display; ids are long and the leading segment is enough to recognise. */
export function shortId(id: string, length = 8): string {
  return id.length > length ? `${id.slice(0, length)}…` : id;
}
