# ADR 0011 — Console P0: SSR build/operate vertical, server-side gating, generated client

Status: accepted (Week 3, Day 13).

## Context

The gateway's control plane (Weeks 1–2, Days 11–12) is complete but only reachable by cURL. Day 13
makes the **onboarding → build → operate** flow doable from a UI with **no new backend** — the console
consumes the existing endpoints via the generated typed client. The console was greenfield beyond the
Week-2 platform-admin org slice: no design system, no auth-gate helper, no tests.

## Decision

### Scope (this PR): the Org "Build + Overview" vertical

App shell + nav, **Applications** (list/create), **Virtual keys** (create with one-time copy, rotate,
revoke), **Providers** (write-only secret forms + delete), **Dashboard** (spend/requests/tokens +
top-model, from `/analytics/usage`), a self-completing **setup checklist**, an **Audit** viewer, and a
**cURL/SDK snippet drawer** on the key surfaces. Deferred (no backend to consume, and Day-13's rule is
"no new backend"): routes editor, live-traffic SSE table, trace detail. Platform-admin org detail /
cross-org dashboard are out of this PR's scope.

### Server-side authorization, not hidden UI

Every gated page calls a server-side gate (`app/lib/auth.ts`: `requireUser` / `requireOrg` /
`requireAdmin`) in its React Server Component. The gate reads the Logto session **and** the gateway's
own `GET /api/v1/me` (org_id, scopes, is_platform_admin) and `redirect()`s an unauthorized visitor
before any protected markup renders — proven by the `gating.spec.ts` E2E (every protected route
redirects unauthenticated). Fine-grained enforcement still lives in the gateway (it 403s a token
missing a scope); the console gate is the redirect layer, not the source of truth.

### One generated typed client, no drift

All data flows through `app/lib/api.ts`, which attaches the caller's Logto access token as a bearer on
every control-plane call. Request/response types come from `app/lib/api-types.ts`, generated from the
gateway's OpenAPI by `make generate` — the console cannot drift from the server contract. Mutations are
Next **server actions** that call the client and `revalidatePath`.

### UX contracts carried into the UI

- **Virtual keys are shown once.** Issue/rotate reveal the plaintext exactly once with a copy button +
  a ready-to-run snippet and a "won't be shown again" warning — matching the apps service's one-time
  contract; the key is never re-fetchable.
- **Provider secrets are write-only.** The form field is a password input; reads return only metadata
  (`last4`), never the secret.

### Design system: Tailwind + shadcn/ui primitives

Hand-added shadcn primitives (`components/ui/*`: button, card, input, label, table, dialog, badge) over
Radix + CVA + `cn` (tailwind-merge). One theme in `app/globals.css` (light/dark tokens). Radix
context-using primitives (Slot/Dialog/Label) are `'use client'`; the pure pieces stay server-renderable.

### Pure logic is extracted + unit-tested

`lib/usage.ts` (dashboard aggregation), `lib/checklist.ts` (setup derivation), `lib/snippet.ts` (cURL/
SDK builder), and `lib/utils.ts` (`cn`) are pure and covered by vitest. The screens stay thin. E2E is
Playwright: gating specs run unauthenticated; the full build→operate flow self-skips unless a seeded
Logto session (`RELAY_E2E_STORAGE_STATE`) is provided.

## Consequences

- **No backend change, no migration, no OpenAPI change** — `api-types.ts` already reflects the Day-12
  spec. New deps: tailwind/postcss/autoprefixer, radix dialog/label/slot, cva/clsx/tailwind-merge,
  lucide-react, tailwindcss-animate, @playwright/test.
- New scopes exercised by the UI: existing `apps:*`, `providers:*`, `analytics:read`, `audit:read`.
- `make e2e` now runs Playwright (was a stub); it needs the full stack (`make dev`).
- Routes editor + live traffic remain backlog — they require new control-plane endpoints (a `routes`
  API and a control-plane SSE feed) that a later day must add before the console can surface them.
