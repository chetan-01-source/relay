# ADR 0012 — Operability hardening: graceful shutdown, readiness, conformance, backups

- **Status:** accepted
- **Date:** 2026-07-25 (Week 3, Day 14)
- **Context:** PRD §11 (hardening, conformance, security/bench gates). Builds on the value layer
  (ADR 0008–0010) and the console (ADR 0011).

## Context

Weeks 1–2 made Relay correct and isolated; Day 11–13 made it valuable and usable. Day 14 makes it
**safe to run**: a rolling deploy must not drop in-flight work or lose usage, a crashed worker must
fail cleanly rather than serve from a corrupted state, and the drop-in promise must be provable
against a real client — not just our own tests.

## Decision

### 1. Graceful shutdown (ordered drain, bounded)

On `SIGTERM`/`SIGINT` the worker drains in a fixed order (`cli/index.ts`):

1. flip readiness to **not-ready** so the load balancer stops routing here **before** anything closes;
2. `publicApp.close()` — stop accepting, let in-flight requests/SSE finish, and run Fastify `onClose`
   hooks, which is where the **metering ring queue flushes** and per-request **budget settles** land
   (each in-flight request settles its own reserve as it completes — no separate settle pass);
3. close the internal app, then the shared Postgres/Valkey handles.

A hard `RELAY_SHUTDOWN_TIMEOUT_MS` (default 15s) forces exit if a stream wedges, so a bad connection
can never block a deploy. Shutdown is **idempotent** — a second signal during drain is ignored.

**Unhandled-rejection / uncaught-exception policy:** log `fatal` and `exit(1)`. A process in an
unknown state is never allowed to keep serving; the orchestrator respawns a clean worker. This is the
deliberate "let it crash" stance — continuing would risk silent, cross-request corruption.

### 2. Readiness vs liveness

`/healthz` stays a pure liveness check (process up, touches nothing). `/readyz` gates on **Postgres +
Valkey reachable AND `warm`** — a flag the CLI flips true only after both ports listen and every
module is wired, and false the instant shutdown begins. So readiness models "safe to route to,"
liveness models "alive," and the two never conflate (a slow DB never triggers a restart; a draining
worker is pulled from rotation before it closes a socket). The probe also reports the gateway
`version` (single-sourced in `version.ts`), surfaced on the console **System Status** page.

### 3. Conformance = the drop-in proof

`test/conformance/` runs the **official OpenAI Node SDK, unmodified**, against a live gateway →
mockllm: non-stream, streaming, tools passthrough, and error-envelope mapping (401/404/400 → the
SDK's typed errors). It talks to a real stack, so it self-skips without
`RELAY_CONFORMANCE_BASE_URL`/`_KEY` and is never part of `make test`. `conformance.yml` boots the
stack, seeds a key, runs it, and then runs the **cross-tenant isolation suite (G4) against a real
non-superuser `relay_app` role** — the main `ci.yml` test job runs as superuser (RLS bypassed), so G4
only truly executes here. Triggers: nightly cron + `workflow_dispatch` + the `conformance` PR label.

**Scope cut (tracked, not silent):** the Python SDK, LangChain, and Vercel AI SDK are Weeks-4+
follow-ons — the OpenAI wire format is the canonical surface and is covered first. Noted in
`conformance.yml`.

### 4. Bench key fix

`bench.yml` measured nothing: the data plane authenticates every request and the bench used a bogus
key, so the load was 100% `401`. It now seeds a demo tenant and passes the real key via
`RELAY_LOAD_KEY`. The gate stays **advisory on GitHub's shared 2-vCPU runner** (co-hosted deps make
the number noisy); the strict G3 (`p99 < 25 ms`) belongs on a dedicated host via `make bench`.

### 5. Backups

`make backup` / `make restore` wrap `pg_dump -Fc` (superuser, so RLS never hides rows) plus a
best-effort MinIO mirror; `docs/runbooks/backup-restore.md` documents the round-trip and the
production schedule. No secret is ever decrypted — sealed credentials and hashed keys are dumped as
stored.

## Consequences

- Rolling deploys are safe: drain-before-close + a bounded timeout + fail-fast on programmer errors.
- The drop-in claim is continuously proven by a real SDK, and G4 runs against real RLS in CI.
- New knobs: `RELAY_SHUTDOWN_TIMEOUT_MS` (server), `RELAY_INTERNAL_URL` (console). New workspace
  package `@relay/conformance`. No new tables, no new error codes, no public-API change (readiness is
  internal; Status is a console read) — so `openapi.json` is unchanged.
