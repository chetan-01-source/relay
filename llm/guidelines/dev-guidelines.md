# Relay Gateway — Developer Guidelines

> The end-to-end contributor handbook: clone → install → run → change → verify → commit → push → PR → merge → clean up.
> Every command here is the one this repo actually uses. If a command in this doc fails on a clean checkout, that's a bug in the doc — fix it.

**Audience:** anyone making a code change to `relay`.
**Golden rule:** `main` is protected. You never push to `main` directly. Every change lands through a Pull Request that is green in CI, then squash-merged.

---

## Table of contents

1. [First-time setup (clone → running locally)](#1-first-time-setup)
2. [The daily loop (branch → change → verify)](#2-the-daily-loop)
3. [Pre-push checklist — run this before every push](#3-pre-push-checklist)
4. [Commit message conventions](#4-commit-message-conventions)
5. [Push, Pull Request, merge, delete — the full flow](#5-push-pr-merge-delete)
6. [What CI runs (and why your PR might go red)](#6-what-ci-runs)
7. [Keeping your branch fresh](#7-keeping-your-branch-fresh)
8. [Troubleshooting](#8-troubleshooting)
9. [Quick command reference](#9-quick-command-reference)

---

## 1. First-time setup

### 1.1 Prerequisites (install once per machine)

| Tool | Version | Install |
|---|---|---|
| Node.js | 22 LTS or newer | via `fnm` / `nvm` (never a global system install) |
| pnpm | 9.x | via Corepack (bundled with Node) |
| Docker + Compose v2 | latest | Docker Desktop / OrbStack / colima |
| git | ≥ 2.40 | `brew install git` / `apt` |
| GitHub CLI (`gh`) | latest | `brew install gh` (optional but recommended) |

```bash
# Node via fnm
fnm install 22 && fnm use 22 && fnm default 22
node -v                      # v22.x or higher

# pnpm via Corepack — DO NOT `npm i -g pnpm`
corepack enable
pnpm -v                      # 9.x (auto-pinned by the repo's packageManager field)

# docker
docker version && docker compose version
```

> **Why version managers?** The repo declares `engines.node` and `packageManager`. Corepack reads `packageManager` and uses the exact pnpm version the whole team uses — no "works on my machine" drift.

### 1.2 Clone

```bash
git clone https://github.com/chetan-01-source/relay.git
cd relay
```

### 1.3 Set your commit identity for this repo

Use your **GitHub no-reply email** so commits attribute to your account without leaking a personal address on a public repo:

```bash
git config user.name  "Your Name"
git config user.email "<id>+<username>@users.noreply.github.com"
# Find your no-reply email: GitHub → Settings → Emails → "Keep my email addresses private"
```

### 1.4 Install dependencies

```bash
pnpm install
```

- Uses the committed `pnpm-lock.yaml` — **deterministic**, same tree everyone gets.
- `ignore-scripts=true` is set in `.npmrc`: dependency postinstall scripts do **not** run (supply-chain safety). If a package genuinely needs its build script, it must be added to `pnpm.onlyBuiltDependencies` in root `package.json` via a reviewed PR.
- Installs husky git hooks automatically (via the `prepare` script).

### 1.5 First build (proves the workspace is wired)

```bash
pnpm turbo build
```

Expected: all packages (`@relay/shared`, `@relay/server`, `@relay/mockllm`, `@relay/console`) build. `shared` builds first because the others depend on it — Turborepo orders this for you.

### 1.6 Boot local infrastructure (when working on server code)

```bash
cd deploy/compose
cp .env.example .env          # fill in local values (never commit .env)
docker compose --profile core up -d --wait
docker compose ps             # postgres, valkey, logto, minio → healthy
```

> `.env` is gitignored. Only `.env.example` (empty values) is tracked. Generate secrets locally, e.g. `openssl rand -base64 32` for `RELAY_MASTER_KEY`.

---

## 2. The daily loop

### 2.1 Always start from an up-to-date `main`

```bash
git checkout main
git pull origin main
```

### 2.2 Create a short-lived branch

Branch naming: `<type>/<short-kebab-summary>` — the `<type>` matches the commit type (see §4).

```bash
git checkout -b feat/routing-failover
# other examples:
#   fix/budget-settle-race
#   chore/bump-fastify
#   docs/quickstart-edits
```

### 2.3 Make your change

Keep a branch/PR scoped to **one thing, mergeable in a day**. If it can't fit one PR, split it before you start.

Run the app while iterating:

```bash
pnpm turbo dev        # watch mode across packages
# or a single package:
pnpm --filter @relay/server dev
```

### 2.4 Verify continuously (see §3 for the full gate)

```bash
pnpm turbo lint typecheck build test
```

---

## 3. Pre-push checklist

**Run this before every `git push`.** It is the exact set of things CI will check — running it locally means your PR goes green the first time instead of ping-ponging red.

### 3.1 One command that runs the whole gate

```bash
pnpm turbo lint typecheck build test && pnpm run dep-check && pnpm exec prettier --check .
```

If that whole line exits 0, CI will almost certainly be green.

### 3.2 What each step catches

| Step | Command | Catches | If it fails |
|---|---|---|---|
| **Lint** | `pnpm turbo lint` | ESLint errors — floating promises, misused promises, `console.log`, bad type imports | Fix the code. Formatting is separate (below). |
| **Typecheck** | `pnpm turbo typecheck` | TypeScript errors under strict mode (`noUncheckedIndexedAccess`, etc.) | Fix types — do **not** add `any` or `@ts-ignore` to silence. |
| **Build** | `pnpm turbo build` | Broken builds, bad imports, Next.js build errors | Fix the build. |
| **Test** | `pnpm turbo test` | Failing unit/integration tests | Fix the test or the code. Integration tests spin real Postgres/Valkey via testcontainers — Docker must be running. |
| **Module boundaries** | `pnpm run dep-check` | A module importing another module's internals; `platform/` importing `modules/`; circular deps; cross-package deep imports | Import through the public surface (`modules/<name>/index.ts`) or a workspace package name, not a deep path. |
| **Formatting** | `pnpm exec prettier --check .` | Unformatted files | Run `pnpm exec prettier --write .` to fix, then stage the changes. |

### 3.3 Manual checks the gate can't automate

- [ ] **Secrets:** no API keys, `.env` values, `sk-…` / `rk_…` strings, tokens in the diff. (Push protection + gitleaks will also block these — but don't rely on the net.)
- [ ] **Scope:** the diff only contains what the PR is about. No stray debug logs, no unrelated reformatting.
- [ ] **Docs:** if you changed user-facing behavior, update `/docs`. If you touched a design decision, add/update an ADR in `docs/adr/`.
- [ ] **New tenant table?** It must ship its RLS policies in the same migration + an isolation test. (`scripts/check-rls.sh` enforces the policy part in CI.)
- [ ] **New failure mode?** It emits a metric/log. **State mutation?** It emits an audit event.
- [ ] **Public API change?** Attach the OpenAPI diff in the PR description.

> The pre-commit git hook already runs lint + typecheck on affected packages, and the commit-msg hook validates your message format. Hooks are a convenience; **CI is the source of truth.** Running §3.1 fully before pushing is what actually saves you.

---

## 4. Commit message conventions

This repo uses **[Conventional Commits](https://www.conventionalcommits.org/)**, enforced by commitlint (the `commit-msg` git hook + CI). The squash-merge title becomes the release changelog entry, so the format is not cosmetic — it drives automated versioning.

### 4.1 Format

```
<type>(<optional scope>): <subject>

<optional body — what & why, wrapped ~72 cols>

<optional footer — BREAKING CHANGE / issue refs>
```

### 4.2 Allowed types

| Type | Use for | Version bump (at release) |
|---|---|---|
| `feat` | A new feature | minor |
| `fix` | A bug fix | patch |
| `docs` | Docs only | none |
| `refactor` | Code change that neither fixes a bug nor adds a feature | none |
| `perf` | Performance improvement | patch |
| `test` | Adding/fixing tests | none |
| `build` | Build system / dependencies | none |
| `ci` | CI config / workflows | none |
| `chore` | Everything else (tooling, housekeeping) | none |

### 4.3 Rules commitlint enforces

- Type is **lowercase** and from the list above.
- Subject is **not** capitalized and has **no trailing period**.
- Subject is in the **imperative mood**: "add", not "added" / "adds".
- A blank line separates subject from body.
- Header (type + scope + subject) stays under ~72 characters.

### 4.4 Good vs bad

```
✅ feat(routing): add weighted target selection with failover
✅ fix(policy): settle budget reserve on stream error
✅ chore: bump fastify to 5.2.1
✅ docs(readme): correct quickstart clone URL

❌ Fixed the routing bug                 (no type; past tense; capitalized)
❌ feat: Added New Feature.               (capitalized; past tense; trailing period)
❌ update stuff                           (no type; meaningless subject)
❌ WIP                                     (not a real message)
```

### 4.5 Breaking changes

Add a `!` after the type/scope **and** a `BREAKING CHANGE:` footer:

```
feat(api)!: rename X-Relay-Cost header to X-Relay-Cost-USD

BREAKING CHANGE: clients parsing X-Relay-Cost must switch to X-Relay-Cost-USD.
```

This triggers a **major** version bump.

### 4.6 Template (optional local helper)

Save as `~/.gitmessage` and run `git config commit.template ~/.gitmessage`:

```
# <type>(<scope>): <subject>   (<=72 chars, imperative, no period)
#
# Why is this change needed?
#
# What does it do?
#
# Footer: BREAKING CHANGE: ... / Refs #123
```

---

## 5. Push, PR, merge, delete

### 5.1 Push your branch

```bash
git push -u origin feat/routing-failover
```

`-u` sets upstream so later pushes are just `git push`. You **cannot** push to `main` — it's protected.

### 5.2 Open a Pull Request

**Via GitHub CLI:**
```bash
gh pr create --base main --head feat/routing-failover \
  --title "feat(routing): add weighted target selection with failover" \
  --body "..."      # the PR template auto-fills; complete the DoD checklist
```

**Via GitHub web UI:** GitHub shows a "Compare & pull request" banner after you push. Click it → base = `main`, compare = your branch → fill the template → **Create pull request**.

> The **PR title** should itself be a valid Conventional Commit — because on squash-merge it becomes the commit subject on `main`.

### 5.3 Wait for CI to go green

Your PR shows required checks. All must pass before the merge button unlocks (see §6). Fix anything red, push again — the same branch/PR updates automatically.

### 5.4 Merge — squash only

This repo allows **only squash merges**. Merge commits and rebase-merges are disabled.

**Via web UI:**
1. Click **Squash and merge** (the only enabled option).
2. GitHub proposes a commit message built from your PR title + commits. **Edit it** so the title is a clean Conventional Commit and the body is meaningful.
3. Confirm.

**Via CLI:**
```bash
gh pr merge <number> --squash --delete-branch
```

**What squash does:** every commit on your branch (including "wip", "fix typo", "address review") is collapsed into **one** commit on `main`. `main` stays linear and each commit maps to one PR. This is why messy in-progress commits on your branch are fine — only the final squashed message matters.

### 5.5 Delete the branch

- **Web UI:** after merge, click **Delete branch**. (This repo also auto-deletes merged branches.)
- **CLI:** `--delete-branch` (above) removes the remote branch.

Then clean up locally:

```bash
git checkout main
git pull origin main
git branch -d feat/routing-failover        # delete local branch
git remote prune origin                    # drop stale remote-tracking refs
```

> **Why prune?** When the remote branch is deleted at merge, your local `origin/<branch>` reference lingers until pruned. Pruning keeps `git branch -a` honest and stops old commits hanging around.

### 5.6 The full lifecycle at a glance

```
main (protected)
  │  git checkout -b feat/x
  ▼
feat/x ──edit──▶ verify (§3) ──▶ commit (§4) ──▶ push ──▶ open PR
                                                            │
                                                   CI runs (§6)
                                                            │ green
                                                            ▼
                                                   Squash & merge  ──▶ 1 commit on main
                                                            │
                                                   branch deleted (remote + local + prune)
```

---

## 6. What CI runs

Every PR triggers these GitHub Actions workflows. Required checks must be green before merge.

| Workflow | Trigger | Jobs | Maps to local command |
|---|---|---|---|
| `ci.yml` | PR + push to `main` | lint + typecheck + dependency-cruiser + commitlint; build; test (with testcontainers); RLS gate | `pnpm turbo lint typecheck build test` + `pnpm run dep-check` |
| `security.yml` | PR + push + weekly cron | CodeQL, osv-scanner, gitleaks, Trivy (filesystem) | (scanners — nothing to run locally, but keep deps clean & no secrets) |

**Why a PR goes red — and the fix:**

| Red check | Meaning | Fix locally |
|---|---|---|
| `lint-typecheck` | ESLint/TS/prettier/commitlint/dep-cruiser failed | Run §3.1; fix; re-push |
| `build` | A package didn't build | `pnpm turbo build` |
| `test` | A test failed | `pnpm turbo test` (Docker running for integration) |
| `rls-gate` | A tenant table is missing RLS policies | Add `ENABLE`/`FORCE RLS` + `tenant_isolation` + `platform_admin_access` policies in the migration |
| `codeql` / `trivy` / `osv` | Security finding | Read the alert; upgrade the dependency or fix the code |
| `gitleaks` / push protection | A secret is in your diff/history | Remove it, **rotate the credential**, force-clean history if needed |

> **Never merge a red PR by disabling a check.** If a check is wrong, fix the check in its own PR.

---

## 7. Keeping your branch fresh

Branch protection requires your branch to be up to date with `main` before merge (strict mode). If `main` moved while your PR was open:

```bash
git checkout main && git pull origin main
git checkout feat/routing-failover
git merge main            # or: git rebase main  (rebase keeps history linear)
# resolve conflicts if any, then:
pnpm install              # in case the lockfile changed on main
pnpm turbo lint typecheck build test
git push
```

The GitHub UI also offers an **"Update branch"** button that does the merge for you.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ERR_PNPM_UNSUPPORTED_ENGINE` | Wrong Node version | `fnm use 22` (or newer) |
| `tsup: command not found` in a package | Missing per-package dev dep | Ensure the tool is in that package's `devDependencies`, then `pnpm install` |
| Integration test: "Could not find a valid Docker environment" | Docker not running / `DOCKER_HOST` unset (colima/OrbStack) | Start Docker; for colima `export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock` |
| `vitest` fails "No test files found" | Package has no tests yet | Expected during scaffolding — scripts use `--passWithNoTests` |
| Commit rejected by hook | Message not Conventional Commit | Reword per §4 |
| Push to `main` rejected | `main` is protected | Push a branch and open a PR |
| Merge button disabled | Required checks not green / branch behind | Fix CI (§6); update branch (§7) |
| Prettier check fails in CI | Files not formatted | `pnpm exec prettier --write .` and commit |
| Local `origin/<branch>` still listed after merge | Stale remote-tracking ref | `git remote prune origin` |

---

## 9. Quick command reference

```bash
# --- setup ---
corepack enable
pnpm install                       # deterministic install (frozen in CI)

# --- run ---
pnpm turbo dev                     # watch all packages
pnpm --filter @relay/server dev    # one package
docker compose --profile core up -d --wait   # local infra (from deploy/compose)

# --- verify (run before every push) ---
pnpm turbo lint typecheck build test
pnpm run dep-check
pnpm exec prettier --check .       # (--write to fix)

# --- branch & commit ---
git checkout main && git pull origin main
git checkout -b feat/my-thing
git add -p                         # stage intentionally, review each hunk
git commit -m "feat(scope): imperative subject"

# --- push & PR ---
git push -u origin feat/my-thing
gh pr create --base main --title "feat(scope): ..." --body "..."
gh pr merge <n> --squash --delete-branch

# --- clean up after merge ---
git checkout main && git pull origin main
git branch -d feat/my-thing
git remote prune origin
```

---

*Relay Gateway — Developer Guidelines · aligned with the repo's actual pnpm + Turborepo + GitHub Actions setup and the 3-Week Dev-Cycle PRD (§15 Definition of Done, §10 CI/CD).*
