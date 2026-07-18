# Relay Gateway — Development Guide

The single source of truth for **how we build in this repo**. Read it before writing code; follow
it when adding a module. It encodes the architecture, the layering rules, the database and query
discipline, the testing strategy, and the exact local checks to run before anything ships.

Companion docs: `docs/Relay-Gateway-3-Week-Dev-Cycle-PRD.pdf` (what/when) ·
`docs/Relay-Gateway-Phase1-Engineering-Playbook.pdf` (why, on the hard calls) · `db/migrations/README.md`
(the RLS contract).

---

## 1. Architecture at a glance

Modular monolith, one process, strict internal boundaries (a future service split is a deployment
flag, not a rewrite). Two layers, one dependency direction:

```
                 ┌──────────────────────────────────────────────┐
  HTTP request → │  MODULE  (a vertical feature slice)           │
                 │                                               │
                 │   routes  →  controller  →  service  →  repository
                 │   (HTTP)     (HTTP I/O)     (business)   (data access)
                 │                                 │            │
                 │                                 │            └─→ queries (SQL text, parametrized)
                 │                                 └─→ (pure logic; no HTTP, no SQL)
                 └───────────────────────────────┬──────────────┘
                                                 │ depends on ↓ only
                 ┌───────────────────────────────┴──────────────┐
                 │  PLATFORM KERNEL (the bottom layer)           │
                 │  config · db · crypto · als · logger · eventbus · metrics · migrate
                 └───────────────────────────────────────────────┘
```

**The one hard dependency rule (enforced by dependency-cruiser in CI):**

- `platform/` **never** imports `modules/`. The kernel is the bottom; modules sit on top.
- A module's internals are private — only `modules/<name>/index.ts` is cross-importable.
- Packages talk via workspace deps + published types, never deep paths.
- The **composition root** is `packages/server/src/app.ts` (NOT under `platform/`), because it is the
  only place allowed to wire the kernel to modules and inject dependencies.

Run `pnpm run dep-check` to verify. A violation fails the PR.

---

## 2. Module layout — the layers, one responsibility each

Every feature is a folder under `packages/server/src/modules/<name>/`, and **each layer gets its own
sub-folder** so responsibilities never blur:

```
modules/<name>/
├── index.ts               # DI wiring — the only cross-importable file
├── routes/                # HTTP surface: bind paths → controller
├── controllers/           # HTTP boundary: validate, status/headers, shape response
├── services/              # business logic: orchestrate, transform, decide
├── repositories/          # data access: run queries via Queryable
├── queries/               # SQL: parametrized SqlQuery builders (the ONLY place with query text)
├── types/                 # all interfaces/contracts for the module
└── tests/                 # unit + integration tests for the module
```

| Folder / file        | Layer          | May do                                                   | May NOT do                          |
| -------------------- | -------------- | -------------------------------------------------------- | ----------------------------------- |
| `routes/*.routes.ts` | HTTP surface   | bind path → controller method                            | logic, validation, DB               |
| `controllers/*.ts`   | HTTP boundary  | parse/validate input, set status/headers, shape response | business logic, SQL, upstream calls |
| `services/*.ts`      | Business logic | orchestrate, transform, decide                           | **any SQL**, HTTP types, DB handles |
| `repositories/*.ts`  | Data access    | execute queries from `queries/` via `Queryable`          | **query text**, business logic      |
| `queries/*.ts`       | SQL            | export parametrized `SqlQuery` objects                   | run queries, import services        |
| `types/*.ts`         | Interfaces     | declare all contracts                                    | implementations                     |
| `tests/*.test.ts`    | Tests          | unit (fakes) + integration (real DB, self-skip)          | ship untested logic                 |
| `index.ts`           | DI wiring      | construct repo→service→controller→routes                 | logic                               |

**Reference implementations already in the repo:**

- `modules/proxy/` — the data-plane hot path (has **no DB**; a module only adds `repositories/` +
  `queries/` when it needs data). Adds two internal folders: `adapters/` (provider Layer-1 wire
  formats) and `lib/` (the SSE parser). Layers: `routes → controller → service → adapters/lib`.
- `modules/models/` — the DB-backed vertical (`GET /v1/models`). Full stack:
  `routes → controller → service → repository → queries`, reading the global `model_catalog` table.

**Copy `modules/models/` as the template for any new DB-backed feature.**

**Every package follows a layered layout — not just the server.** The `mockllm` package is organized
the same way (`app.ts` composition root + `routes/`, `providers/` (its handlers), `lib/`, `types/`,
`tests/`); `shared` holds cross-package contracts. No package keeps everything in one file.

### Dependency-injection flow (see `src/app.ts`)

```
initDb(url)  ─(singleton Database, which is a Queryable)─┐
                                                         ▼
registerModels(app, { db })  →  createModelsRepository(db)
                                → createModelsService(repo)
                                → createModelsController(service)
                                → registerModelsRoutes(app, controller)
```

Each layer receives its dependency as an **interface** (`ModelsRepository`, `ModelsService`), so every
layer is unit-testable with a fake and nothing is newed-up inside business code.

---

## 3. Database discipline

### 3.1 Singleton connection (system design: bounded connections)

`platform/db.ts` exposes a **singleton** `Database` (one `pg.Pool` per process). Never create a pool
per request or per module.

```ts
import { initDb, getDb } from './platform/db.js';
initDb(config.RELAY_DATABASE_URL); // once, at boot (composition root)
const db = getDb(); // anywhere else
```

### 3.2 Two roles, two URLs

| Purpose               | Role                        | Env var                        | RLS         |
| --------------------- | --------------------------- | ------------------------------ | ----------- |
| Runtime (the gateway) | `relay_app` (non-superuser) | `RELAY_DATABASE_URL`           | **applies** |
| Migrations / seed     | `postgres` (superuser)      | `RELAY_MIGRATION_DATABASE_URL` | bypassed    |

### 3.3 Tenant reads/writes go through `withTenant` (RLS + transaction)

Any query touching a tenant table (one with `org_id`) must run inside a tenant-scoped transaction so
Postgres Row-Level Security isolates it:

```ts
await db.withTenant(orgId, { isPlatformAdmin: false }, async (tx) => {
  return repo.withTx(tx).listApplications(); // tx is a Queryable scoped to this org
});
```

`withTenant` opens a transaction and sets `app.current_org` / `app.is_platform_admin` via
`set_config(..., is_local => true)` — cleared on COMMIT/ROLLBACK, safe under pooling. **Connections are
never shared across tenants.** Global tables (`model_catalog`, `rate_cards`) have no `org_id` and are
read directly, no `withTenant`.

**Use a transaction (`withTenant` or an explicit tx) whenever:** a write spans >1 statement, an
invariant crosses rows (e.g. rotate a key = insert successor + update predecessor), or you read-then-write.

### 3.4 SQL lives ONLY in `*.queries.ts`, and is ALWAYS parametrized

- No query text in a service or controller — ever.
- Every query is a `SqlQuery { text, values }`. User-supplied values are bound as `$1, $2, …` and
  passed in `values`; **never** string-interpolated. This makes SQL injection structurally impossible.

```ts
// models.queries.ts  ✅ parametrized
export function getModelQuery(model: string): SqlQuery {
  return {
    text: `SELECT provider, model, capabilities FROM model_catalog WHERE model = $1`,
    values: [model],
  };
}
// ❌ NEVER:  `... WHERE model = '${model}'`
```

The `Queryable` interface only accepts a `SqlQuery`, so a repository physically cannot run raw text.

### 3.5 Migrations (additive-only)

- One numbered file: `db/migrations/NNNN_description.sql`, applied in order, **advisory-locked** and
  **checksummed** (editing an applied migration is refused — add a new one).
- A new tenant table (has `org_id`) MUST, in the same migration, add `FORCE` RLS + the
  `tenant_isolation` and `platform_admin_access` policies. `scripts/check-rls.sh` fails the PR otherwise.
- Global/seed tables go **last** in their migration file (the RLS gate's line-window heuristic must not
  see a following `org_id`).
- Apply: `make migrate` (idempotent). Add: `relay migrate` scaffolding / `make migrate-new`.

---

## 4. API design principles (applied here)

- **OpenAI-compatible surface.** Canonical request/response shape = OpenAI; clients treat Relay as a
  drop-in. Errors mirror OpenAI's envelope (`shared/errors.ts`) so SDKs handle them natively.
- **Consistent envelopes.** Lists return `{ object: "list", data: [...] }`; resources carry `object`.
- **One error contract.** Never build an error response by hand. `throw new RelayError('code', …)`
  from any layer; the central `setErrorHandler` in `app.ts` formats every error (thrown, validation,
  or unexpected) to the OpenAI-compatible `{ error: { message, type, code, param } }` envelope. Codes,
  statuses and types live in `shared/errors.ts` (`ERROR_CATALOG`), documented in `docs/errors.md`.
  Adding an error = one catalog entry + a table row + a test. Unknown throws become a safe 500 with
  details logged, never leaked.
- **Idempotent, versioned, parametrized.** Public paths under `/v1`; write semantics documented per
  endpoint; inputs validated at the controller boundary before any work.
- **Contract-first.** Route `schema` blocks are the source of truth → request validation + generated
  OpenAPI. The spec is **not** hand-written; it is produced from the code (see §5.4).
- **Self-documenting.** Every data-plane endpoint is browsable: **Swagger UI at `/docs`**, machine
  spec at `/openapi.json`, dumped to `api/openapi/openapi.json` by `make generate`.
- **Trace everything.** Every response carries `x-relay-trace-id`; every log line carries `trace_id` +
  `org_id` via the ALS context.

---

## 5. Testing strategy

Layered, each with a clear scope and gate. **Test business logic in isolation with fakes; test IO
against real infra.**

| Layer                    | Scope                                                                        | Tooling                                          | Runs                        |
| ------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------- |
| **Unit**                 | services, adapters, repositories (w/ fake `Queryable`), queries, crypto, sse | Vitest, no IO                                    | `make test` (every PR)      |
| **Integration**          | repository against a REAL Postgres (RLS, real SQL)                           | Vitest, self-skips w/o `RELAY_TEST_DATABASE_URL` | `make test` (locally w/ DB) |
| **Isolation (G4)**       | every role × endpoint × foreign org — zero cross-tenant reads                | `test/isolation/` + `check-rls.sh`               | PR — **zero tolerance**     |
| **Smoke**                | end-to-end request contracts against a running stack                         | `scripts/smoke.sh`                               | after `make dev`            |
| **Load**                 | hot-path throughput + p50/p95/p99                                            | k6 (`test/load/`) or `scripts/load-smoke.mjs`    | local / bench gate (G3)     |
| **Conformance (Day 14)** | official OpenAI/Anthropic SDKs vs gateway→mockllm                            | `test/conformance/`                              | nightly + release           |

### 5.1 Writing unit tests

- Co-locate: `foo.test.ts` next to `foo.ts`.
- Inject fakes for every dependency (a fake `Queryable`, a stubbed `fetch` via `vi.stubGlobal`).
- Assert behavior + edge cases (empty, not-found, malformed, tampered, upstream error).
- Example fakes and patterns: `models.test.ts` (fake repository), `proxy.service.test.ts` (stubbed
  fetch + a `ReadableStream` SSE body), `crypto.test.ts` (round-trip + tamper).

### 5.2 Coverage (`make coverage`)

Unit coverage is measured on **business logic only** — services, repositories, queries, adapters, sse,
crypto (see `vitest.config.ts` `include`). HTTP boundaries (`*.controller`/`*.routes`), DI wiring
(`index.ts`), and IO/bootstrap (`db`, `eventbus`, `migrate`, `app`, `cli`) are covered by
integration + smoke + e2e instead. Thresholds: **lines/functions/statements ≥ 80%, branches ≥ 70%** —
`make coverage` fails below them. The default `make test` stays fast and does not gate on coverage.

### 5.3 Isolation commands (the security spine)

```bash
scripts/check-rls.sh          # static: every tenant table has FORCE RLS + both policies
pnpm --filter @relay/server test   # dynamic: integration + (soon) test/isolation cross-tenant probes
```

Both must be green. The dynamic isolation suite proves org A cannot read org B for every role.

### 5.4 API documentation — generate it once the endpoints are tested

**Order matters: test the API first, then document it.** The moment an endpoint's tests are green,
its docs must exist and be accurate. Docs are generated from the route `schema` blocks, never written
by hand — so they cannot drift from the code.

1. Give every route a `schema` (tags, summary, `body`/`params`/`response`). This one block does triple
   duty: **request validation**, **Swagger UI docs**, and **the generated OpenAPI spec**. See
   `modules/models/routes/models.routes.ts` and `modules/proxy/routes/proxy.routes.ts`.
2. After the endpoint's tests pass, regenerate the spec:

   ```bash
   make generate        # → relay openapi → writes api/openapi/openapi.json
   ```

3. Eyeball it live: `make dev`, open **http://localhost:3000/docs** (Swagger UI) and
   **/openapi.json** — confirm the new path, its request body, and responses are correct.
4. Commit the refreshed `api/openapi/openapi.json` with the code. A public API change without a spec
   diff is an incomplete PR (§7, §10).

Rule of thumb: **an endpoint is not "done" until it is tested AND appears correctly in `/docs`.**

---

## 6. Local verification — run this BEFORE anything goes live

Every action tested locally, in order. Green top-to-bottom = safe to open a PR / cut a build.

```bash
# 0 · prerequisites (once)
make bootstrap                       # checks tools, copies .env, installs, builds shared types

# 1 · static quality (fast, no infra)
pnpm turbo lint typecheck build      # eslint + tsc + tsup/next build (all packages)
pnpm exec prettier --check .         # formatting
pnpm run dep-check                   # architecture boundaries (platform ↛ modules, private internals)
scripts/check-rls.sh                 # RLS gate — every tenant table protected

# 2 · database
make up                              # compose core + migrate + seed (postgres/valkey/logto/minio)
#   verify migrations idempotent:
node packages/server/dist/index.js migrate   # second run → "0 applied, N up-to-date"

# 3 · tests
make test                            # unit + integration (integration runs because DB is up)
make coverage                        # coverage thresholds (business logic ≥ 80%)

# 4 · API docs (after the API tests are green)
make generate                        # regenerate api/openapi/openapi.json from route schemas

# 5 · run it + smoke + load + docs
make dev                             # core + mockllm + watch all packages
scripts/smoke.sh                     # 7 end-to-end contract checks → SMOKE OK
open http://localhost:3000/docs      # Swagger UI — confirm new/changed endpoints render
node scripts/load-smoke.mjs          # hot-path p50/p95/p99 → LOAD OK   (or: k6 run test/load/chat-completions.js)

# 5 · teardown
make down                            # stop everything, drop volumes
```

If any step is red, fix it before proceeding — a later step assumes the earlier ones passed.

---

## 7. Definition of Done (a PR is done when…)

- [ ] Code follows the layer rules (§2); `pnpm run dep-check` green.
- [ ] No SQL outside `*.queries.ts`; every query parametrized (§3.4).
- [ ] New tenant table → RLS in the migration + an isolation probe; `check-rls.sh` green.
- [ ] Multi-statement writes / cross-row invariants wrapped in a transaction (§3.3).
- [ ] Unit tests for new business logic; integration test if it touches the DB. `make test` green.
- [ ] `make coverage` meets thresholds for the code you added.
- [ ] `scripts/smoke.sh` passes against a local `make dev`.
- [ ] **New/changed endpoint tested → `make generate` run → `api/openapi/openapi.json` committed and the
      endpoint renders correctly at `/docs`** (§5.4).
- [ ] User-facing API change → error codes in `shared/errors.ts` + trace headers; docs updated.
- [ ] Conventional-commit message; CI (lint · typecheck · build · test · rls-gate · security) green.

---

## 8. Recipe — add a new DB-backed module in 7 steps

Target structure mirrors `modules/models/`. Example: an `applications` module.

1. **Migration** (if new tables): `db/migrations/NNNN_applications.sql` — table + `org_id` + FORCE RLS
   - both policies. Run `scripts/check-rls.sh`.
2. **Types**: `types/applications.types.ts` — row shape, API shape, `ApplicationsRepository`,
   `ApplicationsService` interfaces.
3. **Queries**: `queries/applications.queries.ts` — parametrized `SqlQuery` builders. Nothing else.
4. **Repository**: `repositories/applications.repository.ts` — `createApplicationsRepository(db: Queryable)`;
   runs the queries; for tenant tables expose a `withTx(tx)` variant used inside `withTenant`.
5. **Service**: `services/applications.service.ts` — business logic over the repository interface. No SQL/HTTP.
6. **Controller + routes**: `controllers/applications.controller.ts` + `routes/applications.routes.ts` —
   validate, map to responses, bind paths.
7. **Wire + test**: `index.ts` exports `registerApplications(app, { db })`; call it from `src/app.ts`.
   Add `tests/` unit tests (fake repo) + an integration test (real pg, self-skipping) + an isolation probe.

Then run §6 top-to-bottom. If it's green, it's ready.

---

## 9. Code style — write for humans first

Code is read far more often than it is written. Optimize every line for the next developer, not for
cleverness. This is a review rule, not a suggestion.

- **Clarity over cleverness.** Prefer the obvious version. No dense one-liners, no nested ternaries, no
  "smart" abstractions that save two lines but cost ten minutes of reading. If a reviewer has to pause,
  rewrite it.
- **Name things for intent**, not implementation: `withTenant`, `sealCredential`, `listModelsQuery` —
  the name says what and why. Avoid `data`, `tmp`, `doIt`, single letters (except tight loop indices).
- **Small, single-purpose functions.** One reason to change each. If a function needs a "and" to
  describe it, split it. Layers already enforce this — keep functions inside a layer small too.
- **Explain the WHY in comments, never the WHAT.** The code says what it does; a comment says why it
  exists or why it's non-obvious (see the `// backpressure: never buffer unbounded` note in the proxy).
  No comments that restate the line.
- **Fail loud and early.** Validate at the boundary, throw typed errors (`UpstreamError`), return
  explicit `null` for not-found — never swallow. No silent `catch {}` without a reason.
- **Keep the shape flat.** Guard-clause and early-return over deep nesting. A function should read
  top-to-bottom like a paragraph.
- **No premature abstraction.** Duplicate twice before extracting. Copy `modules/models/` for a new
  module rather than inventing a framework.

The existing modules are the reference — match their density, naming, and comment style. If new code
looks noticeably more complex than `models/` or `proxy/`, simplify it before opening the PR.

---

## 10. Technical documentation — the last step of every change

Code is not done until the docs that describe it are true. Documentation is part of the Definition of
Done (§7), not an afterthought, and it is **the final gate before anything goes live**.

**What must stay in sync (update in the same PR as the code):**

| Change                         | Doc to update                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------- |
| New/changed public endpoint    | OpenAPI (`api/openapi/`, `make generate`) + error codes in `shared/errors.ts` |
| New module or layer convention | this guide (§2 layout, §8 recipe)                                             |
| New table / RLS decision       | `db/migrations/README.md` + the migration's own header comment                |
| New env var                    | `deploy/compose/.env.example` + `platform/config.ts` schema                   |
| Architecture decision          | an ADR under `docs/adr/NNNN-title.md` (one per §21 decision touched)          |
| New make target / script       | the `make help` line + this guide's §6 checklist                              |

**Rules:**

- Every exported function/type carries a short doc comment saying what it is and why (see the file
  headers throughout `src/`). Public API changes require an OpenAPI diff in the PR description.
- The three living documents — this **DEVELOPMENT.md**, the **PRD**, and the **Engineering Playbook** —
  are the map of the system. When behavior changes, the doc changes with it; a PR that drifts them is
  incomplete.
- **Before going live**, re-read the touched sections of this guide and confirm the code matches. Stale
  docs are treated as bugs.
