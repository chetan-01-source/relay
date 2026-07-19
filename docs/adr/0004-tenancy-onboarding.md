# ADR 0004 — Tenancy: org onboarding saga, entitlements, audit

Status: accepted (Week 2, Day 7).

## Context

A platform admin must be able to onboard a tenant end-to-end: create the identity-provider org
(Logto), the local `organizations` row, a starting set of entitlements, and an admin invite — then
suspend/reactivate tenants and edit their entitlements. Two facts constrain the design:

1. `organizations.logto_org_id` is `NOT NULL UNIQUE`, so the Logto org must exist **before** the row.
2. The data plane authorizes requests from an in-process snapshot (ADR 0003), so a suspend or an
   entitlement change must propagate to every worker within ≤1s.

## Decision

A `tenancy` module (platform control plane, `/api/v1/platform/orgs/*`, guarded by `authJwt` +
`requireScope('platform:admin')`). Its service orchestrates four collaborators and touches no SQL or
HTTP itself: **Logto** (org + invite), **Postgres** via `withTenant`, the **audit** trail, and the
**snapshot bus**.

- **Onboarding is a saga with compensation.** Create the Logto org first (it yields the required
  `logto_org_id`), then run one DB transaction that writes the org + template entitlements + an
  `org.create` audit row atomically. If the DB step fails, delete the just-created Logto org so a
  failed onboard leaves nothing behind. A duplicate (`unique_violation`) maps to `409 conflict`.
- **Onboarding state machine** (migration 0011 column + `lib/onboarding.ts`): strictly linear
  `created → admin_invited → provider_added → first_request`, advanced one step at a time; each hop
  is an audit event. A successful admin invite advances `created → admin_invited`.
- **Entitlement templates** (`default` / `trial` / `internal`, `lib/entitlements.ts`) seed
  `org_features` at onboarding. Edits upsert the flags and publish `org.features.updated`.
- **Suspend/unsuspend** flips `organizations.status` and publishes `org.suspend`, so cached snapshots
  drop and the data plane returns `403 org_suspended` (or resumes) within ≤1s.
- **Every mutation is an audit event.** A reusable `audit` module appends hash-chained rows
  (`hash = sha256(prev_hash || canonical_json)`, per-org sequence, advisory-locked) inside the
  caller's transaction — the audit row and the change commit together or not at all.

## Consequences

- Cross-org writes run as a platform admin scoped to the NIL org id; the `platform_admin_access`
  policies grant the write. RLS still isolates every non-admin read (proved by the isolation suite).
- Logto stays behind `platform/logto.ts` (ADR-7): the service depends on a `LogtoOrgSync` interface
  and is unit-tested with a fake. Without M2M creds configured, onboarding returns `503`.
- The audit module ships now as a library (no endpoints); its read/verify surface + `relay audit
verify` CLI arrive in Day 12, reading the same chain.
