# ADR 0010 — Analytics read model, audit read/verify, response-header contract, image manifest

Status: accepted (Week 3, Day 12).

## Context

Day 12 turns the value layer into something an operator can see and trust: grouped spend per
app/route/model, a browsable + machine-verifiable audit trail, a frozen response-header contract the
console and SDKs can rely on, and a safe path for inline image attachments. No new tables are needed —
`usage_rollups_hourly` and `audit_log` already exist (Weeks 1–2) with RLS + isolation-suite coverage.

## Decision

### `modules/analytics` — a read model over the hourly rollups (full-stack control plane)

`GET /api/v1/analytics/usage?group_by=app|route|model|day&format=json|csv` reads **only**
`usage_rollups_hourly` (never the raw `usage_events` partitions — non-negotiable #3). Org scoping is by
RLS: the service reads inside `withTenant(orgId, {isPlatformAdmin:false})`, mirroring how routing reads
tenant data. The `group_by` value is a typed enum validated against an allowlist at the controller
boundary; the enum→column mapping lives in `analytics.queries.ts` and is the **only** place a grouping
becomes SQL — a value outside the union cannot index the map, so `GROUP BY` can never be user text
(injection is structurally impossible). `from`/`to` are `$`-bound. CSV is rendered at the controller
from the bounded grouped aggregate (a single body, not unbounded streaming).

A **platform-admin cross-org summary** — `GET /api/v1/platform/analytics/usage`, guarded by
`platform:admin` (mirroring tenancy) — groups by `org_id` inside a platform-admin transaction (the
`platform_admin_access` RLS policy grants the cross-org read).

### `modules/audit` — read + verify finish the library

The Week-2 append-only, hash-chained trail gains its HTTP surface and CLI:

- `GET /api/v1/audit` (guarded `audit:read`) — a tenant-scoped, newest-first page with a `before` seq
  cursor and a service-clamped limit (≤200). `hash` is exposed as hex for transparency.
- `relay audit verify` — an operator CLI that re-walks **every** org's chain and exits non-zero on any
  break. The pure `verifyChain` lib recomputes each row's hash as
  `sha256(previous stored hash ‖ canonicalize(payload))`. Because `canonicalize` is idempotent, it
  reproduces the exact string that was hashed even though pg returns the `canonical_json` jsonb as a
  parsed object — so a tampered payload fails at its own row and a tampered hash fails at the next.

Interface segregation: the append side (`AuditRepository`) stays minimal so existing append-only
callers (apps/providers/tenancy) never fake the read methods; the read/verify side is a separate
`AuditReadRepository` consumed only by the service + CLI.

### Response-header contract (§4.2) — frozen

Every proxied response now guarantees, on all three paths (non-stream, stream, cache-hit):
`x-relay-trace-id`, `x-relay-provider`, `x-relay-cache`, `x-relay-failover` (always `true|false`),
`x-relay-cost-usd` (settled `usage × rate-card`, 6 dp — reusing the same math as the usage event), and
`x-relay-modalities` (`text`, plus `image` when a message carries an image part). `x-ratelimit-*` flow
from the policy decision. Streaming writes headers atomically before the body, so its `x-relay-cost-usd`
reflects only what is known at header time (usage usually arrives in the final chunk); the exact settled
cost always lands on the metered event + rollups. Documented in `docs/response-headers.md`, asserted in
`scripts/smoke.sh`.

### Inline image manifest (12d) — validate at ingress, don't re-key

`modules/proxy/lib/image-manifest.ts` (pure) validates every inline `data:` image at ingress: decode
base64, sniff the real type from magic bytes (PNG/JPEG/GIF/WEBP), reject a declared MIME that disagrees
with the content (anti-spoof), enforce a per-image size cap, and hash the bytes (sha256). Non-image
bytes smuggled as an image are rejected `400 invalid_request` before routing or the upstream. Remote
`http(s)` image URLs pass through untouched — the gateway never fetches them on the hot path. The
exact-cache key already folds each image URL/data-URI into the tenant-isolated key (ADR 0008), so this
module validates + manifests only; it does not re-key. Text-only requests short-circuit with no decode
work, so the hot-path bench is unaffected.

## Consequences

- **No migration, no new tables, no new error codes** — analytics validation reuses `invalid_request`.
  RLS + the G4 isolation suite already cover `usage_rollups_hourly` and `audit_log`.
- **No new env vars** — analytics/audit read the existing config.
- New scopes checked at the JWT boundary: `analytics:read`, `audit:read` (plus existing
  `platform:admin` for the cross-org summary), following the `apps:*` pattern.
- Dashboards (console, Day 13) consume `/api/v1/analytics/usage` and `/api/v1/audit` via the generated
  typed client; the header contract is stable enough to depend on.
