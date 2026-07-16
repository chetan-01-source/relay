# Contributing to Relay Gateway

## Workflow

Two protected branches: **`dev`** (default, integration) and **`main`** (release). No direct pushes to either.

```
feature/* ──PR──▶ dev ──PR──▶ main
```

1. Branch off `dev`: `git checkout -b <type>/<short-desc>` (e.g. `feat/routing-failover`).
2. Make the change with tests + docs (see Definition of Done below).
3. Push and open a PR **into `dev`**. CI + security must be green.
4. Squash-merge. The squash title becomes the changelog entry, so it **must** be a
   [Conventional Commit](https://www.conventionalcommits.org/): `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `ci:`.
5. The **feature** branch auto-deletes on merge. `dev` and `main` are never deleted.
6. **Release:** promote `dev` → `main` via a separate PR (CI + security re-run). `dev` is **not** deleted after promotion.

## Definition of Done (a PR is done when it has)

- [ ] Code + tests (unit; integration if it touches Postgres/Valkey)
- [ ] Docs updated if user-facing (`/docs`)
- [ ] Telemetry: any new failure mode emits a metric/log
- [ ] Audit events for state mutations
- [ ] Isolation impact considered: a new tenant table ships its RLS policies + an isolation test
- [ ] Error codes added to the catalog
- [ ] OpenAPI diff attached if the public API changed
- [ ] Reviewed + CI green

## Conventions

- **Module boundaries** are enforced by `dependency-cruiser`: only `modules/*/index.ts` is cross-importable; `platform/` never imports `modules/`.
- **Contracts first**: Zod schemas in `@relay/shared` are the single source of truth (types + runtime validation + generated OpenAPI).
- **No `TODO`** without a linked issue.
- **Feature flags** for risky merges (config-driven, not env forks).
- **No secrets in commits** — push protection + gitleaks will block them.

## Local setup

See `llm/docs/Relay-Gateway-Week-0-Setup-Guide.pdf` for the full Week-0 machine + repo bootstrap.
