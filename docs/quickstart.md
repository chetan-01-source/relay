# Relay Gateway — Quickstart

**Goal: `git clone` → a real proxied completion in under 15 minutes.** Two paths — from source (dev)
or from the signed self-host bundle (no toolchain).

## Path A — from source (contributors)

```bash
git clone https://github.com/chetan-01-source/relay && cd relay
make bootstrap          # checks tools, copies .env, installs, builds shared types
make dev                # postgres + valkey + logto + minio + mockllm, migrates, seeds a demo tenant
```

`make dev` (via `make up`) seeds a demo org + app + route + virtual key and writes the key to
`.relay/seed-demo.key`. Make the first call against the local mock upstream:

```bash
curl -N http://localhost:3000/v1/chat/completions \
  -H "authorization: Bearer $(cat .relay/seed-demo.key)" \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o","stream":true,"messages":[{"role":"user","content":"hello"}]}'
```

- Data plane: `http://localhost:3000` · Console: `http://localhost:3100` · Swagger: `/docs`
- Health: `http://localhost:9090/readyz` · Metrics: `/metrics`

## Path B — self-host the release (operators)

Download `relay-selfhost.tar.gz` from the [latest release](https://github.com/chetan-01-source/relay/releases),
then:

```bash
tar -xzf relay-selfhost.tar.gz && cd relay-selfhost
cp .env.example .env      # set POSTGRES_PASSWORD, RELAY_APP_PASSWORD, RELAY_MASTER_KEY
docker compose up -d      # boots the signed GHCR images; migrations run first
docker compose exec relay node dist/index.js seed-demo   # prints a rk_live_… key
```

Full details + signature verification: `docs/self-hosting.md` and the bundle's own `README.md`.

## What you just ran

An OpenAI-compatible gateway: virtual-key auth, per-app routing + failover, rate limits + budgets,
exact-response cache, priced usage metering, and a hash-chained audit trail — all tenant-isolated by
Postgres RLS. Point the OpenAI SDK at `http://localhost:3000/v1` with your virtual key and it just
works (see `test/conformance/`).

## Next

- **Console**: onboard an org, create an app + key, add a provider credential, edit a route.
- **Errors**: every failure follows one envelope — `docs/errors.md`.
- **Operate**: `docs/runbooks/backup-restore.md`, the System Status page, `/metrics`.
- **Security model**: `docs/threat-model.md`.
