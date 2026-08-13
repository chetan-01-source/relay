# ADR 0013 — Release supply chain: signed multi-arch images + self-host bundle

- **Status:** accepted
- **Date:** 2026-07-25 (Week 3, Day 15)
- **Context:** PRD §9 / Day-15. Ships Phase-1 as `v0.2.0`. Builds on the hardening of ADR 0012.

## Context

Phase 1 must be **reproducibly and verifiably** installable by a third party: pull an image, prove it
came from our pipeline (not a tampered mirror), see what's inside it, and boot the whole stack without
a build toolchain. The stack is Docker Compose + GHCR (not AWS/SAM), so the release is container-first.

## Decision

### Images

Two multi-stage Dockerfiles, built with `docker buildx` for **linux/amd64 + linux/arm64**:

- `packages/server/Dockerfile` — builds the workspace, then `pnpm deploy --prod` produces a
  self-contained node_modules (with `@relay-ai/shared` resolved from `workspace:*` to its built output);
  the runtime stage carries only `dist` + prod deps + the SQL migrations `relay migrate` reads, and
  runs as a non-root user.
- `packages/console/Dockerfile` — Next.js `output: 'standalone'`, so the runtime ships only traced
  deps.

Both build context = repo root (they need `pnpm-lock.yaml` + the workspace). `make release-dry`
builds both locally, identically to CI, before a real tag.

### Pipeline (`release.yml`, on a `v*` tag)

`tests → buildx multi-arch → GHCR push → Syft SBOM (SPDX + CycloneDX) → Cosign keyless sign → Trivy
image gate (criticals) → GitHub Release`.

- **Signing is keyless** via GitHub OIDC (`id-token: write`) — **no private keys stored anywhere**.
  Verifiers check the certificate identity (the release workflow) + the Sigstore OIDC issuer.
- **SBOMs** (both formats) are generated with Syft against the pushed digests and attached to the
  Release; BuildKit provenance/SBOM attestations are also emitted.
- **Sign + scan by digest**, never by the mutable tag, so what we signed is exactly what we scanned.
- The **Trivy image gate** is the image half of PRD §Day-14's "Trivy fs + image" — it lives here
  because there is no image to scan until this build (ledger item 14.2, now closed).

### Self-host bundle

`make selfhost-bundle` assembles `relay-selfhost.tar.gz` = `compose.yaml` + `.env.example` (image refs
**pinned to the release tag**) + `README` + the `relay_app` role init. `docker compose up -d` boots
the **published** images (migrate one-shot → serve → console) — not a local build. Attached to the
Release.

### Docs

Quickstart (`git clone → proxied call < 15 min`), self-hosting guide, STRIDE threat model, and the
error catalog live under `docs/`; a self-contained landing (`docs/site`, Enterprise-Gateway themed) is
published to GitHub Pages by `pages.yml`.

## Consequences

- A self-hoster reaches a first proxied call in minutes and can cryptographically verify provenance.
- No key material to rotate or leak (keyless). Supply-chain scanning is continuous (release + weekly).
- The release **cannot** be cut before tests pass and the images are clean — the tag is the trigger,
  the gates are mandatory. Dry-run with `make release-dry`.
- New: two Dockerfiles, `release.yml`/`pages.yml` bodies, `deploy/selfhost/`, `make selfhost-bundle` /
  `audit-verify` / `release-dry`. No app-code or schema change.
