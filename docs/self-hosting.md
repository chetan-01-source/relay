# Relay Gateway — Self-Hosting Guide

Run Relay from the signed, multi-arch GHCR images. The `relay-selfhost.tar.gz` bundle (attached to
each release) is the fastest path; this guide covers configuration, Logto sign-in, upgrades, and
verification.

## 1. Boot the bundle

```bash
tar -xzf relay-selfhost.tar.gz && cd relay-selfhost
cp .env.example .env
```

Set the three required secrets (generate strong values):

| Var                  | Generate                  | Purpose                                                                                                    |
| -------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`  | `openssl rand -base64 24` | Postgres superuser                                                                                         |
| `RELAY_APP_PASSWORD` | `openssl rand -base64 24` | the non-superuser `relay_app` role RLS binds to                                                            |
| `RELAY_MASTER_KEY`   | `openssl rand -base64 32` | envelope-encryption KEK (must be 32 bytes) — **losing it makes sealed provider credentials unrecoverable** |

```bash
docker compose up -d
docker compose exec relay wget -qO- http://localhost:9090/readyz   # status:ready, warm:true
```

`relay-migrate` applies the SQL migrations (idempotent) before the gateway serves.

## 2. First proxied call

```bash
docker compose exec relay node dist/index.js seed-demo   # prints a rk_live_… key + a curl
```

Point any OpenAI client at `http://localhost:3000/v1` with that key. Configure a real upstream via the
console (provider credentials, sealed at rest) or `RELAY_UPSTREAM_URL` as the fallback.

## 3. Console sign-in (Logto)

The **data plane works with virtual keys alone** — Logto is only for the console. To enable it:

1. Stand up Logto (the dev compose runs `svhd/logto`; in production use your own instance).
2. Create a **Machine-to-Machine** app (grant "Logto Management API access") → set
   `RELAY_LOGTO_M2M_APP_ID` / `_SECRET` on the gateway; run `relay seed-auth` to create the API
   resource + roles + scopes.
3. Create a **traditional web** app for the console → set `LOGTO_ENDPOINT`, `LOGTO_APP_ID`,
   `LOGTO_APP_SECRET`, `LOGTO_COOKIE_SECRET` (`openssl rand -base64 32`), `LOGTO_BASE_URL` in `.env`.
4. `RELAY_API_RESOURCE` **must equal** the gateway's `RELAY_LOGTO_JWT_AUDIENCE`.

## 3a. Inviting people into an organization

Signing up for Relay and joining an organization are **separate acts**. Anyone may hold a Relay
account; membership of a tenant only ever comes from an invitation that the invited address accepts.

The flow, end to end:

1. A platform admin invites an email address (console → Organizations → _org_ → Members, or
   `POST /api/v1/platform/orgs/{orgId}/invitations`).
2. Logto emails that address a link to `${RELAY_CONSOLE_URL}/invitations/{id}`.
3. The recipient opens it and signs in — or registers, if they have no account yet. Both land back
   on the same page.
4. They accept. The gateway checks the **signed-in account's primary email matches the invited
   address**, then records the membership and re-authenticates them so the new org appears in their
   session. A forwarded link is useless to anyone else: possession of the URL grants nothing.

Three things must be in place or invitations go nowhere:

- **`RELAY_CONSOLE_URL`** — the invitation link is built from it. See §4a.
- **An email connector in Logto** with the `OrganizationInvitation` template. `make seed-auth`
  configures both from your `RELAY_SMTP_*` values; without an SMTP host it is skipped and no
  invitation mail can be sent.
- **`make seed-auth` on the current version** — it creates the `relay_org_member` organization role
  that an accepted invitation assigns, and marks `relay_member` as Logto's default role so a
  brand-new account can call the accept endpoint at all. Both are idempotent.

Invitations expire after 7 days. A pending one blocks re-inviting the same address (the API answers
409); revoke it first — the Members panel has Resend and Revoke for exactly this.

## 3b. Roles inside an organization

Every member holds one of two roles, chosen when they are invited and changeable afterwards from
the Members panel:

|                                         | Member | Admin |
| --------------------------------------- | ------ | ----- |
| Apps, keys, routes, playground, usage   | ✅     | ✅    |
| Budgets, providers, live traffic, audit | read   | read  |
| **Change a budget ceiling**             | ❌     | ✅    |
| **Add or delete a provider credential** | ❌     | ✅    |
| **Configure a notification channel**    | ❌     | ✅    |

Those writes are restricted because they are the ones that spend the org's money, swap the upstream
key its traffic flows through, or hold a credential that posts into a company chat room. Everything
else a member can already do, they keep. The
console hides the controls; the gateway independently returns 403 `insufficient_scope`, so hiding
the button is courtesy rather than the boundary.

**Existing organizations start with no admins.** The role lives in Relay's `org_members` table, which
is created empty — a member with no row reads as `member`, deliberately, so upgrading never promotes
anyone silently. Grant the first admin from the console: **Organizations → _org_ → Members → Role**.
That endpoint is platform-admin only, so a tenant cannot appoint its own first administrator or lock
its operator out. Newly onboarded orgs are fine automatically: the admin invited at onboarding gets
the admin role.

## 3bb. Notification channels: email, Slack, Microsoft Teams

Each organization configures its own channels under **Console → Notifications**. They are **additive,
not exclusive** — an org can have all three, and one event reaches every enabled channel:

| Channel         | What you paste                     | Where it comes from                                                                                                                        |
| --------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Email (SMTP)    | host, port, from address, password | your mail provider. Optional — without it Relay uses the platform mail server                                                              |
| Slack           | an incoming webhook URL            | Slack → your app → **Incoming Webhooks** → _Add New Webhook to Workspace_. The URL picks the channel                                       |
| Microsoft Teams | a workflow or connector URL        | Teams → channel → **Workflows** → _Post to a channel when a webhook request is received_. Legacy Incoming Webhook connector URLs also work |

Both Teams generations are supported and told apart automatically from the URL: retiring Office 365
connectors get a MessageCard, Power Automate Workflows get an Adaptive Card. Sending the wrong shape
posts a blank card, so this is detected rather than asked of you.

**The webhook URL is a credential.** Anyone holding it can post into that channel, so Relay treats it
exactly like an SMTP password or a provider key: sealed with `RELAY_MASTER_KEY`, never returned by
any read, never written to the audit trail. The console shows only whether one is stored. That also
means a blank field on save means _keep the stored URL_ — re-saving to flip a toggle will not wipe it.

**URLs are validated before they are stored.** The gateway fetches these from inside your network, so
it refuses anything that would turn notifications into a server-side request forgery tool: https only,
no embedded credentials, no non-standard port, no private/loopback/link-local address (including the
cloud metadata endpoint), and the vendor's own host. DNS is not resolved at save time — a hostname
that resolves to a private address is not caught here, so treat egress policy as the outer boundary.

**Use “Send test”** after saving. It posts a real message and reports the provider's own words
(`invalid_token`, `404`), which is the difference between a five-second fix and an unnoticed silence.

### Partial delivery

One event fans out to every enabled channel, and channels fail independently. Relay records which
ones succeeded (`notification_outbox.delivered_to`) before scheduling a retry, so if Teams is down
while email works, the retry sends only to Teams. Without that, a single broken webhook would re-mail
the whole organization on every attempt. The delivery log on the notifications page shows both the
status and which channels received each notification.

A notification is only `suppressed` when there was genuinely nowhere to send it — no chat channel and
no resolvable mailbox. An org that wired up Slack alone is fully served.

## 3c. Per-application routes

A route maps a client-facing model alias to upstream targets. By default it belongs to the whole
organization and every application resolves it. Scoping a route to one application (**Routes → New
route → Applies to**) creates an **override**: that application's keys resolve its route for the
alias, everyone else keeps the org-wide one.

```
request for "fast" from app A  →  app A's route for "fast", if it has one
                               →  otherwise the organization's route for "fast"
                               →  otherwise 404 model_not_found
```

Two consequences worth knowing:

- The same alias may exist twice (once org-wide, once per app) and that is not a conflict. A second
  route in the _same_ scope still is.
- The response cache is partitioned per application. Two apps sending an identical prompt can now
  route to different models, so a shared cache entry could answer one app with the other's
  completion. The cost is a lower hit rate across applications; the alternative is a cache that lies.

This composes differently from budgets, which **intersect** — a request must fit inside both its
application's ceiling and the organization's. Routes **override**; budgets **stack**.

## 4. Production notes

- **TLS / ingress**: terminate TLS at your reverse proxy; expose only `3000` (data) and `3100`
  (console). Keep `9090` (health/metrics) internal.
- **Readiness**: orchestrators should gate on `GET :9090/readyz` (pg + valkey + warm). Liveness =
  `/healthz`. Graceful shutdown drains in-flight requests within `RELAY_SHUTDOWN_TIMEOUT_MS`.
- **Backups**: schedule `pg_dump` — see `docs/runbooks/backup-restore.md`. The dump carries hashed
  keys + sealed credentials as-is; guard `RELAY_MASTER_KEY` separately.
- **Scaling**: the gateway is stateless (state lives in Postgres + Valkey) — run N replicas behind a
  load balancer; snapshot invalidation propagates over Valkey pub/sub in ≤1s.
- **Response cache**: `RELAY_CACHE_TTL_S` ships as `0`, which disables caching entirely. The
  per-route toggle and the `cache.exact` entitlement both still apply on top, but this is the master
  switch — leave it 0 and nothing is ever cached, whatever the console shows.
- **Email**: see §4a. Mailpit is dev-only and must never reach a production compose profile.

## 4a. Email / notifications in production

The gateway sends operational email (budget breaches, revoked keys, suspensions) and Logto sends
account email (verification codes, password resets). **Both need a real SMTP relay.** Local dev uses
Mailpit, which is a catcher — it accepts everything and delivers nothing.

### Do not ship Mailpit

Mailpit is on the compose `dev` profile, so `docker compose --profile core up` already excludes it.
Never add it to `core`: it would silently swallow every notification while reporting success.

### The two-hostname split disappears in production

Locally the gateway (host) uses `localhost` and Logto (container) uses the compose service name. In
production both reach the same relay over DNS, so they are the same value:

```bash
RELAY_SMTP_HOST=smtp.provider.com
RELAY_LOGTO_SMTP_HOST=smtp.provider.com   # equal in prod; only differs on a local stack
RELAY_SMTP_PORT=587                       # 587 = STARTTLS, 465 = implicit TLS
RELAY_SMTP_SECURE=false                   # true ONLY for 465
RELAY_SMTP_USER=<relay username>
RELAY_SMTP_PASSWORD=<relay password>      # a real credential — see "Secrets" below
RELAY_SMTP_FROM=relay@yourdomain.com      # MUST be a domain you control
RELAY_CONSOLE_URL=https://console.yourdomain.com
```

`RELAY_SMTP_SECURE` is the one people get wrong: port 587 negotiates TLS via STARTTLS _after_
connecting, so `secure` stays **false**. Setting it true on 587 fails to connect at all.

### `RELAY_CONSOLE_URL` is not cosmetic

Every notification links back to the console using it, and **organization invitations are unusable
without it** — the invitation email's only content is that link. Left at `http://localhost:3100`,
your users receive email pointing at their own machine. Set it to the public console URL.

### From-address and deliverability

`relay@localhost` works with Mailpit and is rejected by every real provider. The sending domain needs
**SPF**, **DKIM** and ideally a **DMARC** record, or mail lands in spam regardless of correct SMTP
settings. Most providers (SES, Postmark, SendGrid, Mailgun) walk you through domain verification —
do that before pointing Relay at them, not after.

### Quoting — the failure that looks like a wrong password

`.env` is sourced by the shell, so **any value containing a space must be quoted** or it is silently
truncated at the first space.

This bites specifically with Gmail, which displays its App Password as four groups of four. Pasted
raw it becomes a 4-character password and the relay answers:

```
535-5.7.8 Username and Password not accepted ... BadCredentials
```

— which reads like the wrong credential rather than a truncated one. Strip the spaces and quote it:

```bash
RELAY_SMTP_PASSWORD="abcdefghijklmnop"    # 16 chars, no spaces, quoted
```

Gmail also requires an **App Password** (2-Step Verification must be on); a normal account password
is always rejected for SMTP. Verify a credential without sending mail:

```bash
node -e 'require("nodemailer").createTransport({host:process.env.RELAY_SMTP_HOST,
  port:+process.env.RELAY_SMTP_PORT,secure:false,
  auth:{user:process.env.RELAY_SMTP_USER,pass:process.env.RELAY_SMTP_PASSWORD}})
  .verify().then(()=>console.log("AUTH OK")).catch(e=>console.log("FAILED:",e.message))'
```

### Secrets

`RELAY_SMTP_PASSWORD` is a live credential. `.env` is gitignored, but on a real deployment it should
come from your orchestrator's secret store (Kubernetes Secret, SSM, Vault) rather than a file on the
host.

Per-tenant SMTP passwords are sealed with `RELAY_MASTER_KEY` (same envelope scheme as provider
credentials), so that key now protects tenant mail credentials too — back it up separately from the
database and rotate it deliberately.

### Applying it

Logto's email connector is configured by `seed-auth`, which reads these variables. After changing
them:

```bash
make seed-auth      # idempotent; PATCHes the existing connector rather than duplicating it
```

Restart the gateway too — env is read at process start.

### Scaling and operations

- **Multiple replicas are safe.** The dispatcher claims work with `FOR UPDATE SKIP LOCKED`, so
  replicas share the outbox instead of contending or double-sending.
- **Throughput** is `batchSize` (20) per `RELAY_NOTIFY_INTERVAL_MS` (15s) per replica ≈ 80/min. Raise
  the interval or batch if you outgrow it; most providers rate-limit well below that anyway.
- **Retries** are 1m → 5m → 25m → hourly, then `failed` after 5 attempts.
- **Watch the outbox.** These are the queries worth alerting on:

  ```sql
  -- deliveries giving up
  SELECT count(*) FROM notification_outbox WHERE status = 'failed';
  -- stuck mid-send (a worker died between claim and result)
  SELECT count(*) FROM notification_outbox
   WHERE status = 'sending' AND created_at < now() - interval '10 minutes';
  ```

- **Suppressed is not failure.** It means nothing was sent on purpose — event disabled, no channel,
  or no recipients — and `last_error` says which.

### Known gaps

- **No bounce handling.** A hard bounce looks like a successful send; the gateway learns nothing from
  the provider. If you need suppression lists, wire the provider's bounce webhook.
- **No per-tenant send quota.** A tenant with its own SMTP uses its own reputation, but one on the
  platform relay shares yours.
- **`hideLogtoBranding`** is a paid Logto feature; the "Powered by Logto" footer stays on OSS.

## 5. Verify the images are authentic (Sigstore keyless)

```bash
cosign verify ghcr.io/chetan-01-source/relay:<tag> \
  --certificate-identity-regexp 'https://github.com/chetan-01-source/relay/.github/workflows/release.yml@.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

SBOMs (SPDX + CycloneDX) for both images are attached to every release.

## 6. Upgrade

Bump the image tags in `.env`, then `docker compose pull && docker compose up -d`. Migrations
re-apply idempotently; additive-only, so a rollback to the previous tag is safe.
