# Plans, quotas and entitlements

How Relay turns a tier name into an enforced limit. Design rationale is in
[ADR-0014](adr/0014-plans-and-entitlements.md); this is the reference.

> **Self-hosting?** Skip to [Editions](editions.md). In the `oss` edition every org resolves to the
> built-in `self_hosted` plan — unlimited everything — and nothing on this page applies to you.

---

## 1. The model in one picture

```
                 ┌───────────────────────────────────────────────┐
   plans         │ code · tier · limits{} · prices · public      │   platform catalog, no org_id
                 └───────────────────────┬───────────────────────┘
                                         │ plan_code
                 ┌───────────────────────▼───────────────────────┐
   org_          │ org_id · status · trial_ends_at · overrides{} │   one row per org, RLS
   subscriptions └───────────────────────┬───────────────────────┘
                                         │
   org_features  ─────────────────────────┤   per-flag escape hatch, highest precedence
                                         │
                                         ▼
                          effective entitlements  ──►  VirtualKeySnapshot
                                                        (cached in-process, ≤1s invalidation)
```

Resolution order, **most specific wins**:

```
plan.limits  ⊕  subscription.overrides  ⊕  org_features  =  effective
```

`GET /api/v1/plan` returns the effective value _and its provenance_ for every key, so the console can
say "600 rpm — from plan **Pro**" or "600 rpm — **override**" instead of asking anyone to remember
this order.

---

## 2. Tiers

Built-in plans, seeded by migration `0017`. Prices are USD/month; `null` means unlimited.

| Limit key                | `free` |   `pro` |   `scale` | `enterprise` | `self_hosted` |
| ------------------------ | -----: | ------: | --------: | -----------: | ------------: |
| **Price**                |     $0 |     $49 |      $499 |       custom |            $0 |
| `apps.max`               |      1 |      10 |       100 |         null |          null |
| `providers.max`          |      1 |       5 |        25 |         null |          null |
| `routes.max`             |      2 |      25 |       250 |         null |          null |
| `keys.per_app.max`       |      2 |      10 |        50 |         null |          null |
| `members.max`            |      3 |      10 |        50 |         null |          null |
| `rate.rpm`               |     60 |     600 |     6 000 |         null |          null |
| `rate.tpm`               | 60 000 | 600 000 | 6 000 000 |         null |          null |
| `spend.monthly_usd.max`  |     25 |   2 500 |    50 000 |         null |          null |
| `retention.traffic_days` |      7 |      30 |        90 |          365 |          null |
| **Features**             |        |         |           |              |               |
| `cache.exact`            |      ✗ |       ✓ |         ✓ |            ✓ |             ✓ |
| `routing.failover`       |      ✗ |       ✓ |         ✓ |            ✓ |             ✓ |
| `modalities.image`       |      ✗ |       ✓ |         ✓ |            ✓ |             ✓ |
| `notifications.chat`     |      ✗ |       ✓ |         ✓ |            ✓ |             ✓ |
| `analytics.export`       |      ✗ |       ✓ |         ✓ |            ✓ |             ✓ |

`self_hosted` is not purchasable and is not listed in the catalog API. It is the value the `oss`
edition returns for every org.

Two things a tier might be expected to sell are deliberately **absent from the limit vocabulary**,
because neither has a place the gateway could honestly enforce it:

- **`retention.audit_days`** — the audit trail is hash-chained and append-only
  ([ADR-0010](adr/0010-analytics-audit-and-headers.md)). Deleting old entries breaks
  `POST /api/v1/audit/verify` for everything after them, so selling a shorter audit window would
  mean selling a broken verify endpoint. Audit history is kept in full on every plan.
- **`sso.enforced`** — enforcing single sign-on is Logto configuration, not a gateway decision, so
  there is nowhere in Relay for such a flag to bite. It stays a commercial term of the Enterprise
  plan rather than a limit key that pretends to be enforced.

### Why these axes

Each row is something a growing team genuinely consumes more of, and each is already a first-class
object in Relay. There is deliberately **no** limit on requests-per-month or on tokens: metering
those as a quota would make the gateway's own accounting the product, and a burst-shaped workload
would hit an arbitrary wall mid-month. Volume is governed by `rate.*` (smooth) and
`spend.monthly_usd.max` (hard, and denominated in the thing the customer actually cares about).

---

## 3. Enforcement matrix

Every limit has exactly one authoritative enforcement point. Nothing in the table below is
advisory-only, and nothing outside it is claimed in the UI.

| Key                      | Enforced in                                            | On breach                                     |
| ------------------------ | ------------------------------------------------------ | --------------------------------------------- |
| `apps.max`               | `apps.service.createApp` — inside the insert txn       | `409 quota_exceeded`, `param: apps.max`       |
| `providers.max`          | `providers.service.createProvider` — inside the txn    | `409 quota_exceeded`                          |
| `routes.max`             | `routes.service.createRoute` — inside the txn          | `409 quota_exceeded`                          |
| `keys.per_app.max`       | `apps.service.issueKey` — inside the txn               | `409 quota_exceeded`                          |
| `members.max`            | `tenancy.service.inviteMember` — pre-check (see note)  | `409 quota_exceeded`                          |
| `rate.rpm` / `rate.tpm`  | `policy.service.authorize` — token bucket in Valkey    | `429 rate_limited` + `retry-after`            |
| `spend.monthly_usd.max`  | `policy.service.authorize` — reserve/settle counter    | `429 budget_exceeded`                         |
| `retention.traffic_days` | `metering.prune` — hourly sweep, per-org tenant txn    | request-feed rows past the window are deleted |
| `cache.exact`            | `proxy.controller` — cache lookup skipped              | request served uncached (no error)            |
| `routing.failover`       | `proxy.controller` — targets trimmed to the first      | first target's failure surfaces as `502`      |
| `modalities.image`       | `proxy.controller` — image parts rejected pre-upstream | `403 plan_upgrade_required`                   |
| `notifications.chat`     | `notifications.service.setChannel` — Slack/Teams only  | `403 plan_upgrade_required`                   |
| `analytics.export`       | the console's CSV route (`app/api/analytics/export`)   | `403 plan_upgrade_required`                   |

`members.max` is the one quota that cannot sit inside its write transaction: the membership is
created in Logto, not in our database, so it is a pre-check on `inviteMember`. The narrow race that
leaves — two admins claiming the last seat at once — over-fills by one invitation, which is
recoverable; issuing an invitation that would have to be refused at acceptance time is not. Every
other quota is checked inside the transaction that inserts.

`analytics.export` is the one **UI-level** gate in the table, and is marked as such on purpose: a CSV
is only ever produced by the console's export route, while the underlying usage API is available on
every plan. Gating the API too would be a gate anyone could walk around with `curl`, so it is not
claimed.

Two error codes carry all of this:

```jsonc
// 409 — a countable resource is full. Deleting something, or upgrading, both fix it.
{ "error": { "type": "invalid_request_error", "code": "quota_exceeded",
             "param": "apps.max",
             "message": "Plan pro allows 10 applications; this organization has 10." } }

// 403 — the plan does not include this capability at all.
{ "error": { "type": "permission_error", "code": "plan_upgrade_required",
             "param": "modalities.image",
             "message": "Image inputs are not included in plan pro." } }
```

Both are in the shared error catalog, so they arrive through the same OpenAI-compatible envelope as
every other Relay error and any OpenAI SDK surfaces them as normal API errors.

### Composition with self-service limits

An org can still set its own `rate_limits` and `budgets`. Under a plan those compose as a
**minimum**, never a maximum:

```
effective rpm    = min(plan.rate.rpm, org rate_limits.rpm)          nulls = "no opinion"
effective spend  = the org's own budgets
                 + an implicit monthly org-wide ceiling at plan.spend.monthly_usd.max
                   (hard_cutoff = true, scope = org, app_id = null)
```

Raising your own limit above the plan is accepted by the API and simply not honoured — the console
shows both numbers and marks which is binding. This is what makes a downgrade safe: nothing has to
be rewritten, the enforcement just tightens.

---

## 4. Response headers

Every proxied response carries the plan alongside the existing `x-relay-*` family:

```
x-relay-plan: pro
```

It is stamped on every path — a live upstream call, a cache hit, and a stream (where it is written
with the rest of the headers before the first byte, since headers cannot be set mid-stream). It is
omitted entirely when the deployment has no plan layer, rather than sent as an empty or invented
value.

Documented with the rest in [response-headers.md](response-headers.md).

---

## 5. Lifecycle

```
                  ┌──────────┐  14 days   ┌────────┐
   onboard ──────►│ trialing │───────────►│ active │◄──── upgrade / downgrade
                  └────┬─────┘  (or pay)  └───┬────┘
                       │ expires             │ payment fails
                       ▼                     ▼
                  ┌────────┐            ┌───────────┐
                  │  free  │            │ past_due  │──── grace 7d ──► free
                  └────────┘            └───────────┘
```

- **Trials expire on read.** `status = 'trialing'` with `trial_ends_at` in the past resolves to
  `free`'s limits immediately, everywhere, with no scheduled job. The row keeps saying `trialing`
  so the console can render _"your trial ended on 3 Aug"_ rather than silently showing Free.
- **`past_due`** keeps the paid limits for a grace window, because cutting a production gateway off
  over a failed card is a worse outcome than a week of unpaid usage. After the window it resolves to
  `free`.
- **Downgrade never deletes anything.** An org on Pro with 40 applications that moves to Free keeps
  all 40; it simply cannot create the 41st. `quota_exceeded` says "10 allowed, 40 in use", and the
  console's plan page lists what is over.
- **Every transition is an audit event** — `plan.change`, `plan.trial_started`, `plan.trial_expired`
  — appended in the same transaction as the subscription write.

---

## 6. API

| Method | Path                                        | Scope          | Purpose                                      |
| ------ | ------------------------------------------- | -------------- | -------------------------------------------- |
| `GET`  | `/api/v1/plan`                              | `plan:read`    | Effective entitlements + usage + provenance  |
| `GET`  | `/api/v1/plans`                             | public         | The purchasable catalog                      |
| `POST` | `/api/v1/plan/change`                       | org admin      | Request an upgrade/downgrade                 |
| `GET`  | `/api/v1/platform/orgs/:orgId/subscription` | platform admin | Any org's subscription                       |
| `PUT`  | `/api/v1/platform/orgs/:orgId/subscription` | platform admin | Assign a plan, set overrides, extend a trial |

`GET /api/v1/plan` is the one the console renders and the SDK exposes:

```jsonc
{
  "object": "plan",
  "plan": { "code": "pro", "name": "Pro", "tier": 2 },
  "status": "active",
  "trial_ends_at": null,
  "limits": {
    "apps.max": { "value": 10, "source": "plan", "used": 4 },
    "members.max": { "value": 25, "source": "override", "used": 12 },
    "rate.rpm": { "value": 600, "source": "plan", "binding": "plan" },
    "cache.exact": { "value": true, "source": "plan" },
  },
}
```

`source` is the provenance (`plan` · `override` · `org_feature`), `used` the current count for
countable quotas, `binding` which layer wins where a self-service limit also exists.

---

## 7. Adding a limit

1. Add the key to `LIMIT_KEYS` in `packages/server/src/modules/plans/lib/limits.ts` with its type and
   default.
2. Add it to every seeded plan in migration `0017` (or a follow-up migration for new keys).
3. **Add its enforcement point**, and add the row to the matrix in §3. A limit with no enforcement
   point does not get merged — an unenforced flag in the console is worse than no flag. (This rule
   is why `retention.audit_days` and `sso.enforced` are not in the vocabulary; see §2.)
4. If it is countable, add its counter to `plans.repository.usage()` so `GET /api/v1/plan` can
   report `used`.
5. Add it to the docs page at `/docs/plans` in the console.
