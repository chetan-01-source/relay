# Relay Gateway — Threat Model (STRIDE)

Phase-1 threat model. Scope: the multi-tenant gateway (data + control planes), its datastores
(Postgres, Valkey, MinIO), and the console. A living document — revisit each STRIDE category when a
new surface ships. Trust boundary: **every tenant is mutually untrusted**; the platform admin is
trusted; upstream providers are semi-trusted (we forward to them but never trust their response body
for cost/identity).

## Assets

- Tenant data (apps, keys, usage, audit) — isolated per org.
- Secrets: virtual keys (hashed), provider credentials (envelope-encrypted), `RELAY_MASTER_KEY`.
- Availability of the data plane.

## STRIDE

| Category                   | Threat                                                       | Mitigation (in place)                                                                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **S**poofing               | Forged virtual key / JWT; one tenant acting as another       | Data plane: hashed virtual keys resolved to an org snapshot; control plane: Logto JWT verified (issuer + audience + scope). `org_id` is derived from the credential, never from client input.                                                                                        |
| **T**ampering              | Altered request routing; edited audit history; SQL injection | Audit trail is hash-chained — each row hashes `prev_hash` + `canonicalize(row)`; `relay audit verify` fails on any break. All SQL is a parametrized `SqlQuery` (no interpolation). Routes/targets are server-owned.                                                                  |
| **R**epudiation            | "I never made that change / call"                            | Every control-plane mutation appends an audit event (actor, action, target); every request is metered with a trace id; all logs carry `trace_id` + `org_id`.                                                                                                                         |
| **I**nformation disclosure | Cross-tenant read; leaked secrets                            | **Postgres RLS forced on every tenant table** (tenant_isolation + platform_admin_access), proven by the zero-tolerance isolation suite (G4). Provider secrets are write-only (never selected back); virtual keys shown once. Cache keys embed `org_id` so a hit can't cross tenants. |
| **D**enial of service      | Request floods; metering/cache growth; ReDoS                 | Per-IP coarse rate limit + per-key/org rate limits + budgets (atomic Valkey Lua). Metering is a **bounded** ring queue (drop-oldest, never grows). Cache writes are capped (tee-within-cap). Dependency ReDoS patched (brace-expansion).                                             |
| **E**levation of privilege | Member → admin; scope bypass                                 | Scopes enforced **server-side** in the gateway (`requireScope` → 403), not just hidden in the console UI; `platform:admin` is a distinct scope/role. Runtime connects as the non-superuser `relay_app` role, so even a SQL bug can't bypass RLS.                                     |

## Supply chain

- Multi-arch images are **Cosign keyless-signed** (GitHub OIDC, no stored keys) and ship SBOMs (SPDX +
  CycloneDX). CI gates on CodeQL, Trivy (fs + image), gitleaks, osv-scanner; installs are
  `--frozen-lockfile` with an `onlyBuiltDependencies` allowlist.

## Known gaps / non-goals (Phase 1)

- No WAF / bot management (deploy behind your own edge).
- Console sign-in delegates entirely to Logto — its hardening is out of scope here.
- Semantic cache, request replay, and per-route guardrails are Weeks-4+ (`docs/scope-cut-ledger.md`).
- Secrets rotation for `RELAY_MASTER_KEY` is manual (re-seal) in Phase 1.
