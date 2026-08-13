# Changelog

All notable changes to Relay are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Relay adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The gateway and `@relay/sdk` share a minor version: a `1.0.x` SDK is known to speak to a `1.0.x`
gateway.

## [1.0.0] — 2026-08-14

First stable release. Everything below is free for everyone — the plan layer ships enforced-capable
but switched off (`RELAY_EDITION=oss`).

### Added

- **`@relay/sdk`** — a zero-dependency TypeScript client, published to npm. Chat completions
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
- **`@relay/sdk` type resolution failed for CommonJS consumers.** The exports map carried a single
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
