# Weeks-4+ backlog

Post-Phase-1 work. Two buckets: **carried** (scope-cut from Weeks 1–3, see `docs/scope-cut-ledger.md`)
and **roadmap** (PRD §14 — the deliberately-deferred product surface).

## Carried (from the scope-cut ledger)

| Item | Summary                                                                                                                                                                    |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13.1 | Dashboard **cache-savings + error-rate** tiles — needs `usage_rollups_hourly` extended with `cache_hits` + `errors` counts and the metering rollup worker populating them. |
| 13.2 | **build-flow E2E** un-skip — seed a Logto test user + a Playwright `storageState` global-setup so the non-author-mints-a-key flow runs in CI.                              |
| 14.1 | Conformance breadth — **OpenAI Python** SDK (Python CI job) + **LangChain** + **Vercel AI SDK** specs in `@relay/conformance`.                                             |
| 14.3 | **Strict bench** on a self-hosted 2-vCPU runner (`bench-strict` job, p99 < 25 ms gate).                                                                                    |

## Roadmap (PRD §14)

- **Guardrails** — per-route input/output policies (PII redaction, content filters, schema validation).
- **Semantic cache** — embedding-similarity cache alongside today's exact-match cache.
- **Request replay** — capture + re-run requests for debugging and eval.
- **Webhooks** — usage/budget/audit event delivery to tenant endpoints.
- **Gemini + more providers** — additional adapters (audio, object-store attachments beyond images).
- **Helm chart** — first-class Kubernetes deploy alongside the Compose self-host bundle.
- **Enterprise** — SSO/SCIM, per-org data residency, longer audit retention, SLA tiers.

Ordering is set at the Weeks-4+ planning session; nothing here blocks the Phase-1 `v0.2.0` release.
