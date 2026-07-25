# Relay Gateway — Self-Hosting Guide

Run Relay from the signed, multi-arch GHCR images. The `relay-selfhost.tar.gz` bundle (attached to
each release) is the fastest path; this guide covers configuration, Logto sign-in, upgrades, and
verification.

## 1. Boot the bundle

```bash
tar -xzf relay-selfhost.tar.gz && cd relay-selfhost
cp .env.example .env
```

Set the three required secrets (generate strong values):

| Var                  | Generate                  | Purpose                                                                                                    |
| -------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`  | `openssl rand -base64 24` | Postgres superuser                                                                                         |
| `RELAY_APP_PASSWORD` | `openssl rand -base64 24` | the non-superuser `relay_app` role RLS binds to                                                            |
| `RELAY_MASTER_KEY`   | `openssl rand -base64 32` | envelope-encryption KEK (must be 32 bytes) — **losing it makes sealed provider credentials unrecoverable** |

```bash
docker compose up -d
docker compose exec relay wget -qO- http://localhost:9090/readyz   # status:ready, warm:true
```

`relay-migrate` applies the SQL migrations (idempotent) before the gateway serves.

## 2. First proxied call

```bash
docker compose exec relay node dist/index.js seed-demo   # prints a rk_live_… key + a curl
```

Point any OpenAI client at `http://localhost:3000/v1` with that key. Configure a real upstream via the
console (provider credentials, sealed at rest) or `RELAY_UPSTREAM_URL` as the fallback.

## 3. Console sign-in (Logto)

The **data plane works with virtual keys alone** — Logto is only for the console. To enable it:

1. Stand up Logto (the dev compose runs `svhd/logto`; in production use your own instance).
2. Create a **Machine-to-Machine** app (grant "Logto Management API access") → set
   `RELAY_LOGTO_M2M_APP_ID` / `_SECRET` on the gateway; run `relay seed-auth` to create the API
   resource + roles + scopes.
3. Create a **traditional web** app for the console → set `LOGTO_ENDPOINT`, `LOGTO_APP_ID`,
   `LOGTO_APP_SECRET`, `LOGTO_COOKIE_SECRET` (`openssl rand -base64 32`), `LOGTO_BASE_URL` in `.env`.
4. `RELAY_API_RESOURCE` **must equal** the gateway's `RELAY_LOGTO_JWT_AUDIENCE`.

## 4. Production notes

- **TLS / ingress**: terminate TLS at your reverse proxy; expose only `3000` (data) and `3100`
  (console). Keep `9090` (health/metrics) internal.
- **Readiness**: orchestrators should gate on `GET :9090/readyz` (pg + valkey + warm). Liveness =
  `/healthz`. Graceful shutdown drains in-flight requests within `RELAY_SHUTDOWN_TIMEOUT_MS`.
- **Backups**: schedule `pg_dump` — see `docs/runbooks/backup-restore.md`. The dump carries hashed
  keys + sealed credentials as-is; guard `RELAY_MASTER_KEY` separately.
- **Scaling**: the gateway is stateless (state lives in Postgres + Valkey) — run N replicas behind a
  load balancer; snapshot invalidation propagates over Valkey pub/sub in ≤1s.

## 5. Verify the images are authentic (Sigstore keyless)

```bash
cosign verify ghcr.io/chetan-01-source/relay:<tag> \
  --certificate-identity-regexp 'https://github.com/chetan-01-source/relay/.github/workflows/release.yml@.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

SBOMs (SPDX + CycloneDX) for both images are attached to every release.

## 6. Upgrade

Bump the image tags in `.env`, then `docker compose pull && docker compose up -d`. Migrations
re-apply idempotently; additive-only, so a rollback to the previous tag is safe.
