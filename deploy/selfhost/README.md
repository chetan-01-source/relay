# Relay Gateway — self-host bundle

Boots the signed, multi-arch Relay images from GHCR with Docker Compose. No build toolchain required.

## Prerequisites

- Docker + Docker Compose v2
- ~2 GB RAM free

## Boot

```bash
cp .env.example .env
# fill in the three secrets — generate strong values:
#   POSTGRES_PASSWORD / RELAY_APP_PASSWORD :  openssl rand -base64 24
#   RELAY_MASTER_KEY                       :  openssl rand -base64 32   (must be 32 bytes)
docker compose up -d
```

Compose applies migrations (`relay-migrate`, one-shot) before the gateway serves. Check readiness:

```bash
docker compose exec relay wget -qO- http://localhost:9090/readyz
# {"status":"ready","pg":true,"valkey":true,"warm":true,"version":"0.2.0"}
```

## First proxied call

Mint a demo tenant + virtual key, then call the OpenAI-compatible endpoint:

```bash
docker compose exec relay node dist/index.js seed-demo   # prints a rk_live_… key
curl http://localhost:3000/v1/chat/completions \
  -H "authorization: Bearer <key>" -H 'content-type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hello"}]}'
```

Configure a real upstream provider + credentials in the console, or set `RELAY_UPSTREAM_URL`.

## Console

`http://localhost:3100`. Sign-in needs Logto — see `docs/self-hosting.md`. The data plane (virtual
keys) works without it.

## Verify image signatures (Sigstore / keyless)

```bash
cosign verify ghcr.io/chetan-01-source/relay:<tag> \
  --certificate-identity-regexp 'https://github.com/chetan-01-source/relay/.github/workflows/release.yml@.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Upgrade

Bump the image tags in `.env` and `docker compose pull && docker compose up -d`. Migrations re-apply
idempotently on the next boot.

## Back up

`pg_dump` the `postgres` service (see the repo's `docs/runbooks/backup-restore.md`).
