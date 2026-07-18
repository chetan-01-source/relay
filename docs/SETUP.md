# Relay Gateway — Setup, Access & Debugging Guide

Everything needed to run the stack locally, reach every tool, test the APIs, and debug when something
breaks. Pairs with `DEVELOPMENT.md` (how we build), `errors.md` (error catalog), and the
`WEEK1-CHECKLIST.md`.

---

## 1. Prerequisites

| Tool             | Version | Check                                          |
| ---------------- | ------- | ---------------------------------------------- |
| Node.js          | ≥ 22    | `node -v`                                      |
| pnpm             | 9.x     | `pnpm -v` (`corepack enable`)                  |
| Docker + Compose | v2      | `docker version && docker compose version`     |
| openssl          | any     | `openssl version` (master key + cookie secret) |
| psql             | 14+     | `psql --version` (DB access)                   |
| curl             | any     | API testing                                    |

macOS/Linux native; Windows via WSL2.

---

## 2. First-time setup (clean machine → working stack)

```bash
# 1 · install + build shared types
make bootstrap                         # checks tools, copies .env.example→.env, installs, builds @relay/shared

# 2 · fill secrets in deploy/compose/.env  (the file is gitignored — never commit it)
#     POSTGRES_PASSWORD, RELAY_APP_PASSWORD, MINIO_ROOT_PASSWORD  → any strong local value
#     RELAY_MASTER_KEY   → openssl rand -base64 32   (32-byte envelope KEK; required by crypto/seed)
#     RELAY_LOGTO_*      → filled after the one-time Logto M2M step (§5.3), optional otherwise

# 3 · bring up infra + migrate + seed
make up                                # compose core up + relay migrate + seed-auth + seed-demo
#     seed-demo writes the demo key to .relay/seed-demo.key (gitignored) + prints a curl.

# 4 · run the gateway + mockllm (inner loop)
make dev                               # core + mockllm + turbo dev (gateway on :3000, internal :9090)
```

> **Port note (dev):** the console and the gateway both default to `:3000`. Run **one** at a time on
> 3000, or start the gateway on another port: `RELAY_PORT=3100 pnpm --filter @relay/server dev`.
> The console must stay on `:3000` to match its Logto redirect URI (`http://localhost:3000/callback`).

---

## 3. Environment variables

Server (`deploy/compose/.env`, validated by `platform/config.ts` at boot):

| Var                                                        | Purpose                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------- |
| `RELAY_DATABASE_URL`                                       | runtime DB, **relay_app** (RLS applies)                        |
| `RELAY_MIGRATION_DATABASE_URL`                             | migrations/seed, **postgres** superuser (bypasses RLS)         |
| `RELAY_VALKEY_URL`                                         | Valkey (limits/cache/pub-sub)                                  |
| `RELAY_MASTER_KEY`                                         | AES-256-GCM envelope KEK (base64, 32 bytes)                    |
| `RELAY_UPSTREAM_URL`                                       | Phase-1 hardcoded upstream → mockllm (`http://localhost:8080`) |
| `RELAY_PORT` / `RELAY_INTERNAL_PORT`                       | data plane / internal (health+metrics)                         |
| `RELAY_LOGTO_ENDPOINT` / `_M2M_APP_ID` / `_M2M_APP_SECRET` | Logto Management API (seed-auth)                               |

Console (`packages/console/.env.local`, gitignored — see `.env.example`):
`LOGTO_ENDPOINT`, `LOGTO_APP_ID`, `LOGTO_APP_SECRET`, `LOGTO_BASE_URL`, `LOGTO_COOKIE_SECRET`.

> **Secrets policy:** only `*.env.example` is committed; `.env` / `.env.local` are gitignored. The DB
> stores hashes (virtual keys) and envelope-encrypted ciphertext (provider credentials) only. Logs
> redact `authorization`, `*.apiKey`, `*.secret` (pino). `RELAY_MASTER_KEY` is never logged.

---

## 4. Tools & services — ports, purpose, access

| Service  | Port(s)     | Purpose                    | Access                                 |
| -------- | ----------- | -------------------------- | -------------------------------------- |
| Postgres | 5432        | tenant data (RLS)          | `psql` — §5.1                          |
| Valkey   | 6379        | limits · cache · pub/sub   | `valkey-cli` / `redis-cli` — §5.2      |
| Logto    | 3001 / 3002 | OIDC endpoint / admin UI   | browser `http://localhost:3002` — §5.3 |
| MinIO    | 9000 / 9001 | S3 API / web console       | browser `http://localhost:9001` — §5.4 |
| mockllm  | 8080        | mock upstream provider     | `curl` — §5.5                          |
| Gateway  | 3000        | data plane `/v1/*`         | `curl` / SDK — §6                      |
| Gateway  | 9090        | internal: health · metrics | `curl` — §7                            |
| Console  | 3000        | dashboard + Logto sign-in  | browser `http://localhost:3000` — §5.6 |

Container status: `docker compose -f deploy/compose/compose.yaml ps`.
Logs for one service: `docker compose -f deploy/compose/compose.yaml logs -f postgres`.

---

## 5. Accessing each tool

### 5.1 Postgres

Two roles: **postgres** (superuser, migrations/seed, bypasses RLS) and **relay_app** (runtime, RLS
applies). Passwords come from `deploy/compose/.env`.

```bash
source deploy/compose/.env

# superuser — see everything (no RLS)
PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -U postgres -d relay

# app role — RLS applies (queries return nothing until you set the tenant context, below)
PGPASSWORD="$RELAY_APP_PASSWORD" psql -h localhost -U relay_app -d relay
```

Useful queries:

```sql
-- applied migrations
SELECT filename, applied_at FROM schema_migrations ORDER BY filename;

-- all tenant tables + their RLS state (rowsecurity=t, forcerowsecurity=t expected)
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
WHERE relkind='r' AND relnamespace='public'::regnamespace ORDER BY relname;

-- inspect a tenant's data AS the app role (RLS-scoped). NOTE: `organizations` is itself RLS-scoped,
-- so the app role can't read the org id without context (chicken-egg). Get the id as superuser first:
--   ORG=$(PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -U postgres -d relay -tAc \
--         "SELECT id FROM organizations WHERE logto_org_id='demo'")
-- then, as relay_app, set that literal id and query:
BEGIN;
  SELECT set_config('app.current_org','<paste-org-uuid>', true);
  SELECT set_config('app.is_platform_admin','false', true);
  SELECT id, name FROM applications;      -- only the demo org's rows
COMMIT;

-- platform-admin view (see all tenants) as app role:
BEGIN;
  SELECT set_config('app.is_platform_admin','true', true);
  SELECT org_id, model FROM route_targets;
COMMIT;
```

> **Debugging RLS "empty results":** the app role returns **nothing** unless `app.current_org` is set
> in the transaction. That's correct — the gateway sets it per request via `withTenant`. To inspect
> data ad-hoc, use the superuser role or set the GUC as shown.

### 5.2 Valkey

```bash
docker exec -it relay-valkey-1 valkey-cli      # or: redis-cli -h localhost -p 6379
> PING            # PONG
> KEYS *          # inspect keys (rate-limit buckets / cache land Week 2-3)
> INFO keyspace
```

### 5.3 Logto (identity)

- **Admin console:** `http://localhost:3002` (sign in with the admin user).
- **OIDC endpoint:** `http://localhost:3001`.
- **One-time M2M setup for `seed-auth`:** Admin Console → Applications → create a Machine-to-Machine
  app → grant it the **Logto Management API access** role → copy its App ID + secret into
  `deploy/compose/.env` (`RELAY_LOGTO_M2M_APP_ID` / `_SECRET`). Then:

```bash
make seed-auth        # idempotent: ensures the Relay API resource + relay_admin/relay_member roles
```

- **Console sign-in app:** a Traditional web app with redirect URI `http://localhost:3000/callback`;
  its ID/secret go in `packages/console/.env.local`.
- **Read Logto state (its own DB):**

```bash
source deploy/compose/.env
PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -U postgres -d logto \
  -c "SELECT id, name, type FROM applications;"
```

### 5.4 MinIO (object store, used Week 4+)

- **Console:** `http://localhost:9001` — user/pass = `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` from `.env`.
- **S3 API:** `http://localhost:9000`.

### 5.5 mockllm (mock upstream)

Deterministic OpenAI + Anthropic emulation. Knobs: `MOCKLLM_LATENCY_MS`, `MOCKLLM_ERROR_RATE` (env);
`x-mock-error: <status>`, `x-mock-tokens: <n>` (per-request headers).

```bash
curl -s localhost:8080/healthz
curl -sN -X POST localhost:8080/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"gpt-4o","stream":true,"messages":[{"role":"user","content":"hi"}]}'
curl -s -X POST localhost:8080/v1/chat/completions -H 'content-type: application/json' \
  -H 'x-mock-error: 500' -d '{"model":"gpt-4o","messages":[]}'      # inject an error
```

### 5.6 Console

`http://localhost:3000` → "Sign in with Logto" → Logto sign-in page → back to `/callback` → signed in.

---

## 6. Testing the gateway APIs

Get a demo key first: `make seed-demo` writes it to `.relay/seed-demo.key` (gitignored) and prints a ready curl. Use `$(cat .relay/seed-demo.key)` as the key.

```bash
KEY=rk_live_...        # from seed-demo

# streaming chat completion (OpenAI-compatible SSE)
curl -sN http://localhost:3000/v1/chat/completions \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"gpt-4o","stream":true,"messages":[{"role":"user","content":"hello"}]}'

# non-streaming
curl -s http://localhost:3000/v1/chat/completions \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hello"}]}'

# model discovery
curl -s http://localhost:3000/v1/models
curl -s http://localhost:3000/v1/models/gpt-4o
```

### Swagger UI + OpenAPI

- **Swagger UI:** `http://localhost:3000/docs` — browse + try every endpoint interactively.
- **OpenAPI spec (JSON):** `http://localhost:3000/openapi.json`.
- **Regenerate the committed spec** after changing a route: `make generate` → `api/openapi/openapi.json`.

### Error responses (all OpenAI-compatible — see `errors.md`)

```bash
curl -s -X POST localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' -d '{"model":"gpt-4o","messages":[]}'      # 401 invalid_api_key
curl -s -X POST localhost:3000/v1/chat/completions \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"model":"gpt-4o"}'  # 400 invalid_request
curl -s localhost:3000/v1/models/nope                                            # 404 model_not_found
```

---

## 7. Endpoint reference

| Method | Path                   | Plane    | Auth       | Purpose                             |
| ------ | ---------------------- | -------- | ---------- | ----------------------------------- |
| POST   | `/v1/chat/completions` | data     | `rk_…` key | chat completion (stream/non-stream) |
| GET    | `/v1/models`           | data     | none       | list models                         |
| GET    | `/v1/models/:model`    | data     | none       | retrieve one model                  |
| GET    | `/docs`                | data     | none       | Swagger UI                          |
| GET    | `/openapi.json`        | data     | none       | OpenAPI 3.1 spec                    |
| GET    | `/healthz`             | internal | none       | liveness (`{status:ok}`)            |
| GET    | `/readyz`              | internal | none       | readiness (checks pg + valkey)      |
| GET    | `/metrics`             | internal | none       | Prometheus metrics                  |
| POST   | `/v1/chat/completions` | mockllm  | none       | mock OpenAI upstream                |
| POST   | `/v1/messages`         | mockllm  | none       | mock Anthropic upstream             |

---

## 8. Observability & metrics

```bash
curl -s localhost:9090/healthz     # liveness
curl -s localhost:9090/readyz      # {status, pg, valkey} — 503 if a dependency is down
curl -s localhost:9090/metrics | grep relay_
```

Headline metrics:

| Metric                            | Meaning                                                      |
| --------------------------------- | ------------------------------------------------------------ |
| `relay_gateway_overhead_seconds`  | gateway-added latency histogram (the **G3** gate reads this) |
| `relay_requests_total{...status}` | request counter by org/route/provider/status                 |
| `nodejs_eventloop_lag_seconds`    | hot-path health — spikes mean blocking on the event loop     |

Every response carries **`x-relay-trace-id`**; every log line carries `trace_id` (grep logs by it).
Run the G3 bench any time: `make bench` (drives load, fails if overhead p99 > 25ms).

---

## 9. Policies (enforced)

- **Tenancy/RLS:** every table with `org_id` has forced RLS + `tenant_isolation` + `platform_admin_access`;
  `scripts/check-rls.sh` gates it; the gateway scopes every query via `withTenant` (`SET LOCAL`).
- **Two-key model:** virtual keys stored as SHA-256 (+last4); provider credentials AES-256-GCM
  envelope-encrypted, write-only, decrypted only in worker memory. Plaintext never logged/stored.
- **Errors:** always `throw new RelayError('code', …)`; the central handler formats the envelope; unknown
  errors → safe 500, details logged not leaked (`errors.md`).
- **Migrations:** additive-only, advisory-locked, checksummed; edits to applied migrations are rejected.
- **SQL:** query text only in `*.queries.ts` (or documented ops scripts), always parametrized.
- **Supply chain:** `pnpm --frozen-lockfile`, no postinstall scripts by default; CI runs CodeQL, osv-scanner,
  gitleaks, Trivy. `pnpm audit --prod` clean.

---

## 10. Debugging playbook (symptom → cause → fix)

| Symptom                                                  | Likely cause → fix                                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `401 invalid_api_key`                                    | Missing/malformed `Authorization: Bearer rk_live_…`. Get a key from `make seed-demo`.          |
| `400 invalid_request`                                    | Body failed the route schema (needs `model` + `messages`). Check the request JSON.             |
| `404 model_not_found`                                    | Model not in `model_catalog`. Seeded in migration `0009`; check `GET /v1/models`.              |
| `404 not_found` (route)                                  | Wrong path/method. See §7 or `/docs`.                                                          |
| `502 upstream_error/unreachable`                         | mockllm down or erroring. Check `curl localhost:8080/healthz`; unset `MOCKLLM_ERROR_RATE`.     |
| psql as `relay_app` returns 0 rows                       | RLS — set `app.current_org` in the tx (§5.1) or use the superuser role.                        |
| `migration … modified after applied (checksum mismatch)` | You edited an applied migration. Revert it and **add a new** migration instead.                |
| `Database.get() before Database.init()`                  | Something used the DB singleton before `serve` called `initDb`. Boot via `relay serve`.        |
| Console sign-in loops / redirect error                   | `LOGTO_BASE_URL` + the Logto app's redirect URI must both be `http://localhost:3000/callback`. |
| `seed-demo needs RELAY_MASTER_KEY`                       | Set `RELAY_MASTER_KEY` (`openssl rand -base64 32`) in `.env`.                                  |
| `seed-auth skipped`                                      | `RELAY_LOGTO_*` not set — do the one-time M2M setup (§5.3).                                    |
| Port `3000` in use                                       | Console and gateway both want 3000 — run the gateway on another port (§2 note).                |
| `/readyz` 503                                            | pg or valkey down. `docker compose … ps`; check the `pg`/`valkey` fields in the response.      |

---

## 11. Make targets

```
make bootstrap   # check tools, .env, install, build shared
make up          # compose core + migrate + seed-auth + seed-demo
make dev         # up + mockllm + watch all packages
make down        # stop everything, drop volumes
make migrate     # apply SQL migrations (idempotent)
make seed-auth   # idempotent Logto bootstrap
make seed-demo   # seed a demo tenant, print a working curl + key
make generate    # dump api/openapi/openapi.json from route schemas
make lint        # eslint + prettier + dep-cruiser + check-rls
make test        # unit + integration (with a DB up)
make coverage    # coverage thresholds (business logic ≥ 80%)
make smoke       # end-to-end contract checks against a running stack
make bench       # G3 gate — gateway overhead p99 < 25ms
make load        # local hot-path load smoke (p50/p95/p99)
```
