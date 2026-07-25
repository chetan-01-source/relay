# Phase 1 — Sign-off (§13 checklist)

Status of the Week-3 / Phase-1 Definition of Done (WEEK3-PRD §7). Engineering items are verified
against `main`; items marked _human_ require a person and are tracked as release tasks.

| #   | Criterion                                                                                                         | Status                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1   | `cache`, `metering`, `analytics` modules follow layer rules; `dep-check` green                                    | ✅                                                                    |
| 2   | No SQL outside `*.queries.ts`; analytics `group_by` allowlisted                                                   | ✅                                                                    |
| 3   | Any new tenant table → RLS + isolation probe; `check-rls.sh` green                                                | ✅ (0012 = column-only, no new table)                                 |
| 4   | Metering write path async (ring queue), off hot path; bench p99 < 25 ms                                           | ✅ (local bench p99 ~0.5 ms)                                          |
| 5   | Cache hit tenant-isolated (org in key), proven by isolation probe                                                 | ✅                                                                    |
| 6   | Graceful shutdown drains SSE + flushes queue + settles budgets; `/readyz` gates pg+valkey+warm                    | ✅ (drain bug found + fixed Day-14; verified under active stream)     |
| 7   | Unit + integration tests for all new logic; `make test` + `make coverage` green                                   | ✅ (coverage 95.3%)                                                   |
| 8   | New/changed endpoints → `make generate` → `openapi.json` + console types committed                                | ✅                                                                    |
| 9   | New error codes (if any) in `shared/errors.ts` + `docs/errors.md`; header contract in smoke                       | ✅ (no new codes)                                                     |
| 10  | ADRs `0008`–`0013` written; DEVELOPMENT.md §2 module list current                                                 | ✅                                                                    |
| 11  | Security scans (CodeQL/Trivy fs+image/gitleaks/osv) — no criticals; `--frozen-lockfile`; ignore-scripts allowlist | ✅ (image scan wired in `release.yml`)                                |
| 12  | Conformance + E2E green; **signed `v0.2.0` multi-arch images + SBOM + self-host bundle on GHCR**                  | ⏳ _pipeline built + dry-run green; publishes on the `v0.2.0` tag_    |
| 13  | Quickstart proves `git clone → proxied call < 15 min`; **3 external testers sign off**                            | ⏳ _quickstart written + locally validated; external testers = human_ |
| 14  | Conventional commits; feature/* → PR into `dev` (squash) → `dev` → `main` (ff-only)                               | ✅ (Days 11–15)                                                       |

## Remaining to declare Phase 1 shipped

1. Push tag `v0.2.0` → `release.yml` publishes signed images + SBOMs + bundle (dry-run first with
   `make release-dry`).
2. Enable GitHub Pages (Settings → Pages → GitHub Actions) so `pages.yml` serves the docs site.
3. Three external testers walk `docs/quickstart.md` (G2 validation) and report the wall-clock to first
   proxied call.
4. Run the retro; fold any findings into `docs/backlog.md`.

Everything code/pipeline-side is in place; what's left is the tag push + human validation.
