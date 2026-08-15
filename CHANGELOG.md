# Changelog

All notable changes to Relay are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Relay adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The gateway and `relay-gateway-sdk` share a minor version: a `1.1.x` SDK is known to speak to a `1.1.x`
gateway.

## [1.1.0] — 2026-08-15

Thirteen providers instead of three, a catalogue that keeps its own prices current, and a set of
fixes to spend accounting and input validation found by probing a running gateway rather than by
reading it.

### Added

- **Thirteen providers, three adapters** ([ADR-0015](docs/adr/0015-provider-registry-and-catalog-sync.md))
  — OpenRouter, Google Gemini, Groq, Together, Mistral, DeepSeek, Fireworks, xAI, Perplexity and
  Azure OpenAI join the original three. Most are not new wire formats: nine speak OpenAI's protocol
  and differ only in base URL, so adapters are keyed by **wire format** rather than by vendor and
  adding the next such vendor is one registry entry plus one migration line. Azure earns its own
  adapter — it addresses a deployment in the URL path and authenticates with `api-key`. Every
  supported upstream now lives once in `packages/shared/src/providers.ts`, imported by the gateway
  and the console, with a test that parses the SQL constraint and fails if the two disagree.
- **`relay sync-models`** — refreshes the global model catalogue and rate cards from each provider's
  own `/models` endpoint. OpenRouter publishes per-token prices and needs no key, which makes it the
  one source that can populate rate cards with numbers nobody had to guess. In the self-hosted
  edition the sync uses the provider credentials already stored in the console, so no extra
  configuration is needed; that path is off in the cloud edition, where a global table read by every
  tenant must not be filled with one tenant's key.
- **A Logs section** — the full request history, filterable by status, model, provider, application,
  date range and a substring of the request id, with keyset pagination. Live traffic still answers
  "what is happening now"; this answers "what happened". No new storage: both read `usage_events`.
- **Machine-to-machine control-plane authentication** — `machineTokenSource()` in the SDK mints and
  refreshes a Logto token from a client id and secret, so a provisioning script, a cron job or CI can
  drive the control plane with no browser. `relay seed-machine` provisions the service account.
  Organization-administrator rights are opt-in behind `--admin`, so a leaked read-only account cannot
  move budgets or swap provider credentials.
- **Applications can be deleted**, cascading to their keys, budgets and application-scoped routes,
  and reporting how many live keys the deletion revoked.
- **A development-only route for the caller's own control-plane token**, for exercising `/api/v1/*`
  from Swagger UI or curl as a signed-in user. It 404s outside development and returns only the
  caller's own token.

### Changed

- **The Models page shows the catalogue**, not the org's route aliases. It previously read
  `GET /v1/models` — "what may this key call" — and so listed four rows on a deployment with four
  routes, making the one thing the page exists for (find a model id, copy it into a route target)
  impossible. Now searchable, filterable by provider, with a copy button per row.
- **Model pickers suggest without restricting.** Route targets may legitimately name a model the
  catalogue has never heard of, so the picker searches the catalogue while still accepting any id.
  The playground searches route aliases instead, because a virtual key can only call a name the org
  has a route for.
- **The route editor prefills from the version currently serving traffic.** Versions are immutable —
  an edit publishes a new one — but starting from a blank form meant retyping every target to change
  one of them, which is why routes tended to end up with a single target and no fallback. The form
  now also states what the priority and weight columns do: targets are tried in order, and one target
  means no failover.
- **The spend chart emits every day in the window**, zeros included. Buckets only exist for days with
  traffic, so a quiet week previously drew as two adjacent bars and the x-axis stopped meaning
  anything.

### Fixed

- **Requests to providers that publish no rate card settled at $0.** Cost is tokens times a rate
  card, and only OpenRouter publishes prices, so direct OpenAI and Anthropic models had none. A price
  the provider reports at request time now wins over the rate card — it cannot go stale — and
  `sync-models` derives cards for the rest by matching a provider's model ids against the same models
  on OpenRouter. An ambiguous match is refused rather than guessed: a wrong price looks plausible on
  an invoice, while a missing one is visibly zero.
- **A budget under 0.0001 was silently stored as zero.** `limit_usd` is `numeric(12,4)` and Postgres
  rounds rather than refusing, so a value that passed `exclusiveMinimum: 0` became a **zero budget
  with hard cutoff** — blocking every request the organization made, from a call that returned 201
  and echoed the number back unchanged. A limit finer than the column stores is likewise rejected
  instead of being rounded into a ceiling nobody chose.
- **The budget form refused ordinary values.** `step` is measured from `min`, so `min="0.0001"` with
  `step="0.01"` made 50 fail the browser's step check and the form silently would not submit.
- **Whitespace-only names** were accepted for applications and provider credentials, producing rows
  that could not be told apart in the console.
- **The container images could not be built at all.** The Dockerfiles still filtered on the
  pre-rename package names (`@relay/server`, `@relay/shared`), so `pnpm deploy` matched nothing, `/out`
  was never produced and the build failed on the first `COPY`. Broken since the workspace was renamed
  after v1.0.0 and only surfaced by tagging, because nothing had built an image since. The console
  image additionally never copied or built `relay-shared`, which it began importing with the provider
  registry, so its Next build could not resolve it.
- **The gateway reported the previous version.** `RELAY_VERSION` and the SDK's user-agent stamp are
  hand-maintained constants and `npm version` does not touch them, so `relay --version`, the `/readyz`
  probe and the console's Status page all answered `1.0.0` from a 1.1.0 build. Both are now asserted
  against their package manifest by a test.

### Security

- **Provider `base_url` accepted any URI**, and that value becomes the address the gateway itself
  fetches. `javascript:`, `file:///etc/passwd` and `http://169.254.169.254/latest/meta-data` were all
  stored happily — server-side request forgery, and on a multi-tenant deployment the organization
  admin is a customer. Schemes are now restricted to http and https everywhere; link-local addresses,
  which carry the cloud metadata endpoint, are refused in every edition; private ranges remain
  allowed self-hosted, where a local Ollama is the documented setup, and are refused on a
  multi-tenant one. DNS rebinding is not addressed by this and is noted in the module.

## [1.0.0] — 2026-08-14

First stable release. Everything below is free for everyone — the plan layer ships enforced-capable
but switched off (`RELAY_EDITION=oss`).

### Added

- **`relay-gateway-sdk`** — a zero-dependency TypeScript client, published to npm. Chat completions
  (streaming included) with Relay's per-request metadata surfaced as typed fields
  (`res.relay.provider`, `.costUsd`, `.cached`, `.traceId`), plus a typed control-plane client for
  applications, keys, providers, routes, budgets, analytics, traffic, audit and plan. Types are
  generated from the gateway's own OpenAPI document, so the client cannot drift from the server.
  Ships ESM and CJS with per-condition type declarations; runs on Node, Bun, Deno, Workers and
  browsers.
- **Plans, quotas and entitlements** ([ADR-0014](docs/adr/0014-plans-and-entitlements.md)) — a plan
  catalog and per-org subscriptions, with effective entitlements resolved from plan defaults,
  negotiated overrides and the existing per-org feature flags. Countable quotas are enforced inside
  the same transaction as the write, so two concurrent creates cannot both pass; feature gates and
  rate/spend ceilings compose with an org's own limits as a minimum, never a maximum. Trials expire
  on read rather than by a scheduled job.
- **Public documentation in the console** at `/docs` — quickstart, SDK, plans, errors, self-hosting
  and API reference, built from the existing design system with the console's own screenshots.
- **Editions** — `RELAY_EDITION` selects the entitlement regime at the composition root. `oss` (the
  default) resolves every organization to an unlimited built-in plan and compiles quota checks to a
  no-op; `cloud` enforces the catalog. The open-source edition is never limited by code written to
  sell something.
- **SDK end-to-end suite** — twelve tests against a real running gateway, asserting the wire
  contract a mocked `fetch` structurally cannot: that `x-relay-*` headers are actually sent, that an
  SSE stream actually terminates, and that a virtual key is refused on the control plane. Self-skips
  without a gateway. `make sdk-e2e`.
- **`deploy/saas/`** — a production compose stack with no host-published ports, self-hosted Logto,
  per-service memory limits and log rotation, plus an overlay that fits the whole stack inside a
  12 GB box with an enforced budget.
- **[RELEASING.md](RELEASING.md)** — how a release is cut and how the SDK is proven against a real
  gateway without deploying a server.

### Changed

- The console's sidebar now renders the Relay lockup instead of a letter tile, linked home.
- Landing-page section links resolve against the landing page from any route, so `Self-host` and
  `FAQ` work from the docs pages instead of silently doing nothing.
- `README` rewritten for an open-source audience.
- Internal planning, QA and operational documents moved to `docs/internal/` and out of version
  control. Operational material maps a production surface and does not belong in a public
  repository; everything a contributor or self-hoster needs stays in `docs/`.

### Fixed

- **The console image never copied `public/`.** Next's standalone output does not trace it, so every
  file it holds 404'd in the container while working in development — currently the documentation
  screenshots, and silently anything added there later.
- **`relay-gateway-sdk` type resolution failed for CommonJS consumers.** The exports map carried a single
  top-level `types` entry pointing at the ESM declarations, so under `moduleResolution: node16` a
  CJS consumer resolved ESM types and failed with `TS1479` — even though `require()` worked at
  runtime. Each condition now carries its own `types`.
- **`RELAY_EDITION` never reached the console**, which read a `NEXT_PUBLIC_` variable nothing set.
  Both the gateway and the console now read the same variable, and the self-host compose passes it
  to both containers — previously setting it in `.env` changed nothing in production.
- **The OpenAPI document hardcoded its version** while the module already imported `RELAY_VERSION`,
  so the published spec could disagree with the binary serving it.
- **`pnpm typecheck` failed on a clean checkout** of the console: `tsconfig` includes Next's
  generated route types, but turbo's `dependsOn: ["^build"]` builds dependencies, not the package
  itself. It now generates them first.

### Security

- Tenant isolation remains enforced by Postgres row-level security on every tenant table, with a CI
  gate that fails the build if a tenant table is added without its policies.
- The two auth planes stay separate, and the SDK suite asserts it: a data-plane virtual key
  presented to `/api/*` is an authentication failure, never an accidental grant.

## [0.2.0] — 2026-08-09

Release pipeline, self-host bundle and documentation.

## [0.1.0]

Initial phase-1 gateway: proxy, identity, tenancy, providers, routing, policy, metering, analytics,
audit and the admin console.

[1.0.0]: https://github.com/chetan-01-source/relay/releases/tag/v1.0.0
[0.2.0]: https://github.com/chetan-01-source/relay/releases/tag/v0.2.0
