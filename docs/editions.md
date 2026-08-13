# Editions — open source and Relay Cloud from one codebase

Relay ships in two editions built from the same repository:

|                   | **OSS** (`RELAY_EDITION=oss`, default)                                    | **Cloud** (`RELAY_EDITION=cloud`)             |
| ----------------- | ------------------------------------------------------------------------- | --------------------------------------------- |
| Licence           | Apache-2.0                                                                | Apache-2.0 core + commercial `packages/cloud` |
| Who runs it       | You, in your infrastructure                                               | We do, at `relay.<domain>`                    |
| Plans             | one built-in `self_hosted` plan — every limit unlimited, every feature on | `free` · `pro` · `scale` · `enterprise`       |
| Quota enforcement | compiled out (no-op)                                                      | enforced                                      |
| Billing           | none                                                                      | Stripe (behind a `PaymentProvider` interface) |
| Sign-up           | invitation only, by a platform admin                                      | self-serve                                    |
| Pricing page      | hidden                                                                    | shown                                         |
| Support           | GitHub issues                                                             | SLA by tier                                   |

The rule that keeps this honest: **the open-source edition is never limited by code we wrote to sell
something.** Every capability in the repository is on for a self-hoster. What Cloud sells is
operation — we run it, back it up, patch it and answer the phone — not features held back.

---

> **Status (Aug 2026).** `packages/cloud` is a **design, not a directory** — it does not exist yet,
> because there is no billing code to put in it. Everything described for it below is the plan for the
> day Relay starts charging. Today the repository is entirely Apache-2.0, the plan layer ships in the
> core and is inert under `RELAY_EDITION=oss`, and the only genuinely private material is operational
> (secrets, infra config, customer data), which is kept out of this repository entirely — see
> [RELEASING.md §7](../RELEASING.md#7-what-is-not-in-this-repo).
>
> Note also the trade this model makes: `packages/cloud` would be _source-available in a public repo_,
> not hidden. If the commercial code must be genuinely private, it belongs in the private ops repo
> instead — the playbook covers both.

## 1. Why one repo

The alternative — a public `relay` and a private `relay-cloud` that consumes it — has a cleaner
licensing story and a much worse day-to-day one: every cloud change that touches the core needs a
release of the core first, the CI matrix is duplicated, and the two drift within a quarter. Given the
cloud-only surface here is genuinely small (a plan catalog, billing, a pricing section and a signup
flow), one repository with a hard directory boundary is the better trade.

The boundary is enforced mechanically, not by convention — see §4.

## 2. Layout

```
relay/
├── packages/
│   ├── shared/        Apache-2.0   error catalog, wire types
│   ├── server/        Apache-2.0   gateway: proxy, identity, tenancy, policy, plans, …
│   ├── console/       Apache-2.0   admin console + /docs
│   ├── sdk/           Apache-2.0   relay-gateway-sdk — published to npm
│   ├── mockllm/       Apache-2.0   test upstream
│   └── cloud/         COMMERCIAL   billing, Stripe, plan catalog seeds, signup, pricing
├── db/migrations/     Apache-2.0   0001–0018 …  (0017 seeds plans, 0018 subscriptions;
│                                    both inert without cloud)
└── deploy/            Apache-2.0   compose + helm for self-hosters
```

`packages/cloud` carries its own `LICENSE` and is excluded from the self-host bundle
(`make bundle`) and from the OSS container image.

## 3. The switch is one function

`RELAY_EDITION` selects a `PlanService` implementation at the composition root, and nowhere else:

```ts
// packages/server/src/app.ts
const plans =
  config.RELAY_EDITION === 'cloud'
    ? createPlanService({ db, bus, repo: createPlansRepository() }) // table-backed, quotas bite
    : createUnlimitedPlanService(); // every limit null, every flag true
```

`createUnlimitedPlanService()` lives in the core module and is ~20 lines. It is not a stub: it is the
honest self-hosted plan, and it is what the whole OSS test suite runs against.

Consequences of putting the switch here:

- **No `if (edition)` at call sites.** `assertQuota()` asks the service; against the unlimited
  service it returns immediately. Enforcement code reads identically in both editions.
- **The OSS build has no dead cloud code paths** — it never constructs them.
- **Tests prove both.** The plans module's test suite runs each enforcement case twice, once per
  service implementation, and asserts the OSS one never throws.

Console-side, the **same variable** is read — not a `NEXT_PUBLIC_` twin:

```ts
// packages/console/app/lib/edition.ts  (server-side only)
export const EDITION = process.env.RELAY_EDITION === 'cloud' ? 'cloud' : 'oss';
export const isCloud = EDITION === 'cloud';
```

One variable for the whole deployment is the point. A `NEXT_PUBLIC_` twin would be a second switch
to keep in sync, and the failure mode is silent: the console renders an Upgrade button the gateway
then refuses. Every consumer is a server component, so a client component that needs the answer takes
it as a prop (`<LandingNav showPricing={isCloud} />`) instead of reading the environment itself.

Both containers therefore need it set — see `deploy/selfhost/compose.yaml`, where the gateway and the
console each receive `RELAY_EDITION`.

It gates the landing page's pricing section, the landing nav's Pricing link, and the self-serve
upgrade controls on the plan page. It does NOT gate the plan page itself: on a self-hosted install
that screen reports real usage counts against "Unlimited", which is useful capacity information
rather than a disabled advertisement.

## 4. Keeping the boundary from rotting

Two mechanical gates, both already part of `pnpm lint`:

1. **dependency-cruiser rule** — `packages/server`, `packages/console`, `packages/sdk` and
   `packages/shared` may not import from `packages/cloud`. The dependency runs one way only: cloud
   imports core. A PR that reverses it fails CI, which is the only version of this rule that holds.
2. **A licence-header check** on every file under `packages/cloud`.

If a cloud feature turns out to need a core change, the core change lands in core as a general
capability with an interface, and cloud implements it. That is how `PaymentProvider` exists: the core
plans module knows a subscription can have a `provider_ref`, and nothing about Stripe.

## 5. What a self-hoster gets

Unchanged from today, plus the plan layer resolving to unlimited:

```bash
tar -xzf relay-selfhost.tar.gz
cp .env.example .env          # RELAY_EDITION is not set → oss
docker compose up -d
```

- Every entitlement `true`, every quota `null`.
- `GET /api/v1/plan` returns the `self_hosted` plan, so the console's plan page still works and
  reports real usage counts — useful capacity information, with no ceiling.
- No pricing page, no upgrade CTA, no billing routes registered, no Stripe dependency in the image.
- The plans tables exist (the migration runs) but stay empty of purchasable rows. Keeping the schema
  identical across editions is what lets a self-hoster migrate to Cloud, and lets us reproduce a
  cloud bug locally.

## 6. What Cloud adds

| Area    | Cloud-only                                                                                      |
| ------- | ----------------------------------------------------------------------------------------------- |
| Data    | `plans` seeded with `free`/`pro`/`scale`/`enterprise`; `org_subscriptions` rows                 |
| Server  | `packages/cloud/billing` — `PaymentProvider` (Stripe), checkout, webhooks, portal, invoice sync |
| Server  | `POST /api/v1/plan/change`, `/api/v1/billing/*`                                                 |
| Console | `/pricing`, self-serve signup, "Upgrade" CTAs, invoice list                                     |
| Ops     | usage → billing reconciliation, dunning, trial-expiry emails                                    |

Everything in that table is additive. Deleting `packages/cloud` leaves a complete, working gateway —
which is the test for whether the boundary is real.

## 7. Migration path both ways

- **Self-hosted → Cloud:** the schema is identical. Export with `relay backup`, import, assign a
  subscription. Nothing about the org's applications, keys, routes or history changes shape.
- **Cloud → self-hosted:** the same, in reverse. This is stated on the pricing page on purpose. A
  gateway that holds your provider credentials has to be a gateway you can leave, and saying so is
  worth more than the customers it costs.

## 8. Licensing summary

- The gateway, console, SDK, migrations and deployment assets: **Apache-2.0**. Fork it, run it, sell
  a service on it.
- `packages/cloud`: **commercial**, source-available in this repository for transparency, not
  licensed for redistribution or for operating a competing hosted service.
- Contributions to core are Apache-2.0 under the existing [CONTRIBUTING.md](../CONTRIBUTING.md). We do
  not ask for copyright assignment, which means core can never be relicensed out from under
  contributors.
