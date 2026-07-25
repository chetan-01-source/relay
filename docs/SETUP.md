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

## 2. First-time setup — zero → signed-in, step by step

> **Which URLs open in a browser?** Only these. `psql`/`redis` ports are **NOT web pages** — opening
> `http://localhost:5432` (Postgres) or `:6379` (Valkey) in a browser shows "this page isn't working";
> that is expected. Use the CLI for those (§5.1/§5.2).
>
> | Open in a browser                                            | Terminal only (not a web page)                 |
> | ------------------------------------------------------------ | ---------------------------------------------- |
> | Console `http://localhost:3100`                              | Postgres `5432` → `psql` (or the pgweb UI)     |
> | Swagger UI `http://localhost:3000/docs`                      | Valkey `6379` → `valkey-cli` (or the UI below) |
> | Logto admin `http://localhost:3002`                          | mockllm `8080` → `curl` (API, no UI)           |
> | MinIO console `http://localhost:9001`                        | Gateway data `3000` / internal `9090` → `curl` |
> | **DB browser (pgweb) `http://localhost:8081`**               | —                                              |
> | **Valkey browser (redis-commander) `http://localhost:8082`** | —                                              |
>
> **Want to see the data?** Two web UIs come up with `make up` / `make dev`:
> **`http://localhost:8081`** (pgweb) for the Postgres `relay` DB (§5.7), and
> **`http://localhost:8082`** (redis-commander) for Valkey — cache + rate-limit + pub/sub keys (§5.8).

### Step 1 — install + infra

```bash
make bootstrap        # checks tools, copies deploy/compose/.env.example → .env, installs, builds shared types
```

Fill **server secrets** in `deploy/compose/.env` (gitignored — never commit):

```bash
# strong local values for the datastores:
#   POSTGRES_PASSWORD · RELAY_APP_PASSWORD · MINIO_ROOT_PASSWORD  → any strong string
# the envelope key (REQUIRED — crypto/seed fail without it):
openssl rand -base64 32        # paste as RELAY_MASTER_KEY
```

Bring up the datastores + schema + a demo tenant:

```bash
make up               # compose core (pg/valkey/logto/minio) + migrate + seed-auth + seed-demo
#   → seed-demo writes a data-plane key to .relay/seed-demo.key (gitignored) and prints a ready curl.
```

At this point the **data plane works** (§6) but the **console needs Logto credentials** (Steps 2–3).

### Step 2 — Logto: admin + the M2M app (for `seed-auth`)

`seed-auth` needs a Machine-to-Machine app so the gateway can register its API resource + roles.

1. Open the **Logto admin console → `http://localhost:3002`**. First run: create the admin account.
2. **Applications → Create → Machine-to-Machine** (name it `relay-server`). Open it →
   **Roles/API permissions → grant "Logto Management API access"**.
3. Copy its **App ID** and **App Secret** into `deploy/compose/.env`:

   ```
   RELAY_LOGTO_ENDPOINT=http://localhost:3001
   RELAY_LOGTO_M2M_APP_ID=<the m2m app id>
   RELAY_LOGTO_M2M_APP_SECRET=<the m2m app secret>
   ```

4. Register the Relay API resource + roles (idempotent):

   ```bash
   make seed-auth      # → "logto bootstrap ok — apiResource …"; creates the https://relay.gateway/api resource
   ```

   > `RELAY_LOGTO_JWT_AUDIENCE` defaults to `https://relay.gateway/api` (the resource indicator
   > `seed-auth` registers) — leave it unset unless you change the indicator.

### Step 3 — Logto: the console sign-in app + `.env.local`

The console signs users in with a **Traditional web app**.

1. **Applications → Create → Traditional Web** (name it `relay-console`). In its settings set:
   - **Redirect URI:** `http://localhost:3100/callback`
   - **Post sign-out redirect URI:** `http://localhost:3100`
2. Create the console env file and fill it from that app:

   ```bash
   cp packages/console/.env.example packages/console/.env.local
   openssl rand -base64 24     # paste as LOGTO_COOKIE_SECRET
   ```

   ```ini
   # packages/console/.env.local
   LOGTO_ENDPOINT=http://localhost:3001
   LOGTO_APP_ID=<the traditional web app id>
   LOGTO_APP_SECRET=<the traditional web app secret>
   LOGTO_BASE_URL=http://localhost:3100
   LOGTO_COOKIE_SECRET=<openssl rand -base64 24>
   RELAY_API_BASE_URL=http://localhost:3000       # gateway control plane
   RELAY_API_RESOURCE=https://relay.gateway/api    # MUST equal the server's RELAY_LOGTO_JWT_AUDIENCE
   ```

### Step 4 — run it + sign in

```bash
make dev              # core + mockllm container + turbo watch (server + console)
#   gateway → :3000 (data) + :9090 (internal) · console → :3100 · mockllm → :8080
```

Open **`http://localhost:3100`** → **Sign in with Logto** → authenticate → back to the console.

- First sign-in gives you a **Logto user**. To act on an org you need to be a member of one. Grant your
  user the **`relay_admin`** role in Logto (Users → your user → Roles), sign in again, then
  **Manage organizations → onboard an org** — that maps your Logto org to a Relay tenant. Now
  **Open console** shows the dashboard / apps / keys / providers / audit.

> **Port note (dev):** `make dev` starts the mockllm **container** and runs `turbo dev` for
> **server + console only** (mockllm is excluded from the watch, or the container and the tsx dev
> server would both bind `:8080`). The console's Logto redirect URI must be
> `http://localhost:3100/callback`.
>
> **Env note (dev):** turbo 2.x runs tasks in **strict env mode** — `make dev` sources
> `deploy/compose/.env` and turbo forwards `RELAY_*` / `LOGTO_*` to the tasks via
> `globalPassThroughEnv` (`turbo.json`). Running the gateway outside `make dev` needs those vars
> exported (`source deploy/compose/.env`) or `loadConfig` throws `Invalid configuration: RELAY_DATABASE_URL …`.

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

| Var                                 | Purpose                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `LOGTO_ENDPOINT`                    | Logto OIDC endpoint (`http://localhost:3001`)                                                                                        |
| `LOGTO_APP_ID` / `LOGTO_APP_SECRET` | the console's **Traditional web app** in Logto (§5.3)                                                                                |
| `LOGTO_BASE_URL`                    | console origin (`http://localhost:3100`); redirect URI = `+/callback`                                                                |
| `LOGTO_COOKIE_SECRET`               | session cookie secret (`openssl rand -base64 24`)                                                                                    |
| `RELAY_API_BASE_URL`                | where the gateway control plane lives (`http://localhost:3000`)                                                                      |
| `RELAY_API_RESOURCE`                | Relay API resource the access token is minted for — must equal the server's `RELAY_LOGTO_JWT_AUDIENCE` (`https://relay.gateway/api`) |

> **Secrets policy:** only `*.env.example` is committed; `.env` / `.env.local` are gitignored. The DB
> stores hashes (virtual keys) and envelope-encrypted ciphertext (provider credentials) only. Logs
> redact `authorization`, `*.apiKey`, `*.secret` (pino). `RELAY_MASTER_KEY` is never logged.

---

## 4. Tools & services — ports, purpose, access

| Service         | Port(s)     | Purpose                    | Access                                 |
| --------------- | ----------- | -------------------------- | -------------------------------------- |
| Postgres        | 5432        | tenant data (RLS)          | `psql` — §5.1                          |
| Valkey          | 6379        | limits · cache · pub/sub   | `valkey-cli` / `redis-cli` — §5.2      |
| Logto           | 3001 / 3002 | OIDC endpoint / admin UI   | browser `http://localhost:3002` — §5.3 |
| MinIO           | 9000 / 9001 | S3 API / web console       | browser `http://localhost:9001` — §5.4 |
| mockllm         | 8080        | mock upstream provider     | `curl` — §5.5                          |
| Gateway         | 3000        | data plane `/v1/*`         | `curl` / SDK — §6                      |
| Gateway         | 9090        | internal: health · metrics | `curl` — §7                            |
| Console         | 3100        | dashboard + Logto sign-in  | browser `http://localhost:3100` — §5.6 |
| pgweb           | 8081        | web DB browser (relay DB)  | browser `http://localhost:8081` — §5.7 |
| redis-commander | 8082        | web Valkey browser         | browser `http://localhost:8082` — §5.8 |

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

Prefer the **web UI at `http://localhost:8082`** (redis-commander) to browse keys visually — see §5.8
for what each key means. CLI access:

```bash
docker exec -it relay-valkey-1 valkey-cli      # or: redis-cli -h localhost -p 6379
> PING            # PONG
> KEYS *          # cache (c:*), rate-limit buckets (b:*), budgets (budget:*)
> TTL c:...       # remaining cache TTL
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

- **Console sign-in app:** a Traditional web app with redirect URI `http://localhost:3100/callback`;
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

`http://localhost:3100` → "Sign in with Logto" → Logto sign-in → `/callback` → landing. From there:

- **Org members** land on **Open console → `/dashboard`**: spend/usage tiles + a setup checklist, plus
  **Applications** (create), **Virtual keys** (create with one-time copy, rotate, revoke), **Providers**
  (write-only secret forms), and **Audit** (the hash-chained trail). Every key surface has a
  **cURL / SDK snippet drawer**. This is the whole onboarding → build → operate flow with no cURL.
- **Platform admins** additionally get **Manage organizations → `/orgs`** (onboard + entitlements).

All screens are server-rendered and **gated server-side** (`app/lib/auth.ts`): an unauthenticated or
un-scoped visitor is redirected before any protected markup renders; the gateway still enforces scopes
on every call. Data flows through the generated typed client (`app/lib/api-types.ts`, refreshed by
`make generate`) — so the console never drifts from the server contract.

> If a signed-in user sees "token could not be resolved by the gateway", their Logto token lacks the
> Relay API audience/scope — check `RELAY_API_RESOURCE` (console) == `RELAY_LOGTO_JWT_AUDIENCE`
> (server) and that `make seed-auth` granted the role.

### 5.7 pgweb — visualize the database

`http://localhost:8081` — a web DB browser that **auto-connects to the `relay` DB as the superuser**
(no login). Browse tables, run queries, inspect rows and relationships. Because it connects as
`postgres`, **RLS is bypassed** — you see every tenant's rows (ideal for inspection; not what the
gateway sees at runtime). It starts with `make up` / `make dev` (core profile) and is bound to
`127.0.0.1` only — it exposes the DB with no auth, so never expose port 8081 off your machine.

To point it at the `logto` DB instead, use the connection form (top-left "Connect") with:
`postgres` / `<POSTGRES_PASSWORD>` / host `postgres` / db `logto`. Prefer a desktop client
(TablePlus/DBeaver) for heavier work — connection params in §5.1.

### 5.8 redis-commander — visualize Valkey

`http://localhost:8082` — a web browser for **Valkey** (Redis-compatible). Auto-connects (no login),
starts with `make up` / `make dev`, bound to `127.0.0.1` only. Expand the `local` connection to see
every key live; click a key to view its value/TTL.

**What Relay stores in Valkey (so the keys make sense):**

| Key pattern             | What it is                                                                        | Written by    |
| ----------------------- | --------------------------------------------------------------------------------- | ------------- |
| `c:{org}:{sha256}`      | exact-match **response cache** entry (org-partitioned; TTL = `RELAY_CACHE_TTL_S`) | cache module  |
| `b:{org}:rpm:{keyId}`   | **requests-per-minute** token bucket for a virtual key                            | policy (Lua)  |
| `b:{org}:tpm:{keyId}`   | **tokens-per-minute** bucket                                                      | policy (Lua)  |
| `budget:{org}:{period}` | rolling **spend** counter (daily/monthly)                                         | policy settle |

Plus two **pub/sub channels** (not keys — watch them under the "Pub/Sub" area or `SUBSCRIBE`):
`key.invalidate` (a key was rotated/revoked) and `org.suspend` (a tenant was suspended) — the data
plane subscribes so its in-process snapshots stay correct.

> **See it live:** open redis-commander, then make a chat request (§6) twice — the second is a cache
> hit and you'll see a `c:…` key appear; a rate-limited burst grows the `b:…` buckets. Empty at rest
> (TTL 0 disables the cache). CLI equivalent: `docker exec -it relay-valkey-1 valkey-cli KEYS '*'`.

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

**Control plane (`/api/*`, on the gateway `:3000`)** — auth is a **Logto JWT** (not a `rk_` key), scoped
to the Relay API resource. These are what the console consumes; browse them in `/docs` too.

| Method   | Path                                      | Scope                  | Purpose                                     |
| -------- | ----------------------------------------- | ---------------------- | ------------------------------------------- |
| GET      | `/api/v1/me`                              | any                    | caller's org + scopes                       |
| GET/POST | `/api/v1/apps`                            | `apps:read/write`      | list / create applications                  |
| GET/POST | `/api/v1/apps/{appId}/keys`               | `apps:read/write`      | list / issue virtual keys (plaintext once)  |
| POST     | `/api/v1/keys/{keyId}/rotate` · `/revoke` | `apps:write`           | rotate / revoke a key                       |
| GET/POST | `/api/v1/providers`                       | `providers:read/write` | list (metadata) / store a sealed credential |
| DELETE   | `/api/v1/providers/{id}`                  | `providers:write`      | delete a credential                         |
| GET      | `/api/v1/analytics/usage`                 | `analytics:read`       | grouped spend (rollups)                     |
| GET      | `/api/v1/audit`                           | `audit:read`           | hash-chained audit trail                    |
| GET/POST | `/api/v1/platform/orgs` (+ `/{orgId}/…`)  | `platform:admin`       | org lifecycle + entitlements                |
| GET      | `/api/v1/platform/analytics/usage`        | `platform:admin`       | cross-org spend summary                     |

Verify the trail integrity any time: `relay audit verify` (re-walks every org's hash chain, exits 1 on a break).

---

## 8. Observability & metrics

```bash
curl -s localhost:9090/healthz     # liveness
curl -s localhost:9090/readyz      # {status, pg, valkey} — 503 if a dependency is down
curl -s localhost:9090/metrics | grep relay_
```

Headline metrics:

| Metric                            | Meaning                                                                                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relay_gateway_overhead_seconds`  | **gateway-only** latency histogram — full in-gateway time (request in + response out) **minus** time awaiting the external provider. The **G3** gate reads this. |
| `relay_requests_total{...status}` | request counter by org/route/provider/status                                                                                                                     |
| `nodejs_eventloop_lag_seconds`    | hot-path health — spikes mean blocking on the event loop                                                                                                         |

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

| Symptom                                                          | Likely cause → fix                                                                                                                                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `401 invalid_api_key`                                            | Missing/malformed `Authorization: Bearer rk_live_…`. Get a key from `make seed-demo`.                                                                                          |
| `400 invalid_request`                                            | Body failed the route schema (needs `model` + `messages`). Check the request JSON.                                                                                             |
| `404 model_not_found`                                            | Model not in `model_catalog`. Seeded in migration `0009`; check `GET /v1/models`.                                                                                              |
| `404 not_found` (route)                                          | Wrong path/method. See §7 or `/docs`.                                                                                                                                          |
| `502 upstream_error/unreachable`                                 | mockllm down or erroring. Check `curl localhost:8080/healthz`; unset `MOCKLLM_ERROR_RATE`.                                                                                     |
| psql as `relay_app` returns 0 rows                               | RLS — set `app.current_org` in the tx (§5.1) or use the superuser role.                                                                                                        |
| `migration … modified after applied (checksum mismatch)`         | You edited an applied migration. Revert it and **add a new** migration instead.                                                                                                |
| `Database.get() before Database.init()`                          | Something used the DB singleton before `serve` called `initDb`. Boot via `relay serve`.                                                                                        |
| Console sign-in loops / redirect error                           | `LOGTO_BASE_URL` + the Logto app's redirect URI must both be `http://localhost:3100/callback`.                                                                                 |
| Console "token could not be resolved by the gateway"             | `RELAY_API_RESOURCE` (console) ≠ `RELAY_LOGTO_JWT_AUDIENCE` (server), or the role wasn't granted — re-check §5.3 / `make seed-auth`.                                           |
| `seed-demo needs RELAY_MASTER_KEY`                               | Set `RELAY_MASTER_KEY` (`openssl rand -base64 32`) in `.env`.                                                                                                                  |
| `seed-auth skipped`                                              | `RELAY_LOGTO_*` not set — do the one-time M2M setup (§5.3).                                                                                                                    |
| Gateway boots with `Invalid configuration: RELAY_DATABASE_URL …` | Env didn't reach the task. `make dev` forwards it via `globalPassThroughEnv` (turbo.json); running the gateway by hand needs the vars exported (`source deploy/compose/.env`). |
| mockllm `EADDRINUSE :8080`                                       | Two mockllm instances. `make dev` runs the container only; kill a stale host mockllm (`lsof -ti :8080 \| xargs kill`) or a leftover container (`docker compose … stop`).       |
| Port `3000` / `3100` / `8080` in use                             | A stale gateway/console/mockllm from a prior run. `docker compose … stop` (containers) and `lsof -ti :3000 :3100 :8080 \| xargs kill` (host processes).                        |
| `/readyz` 503                                                    | pg or valkey down. `docker compose … ps`; check the `pg`/`valkey` fields in the response.                                                                                      |

---

## 11. Make targets

```
make bootstrap   # check tools, .env, install, build shared
make up          # compose core + migrate + seed-auth + seed-demo
make dev         # up + mockllm container + turbo watch (server + console)
make down        # stop everything, drop volumes
make migrate     # apply SQL migrations (idempotent)
make seed-auth   # idempotent Logto bootstrap
make seed-demo   # seed a demo tenant, print a working curl + key
make generate    # dump api/openapi/openapi.json + regen the console's typed client
make lint        # eslint + prettier + dep-cruiser + check-rls
make test        # unit + integration (with a DB up)
make coverage    # coverage thresholds (business logic ≥ 80%)
make smoke       # end-to-end contract checks against a running stack
make e2e         # Playwright console E2E (installs chromium; needs make dev up)
make bench       # G3 gate — gateway overhead p99 < 25ms
make load        # local hot-path load smoke (p50/p95/p99)
```

> **Console E2E:** `make e2e` runs the Playwright specs (`packages/console/test/e2e/`). The **gating**
> specs (unauthenticated → redirected off every protected route) run against a live `make dev` with no
> extra setup. The full **build-flow** spec self-skips unless you supply an authenticated Logto session
> via `RELAY_E2E_STORAGE_STATE` (a saved `storageState` file). Unit tests (`pnpm --filter @relay/console
test`) cover the pure logic (usage aggregation, checklist, snippet builder) and need no stack.

---

## 12. Reset to a clean slate

Two levels of reset. **Data reset** (recommended) wipes all tenant data but keeps Logto (admin user,
M2M app, console app) so sign-in still works. **Full nuke** also destroys Logto — only for a truly
fresh machine; you must redo the one-time Logto setup (§5.3) afterward.

### 12.1 Data reset — wipe tenant data, keep auth

```bash
source deploy/compose/.env

# Valkey: rate-limit buckets + cache + pub/sub
docker exec relay-valkey-1 valkey-cli FLUSHALL

# Postgres: all tenant rows (keeps schema, migrations, global model_catalog + rate_cards)
PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -U postgres -d relay -v ON_ERROR_STOP=1 -c \
  "TRUNCATE organizations CASCADE; TRUNCATE usage_events;"

# forget the old demo key, then re-seed a fresh demo tenant
rm -f .relay/seed-demo.key
make seed-demo
```

`TRUNCATE organizations CASCADE` removes every tenant table's rows via the `org_id` FK cascade;
`usage_events` has no FK so it is truncated explicitly. MinIO is empty until Week 4 (nothing to clear).

### 12.2 Full nuke — destroy everything incl. Logto

```bash
make down                                    # stop containers
docker compose -f deploy/compose/compose.yaml --profile core --profile dev down -v   # drop volumes
make up                                      # fresh migrate + seed
# then redo §5.3: create the Logto admin user, the M2M app, and the console web app.
```
