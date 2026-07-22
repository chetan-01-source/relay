# Relay Gateway — Week 3 Engineering PRD (Days 11–15) → **v0.2.0**

> Derived from `llm/docs/Relay-Gateway-3-Week-Dev-Cycle-PRD.pdf` §9–§16, executed under
> [DEVELOPMENT.md](DEVELOPMENT.md). Companion: [SETUP.md](SETUP.md), [errors.md](errors.md),
> `docs/adr/`. This is the _how_ for the final week: add the value layer (cache, metering, audit,
> analytics), make it usable (console), make it safe (hardening), and ship a signed, self-hostable
> `v0.2.0`.

**Goal of the week:** turn the multi-tenant core (Weeks 1–2) into a **Production-Ready Phase 1**
release: `git clone → make up → make seed-demo` boots in < 5 min; a Platform Admin onboards two orgs
from the console; each streams a real completion with **per-app cost**; a budget hard-cutoff blocks
the over-limit org in < 5 s; the isolation suite proves org A cannot read org B; CI is green; and
signed multi-arch images + a compose self-host bundle are published to GHCR.

---

## 0 · Where we are — Weeks 1–2 in place (verified 2026-07-21, `main` @ Day-10)

Confirmed present and green before Week 3 starts:

| Area            | State                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| Modules (9)     | `proxy · models · identity · tenancy · audit · apps · providers · routing · policy`                        |
| Migrations (11) | `0001`–`0011`; **`usage_events` + `usage_rollups_hourly` (0007) + `rate_cards` seed (0009) already exist** |
| Platform kernel | `config · db (withTenant/Queryable) · crypto · als · eventbus · metrics · migrate`                         |
| Data plane      | `/v1/chat/completions` (stream + non-stream), `/v1/models` — real routing, failover, limits/budgets        |
| Control plane   | `/api/v1/platform/orgs/*`, `/api/v1/apps`, `/api/v1/keys`, `/api/v1/providers` (Logto-JWT guarded)         |
| Security spine  | RLS forced on every tenant table; `check-rls.sh` green; isolation suite 10 tables, 0 cross-tenant          |
| Tests / gates   | 156 tests (unit + real-pg integration + real-Valkey Lua + isolation); coverage 96.6%/89%/92.8%             |
| CI workflows    | `ci · security · conformance · bench · release · pr-title` (release/conformance still stubs)               |
| Console         | Logto sign-in + `page.tsx`, `orgs/page.tsx`, `callback/route.ts` — **P0 screens not built yet**            |

**Week-3 net-new:** modules `cache`, `metering`, `analytics`; audit **read/verify** endpoints; console
P0 screens; operability hardening; the `release.yml` body + self-host bundle. No new hard
non-negotiables — Week 3 obeys the same four (below).

---

## 1 · Non-negotiables carried into Week 3 (never cut, §2 of source PRD)

1. **RLS on every tenant table** — any new `org_id` table adds `FORCE` RLS + `tenant_isolation` +
   `platform_admin_access` in the same migration, an isolation-suite entry, and passes `check-rls.sh`.
2. **Two-key discipline** — virtual key hashed; provider credential envelope-encrypted; plaintext
   never logged/echoed. (No new secrets in Week 3, but cache keys must not embed secrets.)
3. **No synchronous Postgres/MinIO on the hot path** — metering writes go through a **bounded
   in-process ring queue**; cache reads/writes hit **Valkey only**; dashboards read **rollups**, never
   raw partitions or the hot path.
4. **Isolation suite zero-tolerance** — any cross-tenant read fails the build.

Plus the standing rules from DEVELOPMENT.md: SQL only in `*.queries.ts` (parametrized); one error
contract (`RelayError` + `ERROR_CATALOG`); contract-first route `schema` → `make generate`; layer
boundaries enforced by `dep-check`; every exported symbol carries a why-comment.

---

## 2 · Reuse map — build on what exists, invent nothing new

The single most important constraint this week: **compose existing primitives; do not re-implement.**

| Need (Week 3)                                 | Reuse this — exact symbol / file                                                                                        |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Tenant-scoped read/write + RLS                | `db.withTenant(orgId, { isPlatformAdmin }, tx => …)` — `platform/db.ts`                                                 |
| Parametrized SQL contract                     | `SqlQuery { text, values }` + `Queryable.run<T>()` — `platform/db.ts`                                                   |
| Atomic Valkey scripts (cache/rollup counters) | `EventBus.client.script('LOAD', …)` + `client.evalsha(...)` — pattern in `modules/policy/services/policy.service.ts`    |
| Valkey connection                             | `createEventBus(url).client` / `.publish` / `.subscribe` — `platform/eventbus.ts`                                       |
| Pub/sub snapshot invalidation                 | channels `key.invalidate` / `org.features.updated` — `modules/identity/lib/invalidation`                                |
| Cost math + rate cards                        | `rate_cards` table (`input/output_usd_per_1k`, `effective_from/to`); mirror `actualCostMicroUsd` in `policy.service.ts` |
| Usage captured at settle                      | `RequestTiming.usage {inputTokens,outputTokens}` + `timing.selectedTarget` — proxy already fills these                  |
| Audit append (hash chain)                     | `createAuditRepository().append(tx, event)` + `computeAuditHash`/`canonicalize` — `modules/audit`                       |
| Token estimate for cache/meter                | `adapterFor(provider).countTokens(req)` — `modules/proxy/adapters/adapter.ts`                                           |
| Error envelope                                | `throw new RelayError('code', …)`; add codes to `ERROR_CATALOG` (`shared/errors.ts`)                                    |
| Trace / org logging context                   | `getContext()` (traceId, orgId) — `platform/als.ts`                                                                     |
| Metrics                                       | add counters/histograms to `platform/metrics.ts` `registry` (mirror `budgetSettles`)                                    |
| Response-header contract                      | set in `modules/proxy/controllers/proxy.controller.ts` (already emits `x-relay-*`)                                      |
| DB-backed module template                     | copy `modules/models/` (full stack) — per DEVELOPMENT.md §8                                                             |
| Console auth + API types                      | `@logto/next` session (Day 6 wiring) + generated `packages/console/app/lib/api-types.ts` (`make generate`)              |

**Hot-path rule of thumb:** the request handler may touch **Valkey** (cache lookup, rate/budget) and
**in-memory** state only. Everything durable (usage rows, rollups, audit) is enqueued and flushed by a
background worker — never `await`ed on the response path.

---

## 3 · Day-by-day plan

Each day is one mergeable PR: tests + telemetry + docs + isolation impact (DEVELOPMENT.md §7). Tracks:
**BE-1** hot path/cache/metering · **BE-2** analytics/audit/release · **FE-1** console.

---

### Day 11 — exact cache (Valkey) + metering (usage events, rollups) `[BE-1 ∥ BE-2]`

**Goal:** an identical request is served from cache on the 2nd call (header proves it); every proxied
call emits a priced usage event via an async queue with **zero added hot-path latency**; rollups
populate.

#### 11a · `modules/cache` (library module, data plane — no HTTP surface)

- **Layers:** `service → lib` (+ `types`). No repository/queries (Valkey only, no Postgres). Injected
  into `modules/proxy` like `routing`/`policy`.
- **Public API (`index.ts`):** `createCacheService({ bus })` → `{ get(key), set(key, value, ttl), keyFor(orgId, req) }`.
- **Key derivation (`lib/cache-key.ts`, pure + unit-tested):** normalize the request — strip
  non-semantic fields (stream, user, trace), canonicalize message order/whitespace, include
  `org · route · model · messages · tools · temperature bucket` **+ attachment digests / normalized
  URLs** (image parts) → `sha256` → `c:{org}:{hash}`. **Org is in the key** so cache is
  tenant-isolated by construction (no cross-tenant hit possible). Never include the virtual-key secret.
- **Semantics:** `X-Relay-Cache: hit-exact` on a hit; `TTL per route` (config default, override via
  route later — P0 = global default env `RELAY_CACHE_TTL_S`). **tee-within-cap on write:** only cache
  responses under a byte cap; stream responses are buffered up to the cap and written after the stream
  completes (never buffer unbounded — reuse the backpressure discipline from the proxy).
- **Wiring:** proxy controller checks cache **after** auth + policy `authorize` (a cached hit still
  counts against rate limits? → **P0: cache hit skips upstream + budget settle but still decrements
  rpm**; document in ADR). On miss, proceed to routing → upstream, then `cache.set` on the way out.
- **Reuse:** `bus.client` Lua/`SET EX`; `adapterFor().countTokens` for cap heuristics; `getContext()`
  for trace logging.

#### 11b · `modules/metering` (library module, write path via ring queue)

- **Layers:** `service → repository → queries` (+ `lib/ring-queue.ts`, `types`). Tables exist
  (`usage_events`, `usage_rollups_hourly`).
- **`lib/ring-queue.ts` (pure, bounded):** fixed-capacity FIFO; `enqueue(event)` returns immediately;
  **drops oldest + increments a drop metric when full** (never blocks the hot path, never grows
  unbounded — non-negotiable #3). Unit-tested for wrap-around + drop counting.
- **`service.recordUsage(event)`** — called from the proxy controller **after the response is fully
  sent** (post-flight, mirrors `policy.settle` placement). Computes `cost_usd` from `rate_cards`
  (effective row) using the same math as `actualCostMicroUsd`. Enqueues; a **flush worker** batches
  inserts via `withTenant(orgId, …)` per org (RLS applies on write).
- **`usage_events` insert** carries `org_id, app_id, key_id, route_id, request_id (=traceId), provider,
model, input_tokens, output_tokens, cost_usd, status, latency_ms`. Status ∈ `ok|error|rate_limited|
budget_exceeded` — so rejected requests are metered too (record on the 429 path).
- **Hourly rollup worker (`usage_rollups_hourly`):** periodic job `UPSERT … ON CONFLICT (org_id, hour,
app_id, route_id, provider, model) DO UPDATE SET requests = +…`. Runs on an interval; idempotent.
  Dashboards (Day 12) read only this table.

**New env:** `RELAY_CACHE_TTL_S` (default 0 = off), `RELAY_METERING_QUEUE_MAX`, `RELAY_ROLLUP_INTERVAL_S`
→ add to `platform/config.ts` zod schema + `deploy/compose/.env.example`.

**New telemetry:** `relay_cache_hits_total{result}`, `relay_metering_queue_depth`,
`relay_metering_dropped_total`, `relay_rollup_runs_total`.

**Tests:** cache-key normalization (identical semantics → same key; different org → different key);
ring-queue drop/wrap; cost math vs rate_cards; metering integration (real pg: enqueue → flush →
`usage_events` row visible only to its org); rollup upsert integration.

**Exit:** identical request cache-hits on 2nd call (header proves it); every proxied call emits one
priced usage event via the queue with zero hot-path latency added (bench unchanged); rollups populate.

---

### Day 12 — analytics API + audit endpoints + response-header contract + image passthrough (stretch) `[BE-2 + BE-1]`

#### 12a · `modules/analytics` (full stack, control plane)

- Copy `modules/models/`. Endpoint: `GET /api/v1/analytics/usage?group_by=app|route|model|day` +
  `?format=csv|json` export. **Reads `usage_rollups_hourly` only** (never raw partitions). Guarded by
  the identity `authJwt` preHandler; tenant-scoped via `withTenant`. Platform-admin cross-org summary
  variant (mirrors tenancy's admin pattern).
- Queries: parametrized `GROUP BY` builders (validate `group_by` against an allowlist at the
  controller boundary — no interpolation). CSV export streamed at the controller.

#### 12b · Audit read/verify (finish `modules/audit`)

- Add `controllers/ + routes/` to the existing audit library: `GET /api/v1/audit` (list, tenant-scoped)
  - `relay audit verify` CLI that re-walks the hash chain (`computeAuditHash(prev_hash ||
canonicalize(row))`) and fails on a break. Reuse `createAuditRepository`; add read queries.

#### 12c · Finalize response-header contract (§4.2)

- Guarantee `X-Relay-Cost-USD · X-Relay-Provider · X-Relay-Failover · X-Relay-Modalities` (+ existing
  `x-relay-trace-id`, `x-relay-cache`, `x-ratelimit-*`) on the proxy response. Cost header set from the
  settled `timing.usage` × rate card. Document the full contract in `docs/` and assert it in smoke.

#### 12d · **[STRETCH]** inline image passthrough (OpenAI-compat)

- Manifest images at ingress (streaming sha256 + magic-byte sniff), attachment-aware cache key (already
  designed in 11a). **Defer** audio/Gemini/object-store to Weeks 4+ (§14). Only do this if Days 11–13
  are on time; otherwise park in the backlog per the scope-cut protocol.

**New error codes** (if needed): none expected — analytics validation reuses `invalid_request`.

**Exit:** org dashboard queries return grouped spend; every mutation appends a verifiable audit record
(`relay audit verify` passes); response headers match the contract.

---

### Day 13 — Console P0 screens end-to-end `[FE-1 lead + BE-1/2 support]`

Next.js app-router (`packages/console`), server-side rendering gated by Logto session + scopes. All
data via the generated typed client (`app/lib/api-types.ts`, refreshed by `make generate`). **No new
backend** — consumes Week-1/2/Day-11/12 endpoints.

- **Platform Admin:** Organizations list · onboard-org wizard (drives the tenancy onboarding state
  machine) · org detail (entitlements editor, members, suspend) · cross-org dashboard (analytics
  admin summary).
- **Org / Build ("the product's heart"):** Applications · Virtual keys (create modal with **one-time
  copy**, rotate, revoke — hits `/api/v1/keys`) · Providers (secret **write-only** forms) · **Routes
  editor** (targets, fallback drag-order, capability-lint badges, cache toggle, version history +
  rollback).
- **Org / Overview + Operate:** setup checklist (onboarding state) · dashboard (spend / requests /
  cache savings / error rate from analytics) · live-traffic SSE table · trace detail.
- **DX rule:** every entity page has a **cURL / SDK snippet drawer**; conditional rendering by
  entitlements + scopes, **server-side**.

**Constraints:** keys shown once (never re-fetchable — matches `apps` service); provider secrets never
returned (forms are write-only); scope checks server-side, not just hidden in UI.

**Tests:** Playwright E2E (`test/e2e`) for onboarding → build → operate; a non-author creates a key and
makes a call using only the UI + snippet drawer.

**Exit:** the entire onboarding → build → operate flow is doable from the console with no cURL.

---

### Day 14 — Hardening, conformance, security gates, bench gate `[ALL]`

- **Graceful shutdown (BE-1):** `server.close()` drains in-flight SSE, flushes the metering queue,
  settles budgets, disconnects workers/Valkey. `/readyz` gates on Postgres + Valkey reachable +
  snapshot-warm (extend the existing internal-port health server). Unhandled-rejection policy: **fail
  the worker, let the cluster respawn** (never continue in an unknown state).
- **Conformance suite (BE-1, `test/conformance`):** official **OpenAI Python + TS SDKs** (stream /
  tools / errors) + LangChain + Vercel AI SDK pointed at gateway→`mockllm`; Playwright console E2E.
  Wire `conformance.yml` (currently a stub) — label + nightly trigger.
- **Security gates green (BE-2):** CodeQL, Trivy (fs + image), gitleaks, osv-scanner; `pnpm
--frozen-lockfile`; **ignore-scripts allowlist**; backup/restore runbook (`pg_dump` + MinIO mirror)
  tested. (js-yaml override lesson from Day-10 fix: keep the lockfile advisory-clean.)
- **bench.yml gate at G3 (BE-1):** k6 vs `mockllm` on a fixed runner; **fail if p99 > 25 ms @ 500 RPS /
  2 vCPU**; commit results to `bench/results/`. Verify overhead is invariant to `MOCKLLM_LATENCY_MS`.

**Exit:** conformance + isolation + E2E suites green; all security scans pass with no criticals; bench
green at G3; graceful shutdown verified under active stream.

---

### Day 15 — Release `v0.2.0`, self-host bundle, docs, external testers, retro `[ALL]`

**DevOps deliverables (applied to THIS stack — Docker Compose + GHCR, not AWS/SAM):**

- **`release.yml` body (BE-2)** — currently a Week-0 stub with triggers/permissions locked. On tag
  `v0.2.0`: `tests → semantic-release changelog → docker buildx multi-arch (amd64+arm64) → push
ghcr.io/…/relay{,-console} → Syft SBOM (SPDX + CycloneDX) → Cosign keyless sign (GitHub OIDC,
id-token: write — no stored keys) → Trivy gate on criticals → GitHub Release with cosign verify
instructions`.
- **Self-host bundle (BE-1):** `relay-selfhost.tar.gz` = `compose.yaml` + `.env.example` + `README`;
  `docker compose up -d` from the bundle boots against the published GHCR images (not a local build).
- **Quickstart docs (FE-1):** `git clone → first proxied call < 15 min`, error catalog (`docs/errors.md`),
  threat-model stub (STRIDE), self-hosting guide; docs site to GitHub Pages.
- **Sign-off (ALL):** 3 external testers walk the quickstart (G2 validation); full E2E onboarding demo;
  Phase-1 sign-off against §13 checklist; retro; update scope-cut ledger + Weeks-4+ backlog.

**Exit (Phase 1 DONE):** signed `v0.2.0` images + self-host bundle published; a self-hoster reaches a
first proxied call in < 15 min; all six G-goals met; §13 checklist closed.

---

## 4 · New migrations, errors, env, ADRs (the additive surface)

- **Migrations:** likely **none new** for cache/metering (tables exist). If a route-level cache TTL or
  a `route.cache_enabled` column is needed → additive `0012_route_cache.sql` (tenant table → RLS +
  isolation entry). Analytics/audit add **no tables** (read existing).
- **Error codes:** none expected beyond the current 16; reuse `invalid_request` for analytics
  validation. If audit-verify exposes a failure code, add one catalog entry + `docs/errors.md` row +
  test.
- **Env (config.ts + .env.example):** `RELAY_CACHE_TTL_S`, `RELAY_METERING_QUEUE_MAX`,
  `RELAY_ROLLUP_INTERVAL_S`, plus release/registry vars for CI (GHCR handled by Actions OIDC).
- **ADRs (one per decision, `docs/adr/NNNN`):** `0008` exact-cache (key derivation, tenant isolation,
  cache-hit vs rate-limit/budget interaction); `0009` metering ring-queue + rollup (why async, drop
  policy, rollup-only dashboards); `0010` release supply-chain (SBOM + cosign + Trivy gate).
- **make targets:** add `make selfhost-bundle`, `make audit-verify`; extend `make help` + §6 checklist.

---

## 5 · Testing & CI per day (gates that must stay green)

| Layer           | Week-3 additions                                                              | Gate                 |
| --------------- | ----------------------------------------------------------------------------- | -------------------- |
| Unit            | cache-key normalization, ring-queue, cost math, analytics query builders      | PR, coverage ≥ 80/70 |
| Integration     | metering enqueue→flush→row (RLS), rollup upsert, audit list/verify (real pg)  | PR                   |
| Isolation (G4)  | add any new tenant table; cache-key org-partition probe (no cross-tenant hit) | PR — zero-tol        |
| Conformance     | OpenAI/Anthropic SDK + LangChain + Vercel AI SDK vs gateway→mockllm           | nightly + release    |
| E2E             | Playwright console: onboarding → build → operate                              | nightly + release    |
| Load/bench (G3) | `bench.yml` strict gate p99 < 25 ms @ 500 RPS / 2 vCPU                        | release gate         |

Every day still runs the DEVELOPMENT.md §6 local sequence before PR: `lint · typecheck · build ·
prettier · dep-check · check-rls · test · coverage · make generate · smoke · bench`.

---

## 6 · Risks specific to Week 3 (+ mitigation)

| Risk                                        | Mitigation                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| Cache correctness / cross-tenant hit        | org in the cache key; isolation probe asserts org A never reads org B's cache   |
| Metering adds hot-path latency              | bounded ring queue + post-flight enqueue; bench gate catches regressions        |
| Metering queue overflow under load          | drop-oldest + `relay_metering_dropped_total` alarm; batched flush               |
| Console scope creep (routes editor is deep) | P0 screens only; "JSON view toggle" escape hatch; rich diff viewer → P1         |
| Provider drift / live calls in CI           | golden fixtures + `mockllm`; **no live provider calls in CI** (Ollama local $0) |
| Release signing / OIDC friction             | cosign keyless via GitHub OIDC (`id-token: write`); dry-run on a pre-tag        |
| Bench flakiness on shared CI runner         | fixed-runner strict gate; advisory elsewhere (existing pattern)                 |

**Scope-cut protocol (unchanged):** at the 16:30 check, if a day's exit criterion is at risk and it is
_not_ in the §2.1 exit demo → move to the Weeks-4+ backlog with an issue link; never cut a hard
non-negotiable to save time. Image passthrough (Day 12) is the designated stretch/first-to-cut.

---

## 7 · Definition of Done — Week 3 / Phase 1 (§13 checklist)

- [ ] `cache`, `metering`, `analytics` modules follow the layer rules; `dep-check` green.
- [ ] No SQL outside `*.queries.ts`; analytics `group_by` allowlisted, never interpolated.
- [ ] Any new tenant table → RLS + isolation probe; `check-rls.sh` green.
- [ ] Metering write path is async (ring queue), off the hot path; bench p99 < 25 ms @ 500 RPS / 2 vCPU.
- [ ] Cache hit is tenant-isolated (org in key) and proven by an isolation probe.
- [ ] Graceful shutdown drains SSE + flushes queue + settles budgets; `/readyz` gates pg + Valkey + warm.
- [ ] Unit + integration tests for all new logic; `make test` + `make coverage` green.
- [ ] New/changed endpoints → route `schema` → `make generate` → `openapi.json` + console types committed.
- [ ] New error codes (if any) in `shared/errors.ts` + `docs/errors.md`; response-header contract in smoke.
- [ ] ADRs `0008`–`0010` written; DEVELOPMENT.md §2 module list updated.
- [ ] Security scans (CodeQL/Trivy/gitleaks/osv) — no criticals; `--frozen-lockfile`; ignore-scripts allowlist.
- [ ] Conformance + E2E green (nightly/release); signed `v0.2.0` multi-arch images + SBOM + self-host bundle on GHCR.
- [ ] Quickstart proves `git clone → proxied call < 15 min`; 3 external testers sign off; §13 checklist closed.
- [ ] Conventional commits; feature/* → PR into `dev` (squash) → `dev` → `main` (fast-forward only).

---

## 8 · Sequencing summary

```
Day 11  cache + metering            (BE-1 ∥ BE-2)   → value layer, async, cached
Day 12  analytics + audit + headers (BE-2 + BE-1)   → spend visible, verifiable, contract frozen
Day 13  console P0 screens          (FE-1 + support) → usable end-to-end, no cURL
Day 14  harden + conformance + gates(ALL)           → safe to run, gates strict
Day 15  release v0.2.0 + bundle     (ALL)            → signed, self-hostable, docs, sign-off
```

One-line: in five days the multi-tenant core becomes a **signed, self-hostable, cost-attributed,
console-driven Phase-1 release** — proven isolated, proven fast (G3), proven reproducible (SBOM +
cosign). Then Weeks 4+ (§14): guardrails, semantic cache, replay, webhooks, Gemini, Helm, enterprise.
