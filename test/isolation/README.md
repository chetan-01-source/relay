# Isolation suite (G4 — the security spine)

Zero cross-tenant reads, proven dynamically. This is the runtime counterpart to the static
`scripts/check-rls.sh` gate: check-rls proves every tenant table _has_ RLS + both policies; this suite
proves those policies actually _isolate_ — org A can read none of org B's rows, for every role.

## Where the probes live

The dynamic probes run inside the server's Vitest suite so they execute on every `make test` with a
database (and in CI), sharing the platform's `initDb`/`withTenant` without cross-package import hacks:

    packages/server/src/isolation/cross-tenant.integration.test.ts

This directory is the documented index; add scenario notes / fixtures here as the matrix grows
(Day 10 fills it to green: every role × endpoint × foreign org).

## Running it

RLS does **not** apply to superusers, so the probe MUST connect as the non-superuser `relay_app`
role. It self-skips unless a real relay_app URL is supplied:

```bash
make up   # brings up postgres + migrations + seed
RELAY_ISOLATION_APP_URL="postgres://relay_app:<pw>@localhost:5432/relay" \
RELAY_MIGRATION_DATABASE_URL="postgres://postgres:<pw>@localhost:5432/relay" \
RELAY_MASTER_KEY="$(grep ^RELAY_MASTER_KEY deploy/compose/.env | cut -d= -f2)" \
  pnpm --filter @relay/server test cross-tenant
```

- `RELAY_ISOLATION_APP_URL` — the `relay_app` role (RLS applies). The probe reads through it.
- `RELAY_MIGRATION_DATABASE_URL` — the `postgres` superuser. Seeds the two throwaway orgs.

Any cross-tenant read that returns a row **fails the build** — there is no tolerance threshold.
