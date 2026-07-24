# Relay Gateway — Manual Testing Guide

Test every feature by hand, one at a time, from the ground up. Ordered by **level**: each level assumes
the ones below it work. Every test states **what the feature is + why it exists**, the **steps**, and
the **expected result** so you can check it off.

> **Before you start**
>
> 1. Clean slate + running stack — see `SETUP.md` §12.1 (reset) then `make dev`.
> 2. Get the demo data-plane key: `KEY=$(cat .relay/seed-demo.key)` (written by `make seed-demo`).
> 3. Console sign-in needs the Logto web app configured (`SETUP.md` §5.3) + `packages/console/.env.local`.
>
> Ports: gateway `:3000` (data) / `:9090` (internal) · console `:3100` · mockllm `:8080` · Postgres
> `:5432` · Valkey `:6379` · Logto `:3001`/`:3002` · MinIO `:9000`/`:9001`.

**Legend:** ✅ pass · ⬜ to test. Copy this file, tick as you go.

---

## Level 0 — Infrastructure & health

**Why:** nothing else works until the datastores, mock upstream, and both gateway planes are up.

| #   | Feature                       | Steps                                                                                                                 | Expected                                                            |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 0.1 | Containers healthy            | `docker compose -f deploy/compose/compose.yaml ps`                                                                    | postgres, valkey, logto, minio, mockllm all `healthy`/`running`     |
| 0.2 | Gateway liveness              | `curl -s localhost:9090/healthz`                                                                                      | `{"status":"ok"}`                                                   |
| 0.3 | Gateway readiness (pg+valkey) | `curl -s localhost:9090/readyz`                                                                                       | `{"status":"ready","pg":true,"valkey":true}` (503 if a dep is down) |
| 0.4 | mockllm up                    | `curl -s localhost:8080/healthz`                                                                                      | ok                                                                  |
| 0.5 | Postgres reachable            | `source deploy/compose/.env; PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -U postgres -d relay -c '\dt'`         | table list                                                          |
| 0.6 | Valkey reachable              | `docker exec relay-valkey-1 valkey-cli PING`                                                                          | `PONG`                                                              |
| 0.7 | Migrations applied            | `PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -U postgres -d relay -c "SELECT count(*) FROM schema_migrations;"` | 11                                                                  |

---

## Level 1 — Data plane (the hot path)

The OpenAI-compatible proxy on `:3000`. Auth is a **virtual key** (`rk_live_…`). This is what your
apps call. Set `KEY=$(cat .relay/seed-demo.key)` first.

### 1.1 Model discovery

**Feature:** `GET /v1/models` lists the catalog so SDKs can discover models. No auth (public metadata).

```bash
curl -s localhost:3000/v1/models | jq '.data[].id'
curl -s localhost:3000/v1/models/gpt-4o | jq
```

**Expected:** a `{object:"list",data:[…]}` with `gpt-4o` etc.; single-model lookup returns `owned_by:"openai"`.

### 1.2 Non-streaming chat completion

**Feature:** the core proxy — translate → route → call upstream → normalize back to OpenAI shape.

```bash
curl -s localhost:3000/v1/chat/completions \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hello"}]}' | jq
```

**Expected:** `object:"chat.completion"` with a `choices[0].message.content` and a `usage` block.

### 1.3 Streaming chat completion

**Feature:** SSE streaming with pre-first-token failover + backpressure.

```bash
curl -sN localhost:3000/v1/chat/completions \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"gpt-4o","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

**Expected:** a stream of `data: {chat.completion.chunk}` lines ending with `data: [DONE]`.

### 1.4 Response-header contract (§4.2)

**Feature:** every response carries a stable set of `x-relay-*` headers the console/SDKs depend on.

```bash
curl -sD - -o /dev/null localhost:3000/v1/chat/completions \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}' | grep -i '^x-relay'
```

**Expected:** `x-relay-trace-id`, `x-relay-provider`, `x-relay-cache: miss`, `x-relay-failover: false`,
`x-relay-cost-usd` (6 dp), `x-relay-modalities: text`. (See `docs/response-headers.md`.)

### 1.5 Error contract (OpenAI-compatible)

**Feature:** one error envelope everywhere (`errors.md`); SDKs handle it natively.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' -d '{"model":"gpt-4o","messages":[]}'          # 401 invalid_api_key
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/v1/chat/completions \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"model":"gpt-4o"}'  # 400 invalid_request
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/v1/models/nope                # 404 model_not_found
```

**Expected:** 401 / 400 / 404 respectively; bodies are `{error:{message,type,code,param}}`.

### 1.6 Inline image validation (Day 12d)

**Feature:** inline `data:` images are magic-byte-sniffed at ingress; spoofed/oversized content is rejected.

```bash
# a data URI claiming png but carrying non-image bytes → 400 invalid_request
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/v1/chat/completions \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"model":"gpt-4o","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,bm90LWFuLWltYWdl"}}]}]}'
```

**Expected:** `400` (content is not a recognized image). A text-only request still returns `x-relay-modalities: text`.

### 1.7 Swagger UI + OpenAPI

**Feature:** self-documenting data plane, generated from route schemas.

- Open `http://localhost:3000/docs` → try an endpoint interactively.
- `curl -s localhost:3000/openapi.json | jq '.info.version'`.

**Expected:** Swagger UI renders every path; the spec lists `/v1/*` and `/api/v1/*`.

---

## Level 2 — Control plane API (Logto JWT)

The `/api/*` surface the console consumes. Auth is a **Logto access token** (not a `rk_` key). Easiest
to exercise via the console (Level 3); to hit it directly you need a JWT for the Relay API resource.

**Get a token (optional, for curl):** sign into the console, or mint one with the Logto M2M app for the
`https://relay.gateway/api` resource. Then `JWT=<token>`.

| #   | Feature                | Endpoint                                     | Expected                                       |
| --- | ---------------------- | -------------------------------------------- | ---------------------------------------------- |
| 2.1 | Who am I               | `GET /api/v1/me`                             | `{user_id, org_id, scopes, is_platform_admin}` |
| 2.2 | List apps              | `GET /api/v1/apps`                           | `{object:"list",data:[…]}`                     |
| 2.3 | Create app             | `POST /api/v1/apps {name}`                   | 201 application object                         |
| 2.4 | Issue key              | `POST /api/v1/apps/{id}/keys`                | 201 with a **one-time** plaintext `key`        |
| 2.5 | Rotate / revoke        | `POST /api/v1/keys/{id}/rotate` · `/revoke`  | successor key / revoked status                 |
| 2.6 | Providers (write-only) | `GET/POST /api/v1/providers`                 | reads return `last4` only, never the secret    |
| 2.7 | Analytics              | `GET /api/v1/analytics/usage?group_by=model` | grouped spend buckets                          |
| 2.8 | Audit                  | `GET /api/v1/audit`                          | hash-chained records, newest first             |
| 2.9 | No token → 401         | any `/api/*` without a JWT                   | `401`                                          |

**Direct-curl example (control plane):**

```bash
curl -s localhost:3000/api/v1/me -H "authorization: Bearer $JWT" | jq
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/v1/apps        # 401 without a JWT
```

---

## Level 3 — Console UI (onboarding → build → operate)

The whole product flow with **no cURL**. Open `http://localhost:3100`.

### 3.1 Sign in

**Feature:** Logto session; the landing routes you into the console.
**Steps:** click **Sign in with Logto** → authenticate → land back on `/`.
**Expected:** signed-in landing with **Open console** (org members) and/or **Manage organizations** (admins).

### 3.2 Platform admin — onboard an org _(admin only)_

**Feature:** drives the tenancy onboarding + entitlements.
**Steps:** **Manage organizations** → fill the onboard form (name/admin email/template) → submit; toggle an entitlement and save.
**Expected:** the org appears in the table with an onboarding state; entitlement change persists on reload.

### 3.3 Dashboard + setup checklist

**Feature:** spend/usage overview from the analytics rollups + a self-completing checklist.
**Steps:** **Open console** → `/dashboard`.
**Expected:** tiles (Spend, Requests, Tokens, Top model); a **Setup** card whose steps tick green as you
create an app / provider / key / first request; a **Spend by model** table (empty until you make calls).

### 3.4 Applications

**Feature:** an app groups virtual keys.
**Steps:** **Applications** → enter a name → **Create application** → it appears in the list → **Manage keys**.
**Expected:** new app listed; detail page opens.

### 3.5 Virtual keys — one-time copy

**Feature:** issue a key; the plaintext is shown **exactly once** and is never re-fetchable.
**Steps:** on an app → **Create key** → choose env → **Issue key**.
**Expected:** the full `rk_live_…` key is revealed with a **Copy key** button, a **won't be shown again**
warning, and a **cURL / SDK** snippet; after closing, the list shows only `…last4`.

### 3.6 Virtual keys — rotate / revoke

**Feature:** rotate = successor + grace on predecessor; revoke = immediate reject.
**Steps:** **Rotate** (reveals the new key once) · **Revoke** (confirm dialog).
**Expected:** rotate shows a new plaintext; revoke flips status to `revoked` and disables actions.

### 3.7 Providers — write-only secrets

**Feature:** upstream credentials sealed on save; reads never return the secret.
**Steps:** **Providers** → add name + provider + secret (password field) → **Save credential**; then **Delete**.
**Expected:** row shows provider + `…last4` only (never the secret); delete asks to confirm and removes it.

### 3.8 Audit viewer

**Feature:** every control-plane change is recorded, hash-chained.
**Steps:** **Audit**.
**Expected:** a table (seq, when, actor, action, target) — you should see your app/key/provider actions.

### 3.9 Snippet drawer (DX)

**Feature:** copy-paste request for any key.
**Steps:** open **cURL / SDK** on an app or after issuing a key → switch curl / python / node → **Copy snippet**.
**Expected:** a ready-to-run request against `http://localhost:3000/v1` with the key filled in.

### 3.10 End-to-end (the PRD exit criterion)

**Feature:** a non-author does the whole loop from the UI.
**Steps:** create app → issue key (copy it) → grab the snippet → run it in a terminal → return to **Dashboard**.
**Expected:** the call succeeds; the dashboard's Requests/Spend and the checklist's **first request** step update.

---

## Level 4 — Security & isolation (the trust spine)

**Why:** multi-tenant means org A must **never** see org B; secrets must never leak.

### 4.1 RLS — cross-tenant isolation (automated proof)

**Feature:** Postgres Row-Level Security blocks every cross-org read; platform-admin is the only bypass.

```bash
source deploy/compose/.env
export RELAY_ISOLATION_APP_URL="$RELAY_DATABASE_URL"          # relay_app role — RLS APPLIES
export RELAY_MIGRATION_DATABASE_URL RELAY_MASTER_KEY
pnpm --filter @relay/server exec vitest run src/isolation
```

**Expected:** `3 passed` — org A sees its own rows, **zero** of org B's in every tenant table (targeted +
unfiltered scan), platform-admin can read across (the controlled bypass).

### 4.2 RLS — static gate

**Feature:** every `org_id` table is forced-RLS with both policies.

```bash
bash scripts/check-rls.sh
```

**Expected:** `RLS gate: all tenant tables covered.`

### 4.3 RLS — live psql probe

**Feature:** see isolation yourself as the runtime role.

```bash
source deploy/compose/.env
# as relay_app WITHOUT tenant context → RLS returns nothing
PGPASSWORD="$RELAY_APP_PASSWORD" psql -h localhost -U relay_app -d relay -c "SELECT count(*) FROM applications;"
# scoped to the demo org → only its rows (get the id as superuser first)
ORG=$(PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -U postgres -d relay -tAc "SELECT id FROM organizations LIMIT 1")
PGPASSWORD="$RELAY_APP_PASSWORD" psql -h localhost -U relay_app -d relay -c \
  "BEGIN; SELECT set_config('app.current_org','$ORG',true); SELECT count(*) FROM applications; COMMIT;"
```

**Expected:** 0 without context; the org's own count with context.

### 4.4 Virtual keys stored hashed

**Feature:** keys are SHA-256 + last4, never plaintext.

```bash
source deploy/compose/.env
PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -U postgres -d relay -c \
  "SELECT last4, length(key_sha256) AS hash_len FROM virtual_keys LIMIT 3;"
```

**Expected:** rows show `last4` + a 32-byte hash; **no plaintext key column exists**.

### 4.5 Provider secrets encrypted + write-only

**Feature:** AES-256-GCM envelope encryption; reads never select the sealed columns.

```bash
PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -U postgres -d relay -c \
  "SELECT name, provider, last4, length(ciphertext) FROM provider_credentials LIMIT 3;"
curl -s localhost:3000/api/v1/providers -H "authorization: Bearer $JWT" | jq '.data[0]'
```

**Expected:** DB holds ciphertext/iv/auth_tag/wrapped_dek; the API response has **no** secret field (only `last4`).

### 4.6 Console scope gating (server-side)

**Feature:** protected pages redirect the unauthorized before rendering — not just hidden UI.

```bash
# with the console running, unauthenticated:
for p in /dashboard /apps /providers /audit; do
  curl -s -o /dev/null -w "$p -> %{http_code} %{redirect_url}\n" "http://localhost:3100$p"
done
# or automated:
RELAY_E2E_BASE_URL=http://localhost:3100 pnpm --filter @relay/console exec playwright test test/e2e/gating.spec.ts
```

**Expected:** each protected route redirects to `/` (never serves the page); Playwright gating specs pass.

### 4.7 Audit chain integrity

**Feature:** tamper-evident trail; `relay audit verify` re-walks every org's hash chain.

```bash
source deploy/compose/.env
pnpm --filter @relay/server exec tsx src/cli/index.ts audit verify
```

**Expected:** `audit ok  org … — N rows` per org, exit 0. (A tampered row would report the break seq + exit 1.)

---

## Level 5 — Value layer (cache · limits · budgets · metering)

### 5.1 Exact-match cache

**Feature:** an identical request is served from Valkey, skipping the upstream (tenant-isolated key).

```bash
# same body twice; the second should be a cache hit (needs RELAY_CACHE_TTL_S > 0)
for i in 1 2; do
  curl -sD - -o /dev/null localhost:3000/v1/chat/completions -H "authorization: Bearer $KEY" \
    -H 'content-type: application/json' -d '{"model":"gpt-4o","messages":[{"role":"user","content":"cache me"}]}' | grep -i '^x-relay-cache'
done
```

**Expected:** first `x-relay-cache: miss`, second `x-relay-cache: hit-exact` (cost header `0.000000`).

### 5.2 Rate limits

**Feature:** per-key rpm/tpm via atomic Valkey Lua; emits `429 rate_limited` + `x-ratelimit-*`.
**Steps:** with a low rpm configured for the key, fire a quick burst.
**Expected:** headers `x-ratelimit-remaining-requests` decrement; over the limit → `429 rate_limited` + `retry-after`.

### 5.3 Budgets

**Feature:** per-org daily/monthly USD cap; `budget_exceeded` when hard cutoff hit.
**Expected:** requests settle actual cost against the reservation; exceeding a hard budget → `402/403 budget_exceeded`.

### 5.4 Metering → rollups → analytics

**Feature:** each request lands one priced usage event; a worker rolls them into `usage_rollups_hourly`;
dashboards read rollups only.

```bash
# make a few calls, then check rollups (superuser)
source deploy/compose/.env
PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -U postgres -d relay -c \
  "SELECT model, requests, cost_usd FROM usage_rollups_hourly ORDER BY hour DESC LIMIT 5;"
```

**Expected:** rows accumulate after requests; the console **Dashboard → Spend by model** reflects the same.

---

## Level 6 — Observability & performance

### 6.1 Metrics

```bash
curl -s localhost:9090/metrics | grep -E 'relay_(gateway_overhead|requests_total|cache)'
```

**Expected:** `relay_gateway_overhead_seconds` histogram, `relay_requests_total{…}`, cache counters.

### 6.2 Trace correlation

**Feature:** every response carries `x-relay-trace-id`; every log line carries it.
**Steps:** grab a request's `x-relay-trace-id`, then grep the gateway logs for it.
**Expected:** the request's lifecycle lines share that trace id.

### 6.3 G3 latency gate

**Feature:** gateway-only overhead p99 < 25ms (invariant to upstream latency).

```bash
make bench                    # or: RELAY_LOAD_KEY=$(cat .relay/seed-demo.key) node scripts/bench.mjs
```

**Expected:** `BENCH OK` with p99 well under 25ms.

### 6.4 Smoke (end-to-end contracts)

```bash
scripts/smoke.sh              # against a running make dev
```

**Expected:** `SMOKE OK` — health, models, completions, the header contract, and control-plane 401s.

---

## Appendix — automated equivalents

| Layer                       | Command                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Unit + integration (server) | `source deploy/compose/.env; export RELAY_TEST_DATABASE_URL="$RELAY_MIGRATION_DATABASE_URL"; pnpm --filter @relay/server exec vitest run` |
| Cross-tenant isolation (G4) | `RELAY_ISOLATION_APP_URL=$RELAY_DATABASE_URL … vitest run src/isolation` (Level 4.1)                                                      |
| Console unit                | `pnpm --filter @relay/console test`                                                                                                       |
| Console E2E (gating)        | `make e2e` (or the Playwright command in 4.6)                                                                                             |
| Coverage thresholds         | `make coverage`                                                                                                                           |
| Full local gate             | lint · typecheck · build · prettier · dep-check · check-rls · test · smoke · bench                                                        |

> **Tip:** to start each run from zero, follow `SETUP.md` §12.1 (data reset) — it wipes tenant data,
> keeps Logto, and re-seeds a fresh demo key.
