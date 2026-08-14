# Releasing Relay

How a release is cut, how `relay-gateway-sdk` is published, and **how to prove the SDK works against a real
gateway without deploying a server anywhere.**

That last part is the point of this document. A gateway is a container; running it on your laptop
exercises byte-for-byte the same code path a production deployment would. "Live" means _a real
gateway process, real Postgres, real Valkey, real HTTP_ — it does not mean "on the internet".

> **Deployment is deliberately out of scope here.** v1 ships as source, images and an npm package.
> Nothing below stands a public service up. The ops runbooks live outside this repo — see
> [§7](#7-what-is-not-in-this-repo).

---

## 0. The release at a glance

```
  1  freeze + verify            pnpm turbo lint typecheck test  (21 tasks)
  2  secret audit               nothing private becomes public, permanently
  3  version + changelog        one version across the workspace
  4  tag + push                 CI builds signed multi-arch images → GHCR
  5  publish the SDK            npm, after the scope question is settled
  6  PROVE IT — locally         real gateway on localhost, published SDK from npm
```

Steps 1–4 are ~15 minutes. Step 6 is the one that catches the failures the others cannot.

---

## 1. Freeze and verify

```bash
git checkout main && git pull
pnpm install --frozen-lockfile
pnpm turbo lint typecheck test      # 21 tasks
pnpm dep-check                      # module boundaries
scripts/check-rls.sh                # every tenant table is RLS-covered
pnpm format                         # check only; format:fix writes
```

All six must pass. `check-rls.sh` in particular is not a style gate — it is the static half of the
tenant-isolation guarantee, and a release that fails it is a release that can leak one customer's
data to another.

Regenerate anything derived from the API surface, and confirm it did not drift:

```bash
make generate                       # OpenAPI → console types + SDK types + Postman
git diff --exit-code || echo "REGENERATED OUTPUT CHANGED — commit it before tagging"
```

If that prints the warning, the checked-in types were stale. Commit the regenerated files; do not tag
around it, or the SDK ships types that disagree with the server it talks to.

---

## 2. Secret audit

The repository is **public**, and git history cannot be un-published. Anything pushed must be treated
as leaked and rotated, not merely deleted.

```bash
git add -A
git diff --cached | grep -nEi 'sk-[A-Za-z0-9]{20,}|BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}|xox[baprs]-'
git diff --cached --name-only | grep -E '(^|/)\.env$|^\.relay/|^llm/docs/|^docs/internal/|\.key$|\.pem$'
```

Both must print **nothing**. Then a real scanner, which catches what a grep does not:

```bash
gitleaks detect --no-git --redact     # working tree
gitleaks detect --redact              # full history
```

Turn on **Settings → Code security → Secret scanning + push protection** once. It is free on public
repos and blocks a credential at `git push` instead of telling you afterwards.

### If a secret was already pushed

Rotate **first**, scrub second. In that order — rewriting history does not un-leak anything, which is
why it is the second step. `RELAY_MASTER_KEY` is the painful case: rotating it means re-entering
every stored provider credential, because the old ones cannot be decrypted under a new key.

---

## 3. Version and changelog

One version across the workspace — the SDK's minor tracks the gateway's, so a `0.3.x` SDK is known to
speak to a `0.3.x` gateway.

```bash
pnpm -r exec npm version 1.0.0 --no-git-tag-version
git diff --stat        # every package.json, and nothing else
```

Write the changelog from the commit log, grouped by what a _reader_ cares about — added, changed,
fixed, security — not by which package the commit touched:

```bash
git log --oneline "$(git describe --tags --abbrev=0)"..HEAD
```

Then commit:

```bash
git add -A && git commit -m "chore(release): v1.0.0"
```

---

## 4. Tag and build

```bash
git tag -a v1.0.0 -m "Relay v1.0.0"
git push origin main --follow-tags
gh run watch
```

`release.yml` builds and signs **multi-arch images** (`linux/amd64`, `linux/arm64`) and pushes them to
GHCR. Verify both architectures actually exist before anyone relies on the tag:

```bash
docker manifest inspect ghcr.io/chetan-01-source/relay:1.0.0 | grep -c arm64   # ≥ 1
```

> A missing arm64 layer is worth catching here. On an ARM host the failure surfaces as
> `exec format error` in a restart loop, which reads like a corrupt image rather than a wrong
> architecture, and costs an hour.

---

## 5. Publish `relay-gateway-sdk`

### 5.1 Confirm you can publish

The package is **`relay-gateway-sdk`** — unscoped. Confirm the credential in front of you can
actually publish before doing anything else; npm reports a permission failure on publish as a
**404**, not a 403, which sends people hunting for a missing package that was never the problem:

```bash
npm whoami
npm access list packages     # what this token may write. Empty = it can publish nothing
npm publish --dry-run
```

> **Why unscoped.** Both `@relay` and `@relay-ai` on npm belong to other people —
> `@relay-ai/openclaw-plugin` is maintained by a different account entirely. A scope you do not own
> cannot be published to, and `npm org ls <scope>` lists that scope's _own_ members, so it will
> happily print `owner` for somebody else. The check that actually answers the question is
> `npm access list packages`: if it is empty, this token can publish nothing, whatever the org
> listing says.
>
> Unscoped also matches the norm for a library of this kind — `openai`, `stripe` and `prisma` are
> all unscoped — and needs no organization to exist first.

A published name can never be reused, so any rename has to happen **before** the first publish. It
touches `packages/*/package.json`, `packages/sdk/README.md`, `docs/sdk.md`,
`packages/console/app/docs/sdk/page.tsx`, `README.md` and this file.

### 5.2 Publish

```bash
pnpm --filter relay-gateway-sdk test        # unit; the e2e suite self-skips without a gateway
pnpm --filter relay-gateway-sdk build       # ESM + CJS + .d.ts
cd packages/sdk && npm pack --dry-run   # expect 7 files, ~46 kB, LICENSE included
npm publish --access public
```

Consider `--tag next` for the first publish. It puts the package on npm — so you can install and test
it exactly as a user would — without `npm i relay-gateway-sdk` resolving to it for everyone. Promote with
`npm dist-tag add relay-gateway-sdk@1.0.0 latest` once §6 passes.

---

## 6. Prove it works — live, without deploying

This is the section that matters, and the answer to "how do we test without deploying".

### 6.1 What "live" needs, and what it does not

| Needs                   | Does **not** need                                   |
| ----------------------- | --------------------------------------------------- |
| A real gateway process  | A public server                                     |
| Real Postgres + Valkey  | A domain or TLS                                     |
| Real HTTP over a socket | Any cloud account                                   |
| A real virtual key      | A real model provider — `mockllm` ships in the repo |

A gateway on `localhost:3000` runs the same binary, the same migrations, the same RLS policies and
the same middleware as one behind a load balancer. The only untested-by-this thing is your
_infrastructure_, and this release does not ship infrastructure.

### 6.2 Bring a real gateway up locally

```bash
make up          # Postgres, Valkey, Logto in containers; migrations; seed
make dev         # gateway :3000, console :3100, mockllm :8080
make seed-demo   # mints a real tenant + virtual key → .relay/seed-demo.key (gitignored)
```

`mockllm` is the deliberate default upstream: the suite sends real completions, and pointing them at
a real provider means a real bill and a rate limit that is not yours to spend.

### 6.3 Test the SDK from source

```bash
make sdk-e2e
```

Twelve tests. Six run against the data plane; six more need a control-plane token (§6.5). They assert
the **wire contract**, which a mocked `fetch` structurally cannot:

| Test                                  | The failure it exists to catch                                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Completion returns Relay metadata     | The gateway silently dropping `x-relay-cost-usd` / `-provider` / `-trace-id`. The completion is still valid, so only an explicit assertion notices |
| Stream reassembles and **terminates** | An SSE stream that never emits `[DONE]`. A fake stream always closes, so a unit test can never reproduce a hang                                    |
| Unknown model → typed 4xx             | A routing miss surfacing as a 500                                                                                                                  |
| Bad key → 401                         | Auth failures leaking as 500s                                                                                                                      |
| **Virtual key refused on `/api/*`**   | A data-plane credential becoming an accidental control-plane grant. This is ADR-0002's core guarantee, asserted rather than assumed                |

Expected:

```
✓ src/tests/e2e.test.ts (12 tests | 6 skipped)
  Tests  6 passed | 6 skipped (12)
```

### 6.4 Test the **published** package — the step people skip

§6.3 tests your working tree. It cannot catch a broken `exports` map, a `dist` that was never
rebuilt, or types that fail to resolve under a stricter `moduleResolution`. Those only appear once
the tarball is installed as a dependency:

```bash
mkdir /tmp/relay-smoke && cd /tmp/relay-smoke && npm init -y
npm i relay-gateway-sdk@next          # from npm, exactly as a user gets it

export RELAY_KEY="$(cat ~/path/to/relay/.relay/seed-demo.key)"

# ESM
node --input-type=module -e '
  import { Relay } from "relay-gateway-sdk";
  const relay = new Relay({ baseUrl: "http://localhost:3000", apiKey: process.env.RELAY_KEY });
  const res = await relay.chat.completions.create({
    model: "gpt-4o", messages: [{ role: "user", content: "hello" }],
  });
  console.log("text     :", res.choices[0].message.content.slice(0, 40));
  console.log("provider :", res.relay.provider);
  console.log("cost usd :", res.relay.costUsd);
  console.log("trace    :", res.relay.traceId);
'

# CJS — a separate build, and a separate way to be broken
node -e 'console.log(typeof require("relay-gateway-sdk").Relay)'   # "function"
```

Then prove the **types** resolve for a consumer, not just for us:

```bash
npm i -D typescript
npx tsc --init --strict --module node16 --moduleResolution node16 >/dev/null
echo 'import { Relay } from "relay-gateway-sdk"; const r = new Relay({ baseUrl: "", apiKey: "" }); void r;' > t.ts
npx tsc --noEmit t.ts
```

A clean run here means an npm user gets working autocomplete on day one. It is the difference between
a package that works and a package that merely publishes.

### 6.5 The control plane

Six more tests unlock with a Logto access token — sign in to the console at `localhost:3100` and copy
the bearer token the browser sends on any `/api/v1/*` request:

```bash
RELAY_E2E_ADMIN_TOKEN="eyJhbGciOi…" make sdk-e2e
```

These create **real rows** in whatever organization the token names — applications prefixed
`e2e-sdk-<timestamp>`, keys in the `test` environment. Point them at a scratch org. Nothing is
deleted on teardown, on purpose: a teardown that runs on failure destroys the evidence you needed.

### 6.6 Prove tenant isolation, by hand, once

Everything else rests on this, so verify rather than trust:

```bash
docker compose -f deploy/compose/compose.yaml exec -T postgres \
  psql -U postgres -d relay -c "
    SET ROLE relay_app;
    SELECT set_config('app.current_org', '<org-A-uuid>', false);
    SELECT count(*) AS should_be_zero FROM applications WHERE org_id = '<org-B-uuid>';"
```

Non-zero means the gateway is connected as an owner and RLS is being bypassed. Stop and fix it.

### 6.7 Release checklist

- [ ] `make sdk-e2e` — 6/6 data-plane green
- [ ] Control-plane block green with a token
- [ ] Published tarball installs and runs (ESM **and** CJS)
- [ ] Types resolve under `module: node16` in a strict project
- [ ] Tenant isolation returns zero
- [ ] `docker manifest inspect` shows arm64
- [ ] Console `/docs` renders, screenshots load
- [ ] `npm dist-tag add relay-gateway-sdk@1.0.0 latest`
- [ ] GitHub release notes published from the tag

---

## 7. What is not in this repo

Deliberately absent, per [docs/internal/launch-playbook.md](docs/internal/launch-playbook.md) — a
public repository can hide nothing, so anything operational lives elsewhere:

|                                                        | Where                            |
| ------------------------------------------------------ | -------------------------------- |
| Secrets — master key, DB passwords, tokens             | A password manager. Never in git |
| Production compose overrides, hostnames, tunnel config | A private ops repo               |
| Runbooks, incident procedures, customer list           | A private ops repo               |
| Deployment strategy and free-tier analysis             | `docs/internal/` — gitignored    |

What stays public is the whole product: gateway, console, SDK, migrations, plan engine, and the docs
a self-hoster or contributor needs. That is the part worth being open, and it is what makes anyone
trust a box that holds their provider keys.

---

## 8. Post-release

- **Watch the first issues.** A packaging bug shows up within hours of the first `npm i`.
- **A patch is cheap.** `1.0.1` costs nothing; an unpublish is not really possible after 72 hours.
- **Keep the SDK and gateway minors aligned.** Bump both together and regenerate types in the same
  commit, or the version contract stops meaning anything.
