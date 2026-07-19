# ADR 0002 — Two auth planes: virtual key (data) + Logto JWT (control)

Status: accepted (Week 2, Day 6).

## Context

The gateway serves two audiences: LLM clients hitting the OpenAI-compatible data plane, and console
users/operators managing tenants. They authenticate differently and must not be conflated.

## Decision

Two planes, two credentials, one shared tenant-context step — implemented as Fastify **preHandlers**
exported by the identity module (its public surface). `app.ts` attaches them per route group.

| Plane   | Path     | Credential                           | preHandler                   |
| ------- | -------- | ------------------------------------ | ---------------------------- |
| Data    | `/v1/*`  | virtual key `rk_<env>_<id>.<secret>` | `authVirtualKey`             |
| Control | `/api/*` | Logto JWT (Bearer)                   | `authJwt` (+ `requireScope`) |

- **JWT verification** (`jose`): JWKS fetched + cached from `${endpoint}/oidc/jwks`; checks
  signature + `iss` + `aud` (the Relay API resource indicator) + `exp`/`nbf` with a **±60s** clock
  tolerance. Claims extracted: `{ userId, orgId, scopes, isPlatformAdmin }`.
- Both preHandlers resolve the tenant and bind the ALS context (`enterContext`), so every log line,
  `withTenant` call, and metric downstream carries `org_id` / `trace_id` without threading.

## Status-code contract

- **401** = missing or bad credential (no token, malformed key, bad signature, expired JWT, unknown
  or forged virtual key, **revoked key** — the credential itself is no longer valid).
- **403** = a valid credential that is not authorized (**insufficient scope**, **suspended org**).

## Consequences

- Different failure semantics are explicit and testable; SDKs get the right OpenAI-style envelope
  (`invalid_api_key`, `key_revoked`, `insufficient_scope`, `org_suspended`).
- When `RELAY_LOGTO_ENDPOINT` is unset the control plane cannot verify a JWT and rejects every
  `/api/*` call with 401 — the data plane is unaffected.
- `requireScope(...)` is a composable gate; platform admins bypass scope checks.
