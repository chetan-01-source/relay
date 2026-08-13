# ADR-0014 — Plans, entitlements and quota enforcement

- **Status:** accepted
- **Date:** 2026-08-11
- **Supersedes:** nothing. **Extends:** ADR-0004 (tenancy onboarding), ADR-0007 (policy limits and budgets)

## Context

Relay already has three of the four pieces a plan-based product needs, and they were built
independently:

| Piece                 | Where it lives today                                         | Scope                                 |
| --------------------- | ------------------------------------------------------------ | ------------------------------------- |
| Boolean feature flags | `org_features` (0002) → `snapshot.entitlements`              | per org, manual                       |
| Rate limits           | `rate_limits` (0006) → `snapshot.policy.rateLimit`           | per org, manual                       |
| Spend ceilings        | `budgets` (0006, 0013) → `snapshot.policy.budgets`           | per org/app, manual                   |
| Named bundles         | `tenancy/lib/entitlements.ts` (`default`/`trial`/`internal`) | code only, applied once at onboarding |

Three problems follow from that shape:

1. **The bundles are write-once.** `resolveTemplate()` runs at onboarding and copies flags into
   `org_features`. After that the template is forgotten — there is no row that says "this org is on
   trial", nothing expires, and changing a template does not change any existing org.
2. **Nothing is countable.** Every limit that exists is a _rate_ or a _spend_. There is no ceiling on
   applications, providers, routes, members or retention, which is exactly the axis a SaaS tier sells
   on.
3. **Only one flag is enforced.** `cache.exact` is read in `proxy.controller.ts`;
   `modalities.image` and `routing.failover` are stored, displayed in the console's matrix editor,
   and ignored by the gateway. A flag nobody enforces is a lie in a UI.

We want to sell a hosted Relay in tiers _and_ keep the self-hosted Apache-2.0 build honest — a
self-hoster must never hit a limit that exists only to make them pay us.

## Decision

Introduce a **plan** as the named, versioned source of every limit, and resolve an org's _effective
entitlements_ at snapshot-build time from three layers.

### 1. Two tables (migration 0017)

```
plans                 catalog. code, tier, name, limits jsonb, prices, public, active
org_subscriptions     one row per org. plan_code, status, trial_ends_at, overrides jsonb
```

`plans` is **platform-scoped**, not tenant-scoped: it is a catalog, identical for every org, so it
carries no `org_id` and no tenant RLS policy — reads are open, writes are platform-admin only.
`org_subscriptions` is tenant-scoped with the standard forced-RLS pair.

`limits` is one `jsonb` object rather than 20 columns. Limits are the part of this system most likely
to change weekly during pricing experiments, and a pricing experiment must not require a migration.
The keys are a closed, typed set in `plans/lib/limits.ts` — the flexibility is in the storage, not in
the contract.

### 2. Three-layer resolution, most specific wins

```
plan.limits                    the tier's defaults
  ⊕ org_subscriptions.overrides negotiated per contract ("enterprise, but 40 seats")
  ⊕ org_features                the existing per-flag table — platform-admin escape hatch
  = effective entitlements
```

`org_features` stays exactly as it is and stays the **highest** precedence. That is deliberate: it is
already wired into the console's matrix editor, already invalidated over `org.features.updated`, and
it is the lever support reaches for at 2am when one customer needs one flag on. Putting the plan
_underneath_ it means the plan layer is additive — no existing behaviour changes for an org that has
a plan matching what it already had.

### 3. Resolution happens where the snapshot is built, not on the hot path

The effective map is computed once in `identity.repository.resolveByKeyId()` — the same read that
already loads `org_features` and the policy — and lands in `VirtualKeySnapshot.entitlements` and
`.policy`. The hot path keeps reading a plain resolved map. **No request pays for plan resolution**;
it is amortised into the existing cold-key read, and invalidated by the existing pub/sub channels.

A plan change therefore reaches every worker in ≤1s through `org.policy.updated` — the same channel a
budget edit uses, for the same reason.

### 4. Rate limits and spend caps compose as `min()`, never `max()`

An org can set `rate_limits.rpm` and `budgets.limit_usd` for itself today. Under a plan those become
_requests_, not _grants_:

```
effective rpm   = min(plan.rate.rpm, org rate_limits.rpm)     — nulls mean "no opinion"
effective spend = the org's own budgets, PLUS an implicit monthly org-wide ceiling at
                  plan.spend.monthly_usd with hard_cutoff = true
```

A tenant lowering their own limit is self-service and always allowed. A tenant _raising_ it past the
plan is not — and rather than rejecting the write (which makes the console feel broken), the write is
accepted and the enforcement takes the minimum. The console shows both numbers and says which one is
binding. This is the behaviour that survives a downgrade: an org on Scale with `rpm = 6000` that
drops to Pro does not need its config rewritten, it just starts being enforced at 600.

### 5. Countable quotas are enforced at the write, not on read

`apps.max`, `providers.max`, `routes.max`, `keys.per_app.max`, `members.max` are checked inside the
same transaction as the insert, by a shared `assertQuota()` helper in the plans module. Checking
inside the transaction is what makes it correct under concurrency: two simultaneous "create app"
calls on a 10-app plan cannot both see 9.

Exceeding one returns **409 `quota_exceeded`** with `param` naming the quota, never a bare 400 — the
SDK and the console both branch on it to show an upgrade path instead of a validation error.

### 6. Feature gates return 403 `plan_upgrade_required`, and are enforced server-side

Every flag in the entitlement map gets exactly one enforcement point, and the console's matrix editor
stops listing flags that have none. `routing.failover` off means the routing service hands the proxy
one target instead of the ordered list; `modalities.image` off means an image part in the request
body is rejected before the upstream call.

### 7. Trials expire on read, not on a cron

`status = 'trialing'` with `trial_ends_at` in the past resolves to the **free** plan's limits at
resolution time. No scheduled job, nothing to miss, no window where an expired trial still has Scale
limits because a worker was restarting. The row keeps saying `trialing` so the console can render
"your trial ended on the 3rd" rather than silently showing Free.

### 8. Editions: the plan layer is inert in OSS

`RELAY_EDITION` is `oss` (default) or `cloud`.

- **oss** — `PlanService` resolves every org to the built-in `self_hosted` plan: every limit `null`
  (unlimited), every feature `true`. Quota checks compile to a no-op. No pricing UI, no billing
  routes, no signup. A self-hoster cannot be limited by code they own.
- **cloud** — plans come from the table, quotas bite, and `packages/cloud` adds billing.

The switch is one function returning a different `PlanService` implementation from the composition
root. Not a fork, not a build flag scattered through call sites. See [editions.md](../editions.md).

## Consequences

**Good**

- One place to answer "what may this org do" — the effective map — instead of three tables and a code
  template.
- Pricing changes are a row edit, not a deploy.
- The hot path is unchanged: same snapshot, same cache, same invalidation channels.
- Self-hosted stays genuinely unlimited, which is the only version of an open-core story a developer
  audience accepts.
- Every unenforced flag either gains an enforcement point or leaves the UI.

**Costs**

- A fourth precedence layer. Mitigated by returning the _provenance_ of every effective value from
  `GET /api/v1/plan` — the console shows "600 rpm (from plan Pro)" vs "(override)", so nobody has to
  reason about precedence from memory.
- `limits` as jsonb loses column-level typing in the database. Mitigated by a Zod schema at the
  module boundary and a seed migration for the built-in tiers.
- Two enforcement points per countable resource (service write path + console pre-check for the
  message). The console pre-check is advisory only; the server's is authoritative.

## Alternatives rejected

- **Extend `ENTITLEMENT_TEMPLATES` in code with limits.** Cheapest, and where the trial/default/
  internal bundles already live. Rejected because a price change would need a release, an org could
  not be given a bespoke ceiling without a code branch, and there is no place to record trial expiry.
- **Per-plan columns instead of jsonb.** Better typing, but a migration per pricing experiment.
- **Enforce quotas in a preHandler.** Reads cleanly at the route, but runs outside the write
  transaction, so it races. The check has to be where the insert is.
- **A cron that downgrades expired trials.** More moving parts and a correctness window for no gain
  over resolving at read time.
