# Week 1 — Foundation & Hot-Path Skeleton — Completion Checklist

Goal (PRD §7): a walking skeleton — a completion streams client → gateway → mockllm over real infra,
CI green, tag `v0.1.0`. **Status: CLOSED ✅** (all Days 1–5 delivered and verified).

## Day-by-day

### Day 1 — Repo, monorepo & tooling ✅

- [x] Monorepo (pnpm + turbo), strict tsconfig, dependency-cruiser boundaries
- [x] commitlint + husky, CI (`ci.yml`), `pnpm turbo lint typecheck build` green

### Day 2 — Compose core + migrations + RLS ✅

- [x] `deploy/compose` core/dev profiles (postgres/valkey/logto/minio + mockllm)
- [x] `relay migrate` — advisory-locked, checksummed, idempotent (9 migrations, whole §3 model)
- [x] RLS template + `scripts/check-rls.sh` gate; isolation proven (org A ⊥ org B)
- [x] `platform/db` singleton pool + `withTenant` (`SET LOCAL` via `set_config`)
- ~ Deviation: pg + parametrized repositories instead of the Kysely query-builder

### Day 3 — Platform kernel ✅

- [x] `config` (zod, boot validation), `crypto` (AES-256-GCM envelope, tested)
- [x] `als`, `logger` (pino), `eventbus` (valkey/ioredis), `metrics` (prom-client)
- [x] `app` factory — `/healthz` `/readyz` `/metrics` on the internal port
- ~ Deviation: no OpenTelemetry SDK yet (prom-client + pino `trace_id` in place)

### Day 4 — Proxy skeleton streaming to mockllm ✅

- [x] `POST /v1/chat/completions` — routes → controller → service, SSE re-chunk, backpressured
- [x] Virtual-key format check → 401; `X-Relay-*` response headers
- [x] mockllm emulates native OpenAI + Anthropic wire (+ knobs), OpenAI-style 404, 8 tests
- ~ Deviation: global `fetch` instead of undici per-host pools (fine for the skeleton)

### Day 5 — Seeds, Logto, bench, tag ✅

- [x] `seed-demo` — seeds org/app/cred/route/target/key, prints a working curl; minted key streams;
      idempotent on re-run
- [x] `seed-auth` — idempotent Logto Management API bootstrap (`platform/logto.ts`, ADR-7), 3 tests;
      **verified live** against Logto (created Relay API resource + roles; re-run idempotent)
- [x] Console Logto sign-in (`@logto/next`) — verified live: `/` shows sign-in; OIDC leg → `303 /sign-in`
- [x] Bench gate — `scripts/bench.mjs` gates gateway overhead p99 < 25ms (G3); `bench.yml` wired.
      Local: p50 3.8ms / p99 ~10ms
- [x] `security.yml` green; tag `v0.1.0` present

## Beyond Week 1 (done early)

- [x] Full §3 data model, `models` DB vertical + Swagger `/docs` + `/openapi.json`
- [x] Per-package layered architecture, production error system (`shared/errors.ts` + `docs/errors.md`)
- [x] Docs: `DEVELOPMENT.md`, `SETUP.md`, `errors.md`, engineering-playbook PDF

## Green-bar

`lint · typecheck · build` · prettier · dep-check (0) · check-rls · **44 tests** · coverage 98.8% ·
smoke 7/7 · seed-auth+seed-demo+bench+console all live-verified · `pnpm audit --prod` clean.

## Carry-forward (not Week-1 blockers)

- Deviations to revisit: OpenTelemetry, undici per-host pools, Kysely.
- Console is sign-in only; P0 management screens are Day 13 (Week 3).
- Dev port note: console (`:3000`) and gateway (`:3000`) collide — run the gateway on another port locally.
