<div align="center">

# Relay Gateway

**One OpenAI-compatible endpoint in front of every model provider — with tenancy, budgets, routing
and an audit trail that the database enforces, not a code review.**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-22%20LTS-339933)](package.json)
[![TypeScript](https://img.shields.io/badge/typescript-strict-3178C6)](tsconfig.base.json)

[Quickstart](#quickstart) · [Why](#why-a-gateway) · [SDK](#use-it-from-code) ·
[Self-hosting](docs/self-hosting.md) · [Architecture](#architecture) · [Contributing](CONTRIBUTING.md)

</div>

---

Relay sits between your application and OpenAI, Anthropic, Gemini, vLLM or Ollama. Your services hold
a **virtual key** (`rk_live_…`); Relay exchanges it for the real provider credential (`sk-…`, sealed
with envelope encryption) and — on the same request — routes, fails over, meters the cost, enforces
the budget and writes the audit entry.

```diff
  client = OpenAI(
-     base_url="https://api.openai.com/v1",
-     api_key=OPENAI_KEY,
+     base_url="https://relay.internal/v1",
+     api_key=RELAY_VIRTUAL_KEY,
  )
```

That is the whole migration. Relay implements the OpenAI Chat Completions API including streaming, so
your SDK, prompts and response handling are unchanged.

## Why a gateway

Everything below is the part teams rebuild badly, one service at a time:

|                                      |                                                                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Routing with failover**            | One model alias fans out to an ordered or weighted set of targets. A dead provider fails over mid-request. Route versions are immutable, so rollback is activating an older one |
| **Budgets that actually stop spend** | Daily and monthly ceilings per organization and per application, enforced _before_ the upstream call with an atomic reserve/settle — not reconciled after the invoice           |
| **Virtual keys, not provider keys**  | Clients hold keys scoped to one application. Rotate with a grace window, revoke instantly — every worker drops the key within ~1s                                               |
| **A credential vault**               | Provider keys are sealed and write-only. No read path returns one: not the API, not the console, not the audit trail                                                            |
| **Usage and spend you can query**    | Every request metered and rolled up hourly — by application, route, model or day. Cost computed per request from rate cards                                                     |
| **A tamper-evident audit trail**     | Every configuration change appended to a hash-chained log with a verify endpoint                                                                                                |
| **Multi-tenant to the row**          | Applications, keys, routes and budgets belong to an organization, isolated by Postgres row-level security rather than a `WHERE` clause somebody has to remember                 |

### The isolation claim, specifically

Every tenant table has `FORCE ROW LEVEL SECURITY` with a policy bound to the current organization,
and the gateway connects as a non-owner role. A forgotten `WHERE` clause returns **nothing** instead
of someone else's data. A [CI gate](scripts/check-rls.sh) fails the build if a tenant table is added
without those policies, so the guarantee cannot rot as the schema grows.

## Quickstart

Requires Node 22, pnpm 9 and Docker.

```bash
git clone https://github.com/chetan-01-source/relay.git && cd relay
make bootstrap     # check tools, install deps, generate types
make up            # Postgres + Valkey + Logto, migrations, seeds
make dev           # gateway :3000 · console :3100 · mock upstream :8080
make seed-demo     # mints a tenant + a virtual key, prints a working curl
```

Then:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "authorization: Bearer $(cat .relay/seed-demo.key)" \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hello"}]}'
```

The response carries what a stock provider does not:

```http
x-relay-provider: anthropic
x-relay-failover: openai→anthropic
x-relay-cost-usd: 0.000412
x-relay-trace-id: 8f2c…
```

The console is at `http://localhost:3100`, with public documentation at `/docs`.

## Use it from code

Any OpenAI SDK works against Relay unchanged. [`relay-gateway-sdk`](packages/sdk/README.md) adds what a stock
client structurally cannot reach — the per-request metadata as typed fields, plus the control plane:

```ts
import { Relay } from 'relay-gateway-sdk';

const relay = new Relay({ baseUrl, apiKey: 'rk_live_…' });
const res = await relay.chat.completions.create({ model: 'fast', messages });

res.relay.provider; // 'anthropic'  — which upstream actually served it
res.relay.costUsd; //  0.000412    — metered, not estimated
res.relay.cached; //  false
res.relay.traceId; // '8f2c…'      — opens in the console's traffic view
```

Provisioning is code too — an isolated, budgeted tenant in four calls:

```ts
const admin = relay.admin(token);
const app = await admin.apps.create({ name: 'acme-prod' });
await admin.budgets.setForApp(app.id, 'monthly', { limit_usd: 200, hard_cutoff: true });
const { key } = await admin.apps.keys.issue(app.id, { environment: 'live' });
```

Zero runtime dependencies; Node, Bun, Deno, Workers and browsers. Types are generated from the
gateway's own OpenAPI document, so the client cannot drift from the server.

## Architecture

```
   your services ──rk_live_…──►┌─────────────────────────┐──sk-…──► OpenAI · Anthropic · vLLM
                               │  Relay gateway          │
                               │  route → authorize →    │
                               │  proxy → meter → audit  │
                               └────┬───────────────┬────┘
                                    │               │
                          ┌─────────▼──────┐  ┌─────▼──────┐
                          │ PostgreSQL 16  │  │  Valkey 8  │
                          │ RLS-isolated   │  │ counters + │
                          │ source of truth│  │ cache      │
                          └────────────────┘  └────────────┘
```

Two auth planes that never cross: virtual keys for `/v1/*`, Logto JWTs for `/api/*`. Identity
resolves to an immutable in-process snapshot invalidated over Valkey pub/sub, so the steady-state hot
path never touches Postgres — and a revocation still lands within ~1s.

| Concern        | Tool                                             |
| -------------- | ------------------------------------------------ |
| Runtime        | Node.js 22 LTS + TypeScript 5 (strict)           |
| HTTP           | Fastify 5                                        |
| Datastore      | PostgreSQL 16, forced RLS                        |
| Cache / limits | Valkey 8                                         |
| Auth           | Logto (OIDC + organizations + RBAC)              |
| Console        | Next.js 15 (admin + public `/docs`)              |
| SDK            | `relay-gateway-sdk` — zero-dependency TypeScript |
| Monorepo       | pnpm workspaces + Turborepo                      |

## Self-hosting

Three containers and a master key. Everything stays in your infrastructure — prompts, completions and
provider credentials never transit a service anybody else operates.

```bash
tar -xzf relay-selfhost.tar.gz
cp .env.example .env      # set 3 secrets
docker compose up -d
```

Signed multi-arch images (amd64 + arm64), migrations applied before the gateway serves, readiness and
liveness endpoints, Prometheus metrics, stateless workers. Full guide:
[docs/self-hosting.md](docs/self-hosting.md).

## Editions

One codebase, two builds, selected by `RELAY_EDITION`:

|         | **OSS** (default)                                                            | **Cloud**                               |
| ------- | ---------------------------------------------------------------------------- | --------------------------------------- |
| Plans   | one built-in `self_hosted` plan — every limit unlimited, every capability on | `free` · `pro` · `scale` · `enterprise` |
| Quotas  | no-op                                                                        | enforced by the gateway                 |
| Licence | Apache-2.0                                                                   | Apache-2.0 core + commercial add-on     |

**The open-source edition is never limited by code written to sell something.** A hosted service
sells operation — running it, backing it up, patching it, answering the phone — not features held
back. [docs/editions.md](docs/editions.md) has the split; [docs/plans.md](docs/plans.md) has every
limit and its enforcement point.

> **v1 is free for everyone.** The plan layer is built and tested but switched off:
> `RELAY_EDITION=oss`, with the pricing surfaces commented out rather than deleted
> (`grep -rn MVP-FREE`). Nothing collects payment today.

## Documentation

|                                                                                      |                                                |
| ------------------------------------------------------------------------------------ | ---------------------------------------------- |
| [Quickstart](docs/quickstart.md)                                                     | Empty org → first proxied call                 |
| [SDK](docs/sdk.md)                                                                   | `relay-gateway-sdk` design                     |
| [Test it by hand](docs/sdk-manual-testing.md) · [automated](docs/sdk-e2e-testing.md) | Eight scripts you run yourself · the CI suite  |
| [Self-hosting](docs/self-hosting.md)                                                 | Running your own                               |
| [Plans](docs/plans.md) · [Editions](docs/editions.md)                                | Limits, entitlements, the OSS/cloud seam       |
| [Errors](docs/errors.md) · [Response headers](docs/response-headers.md)              | The wire contract                              |
| [Threat model](docs/threat-model.md)                                                 | What the boundaries are, and are not           |
| [ADRs](docs/adr/)                                                                    | Why the architecture is the way it is          |
| [Development](docs/DEVELOPMENT.md) · [Setup](docs/SETUP.md)                          | Working on Relay                               |
| [Releasing](RELEASING.md)                                                            | Cutting a release and proving the SDK, locally |

The console also serves user-facing documentation at `/docs`, and the gateway serves its OpenAPI
document at `/openapi.json` with Swagger UI at `/docs`.

## Contributing

Trunk-based, PR-only to `main`. Every PR runs lint, typecheck, tests, module-boundary checks and the
RLS gate. See [CONTRIBUTING.md](CONTRIBUTING.md); report vulnerabilities per
[SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE). Fork it, run it, build a service on it.
