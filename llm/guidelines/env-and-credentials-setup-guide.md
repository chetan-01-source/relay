# Relay Gateway — Environment & Credentials Setup Guide

> How to produce every value in `deploy/compose/.env` from a clean checkout: infra passwords, the master key, Postgres connection, and a full Logto setup (admin account → Management API app → console app → users). Follow top to bottom once; after that `make up` just works.

**File you are filling:** `deploy/compose/.env` (copied from `.env.example`, **never committed** — it is gitignored).
**Rule:** every value below is generated or created by *you*, locally. Nothing here is shared over chat/email. Keep the finished `.env` on your machine only.

---

## 0. The two tiers of config

`.env` holds two groups:

| Group | Prefix | Consumed by | When |
|---|---|---|---|
| **Infra** | `POSTGRES_*`, `MINIO_ROOT_*`, `RELAY_APP_PASSWORD` | Docker Compose (container startup + `initdb`) | at `docker compose up` |
| **relay-server** | `RELAY_*` | the gateway's `platform/config` Zod schema | at server boot (validated, fails fast if missing/invalid) |

Some values appear in both and **must match**: `RELAY_APP_PASSWORD` is set on the `relay_app` role (via `initdb`) and embedded in `RELAY_DATABASE_URL`; `POSTGRES_PASSWORD` is the superuser password and is embedded in `RELAY_MIGRATION_DATABASE_URL` (and the Logto `DB_URL`).

---

## 1. Prerequisites

```bash
node -v      # >= 22
pnpm -v      # 9.x
docker version && docker compose version
openssl version
```

Create your working copy of the env file:

```bash
cd deploy/compose
cp .env.example .env
```

Now edit `.env` as you work through the steps below.

---

## 2. Generate the infra secrets

Use strong random values — not `change-me-locally`.

```bash
# run each, paste the output into the matching .env key
openssl rand -hex 24      # -> POSTGRES_PASSWORD
openssl rand -hex 24      # -> RELAY_APP_PASSWORD
openssl rand -hex 24      # -> MINIO_ROOT_PASSWORD
openssl rand -base64 32   # -> RELAY_MASTER_KEY   (32 raw bytes for AES-256, base64-encoded)
```

> **Use `-hex`, not `-base64`, for the three passwords.** `POSTGRES_PASSWORD` and `RELAY_APP_PASSWORD` are embedded inside connection URLs (`postgres://relay_app:<pw>@…`); base64 output contains `/`, `+`, and `=`, which are invalid unencoded in a URL and corrupt the connection string. Hex is URL-safe and shell-safe. `RELAY_MASTER_KEY` stays base64 — it is a bare value, never placed in a URL, and must decode to exactly 32 bytes.

Fill in:

```dotenv
# === infra (docker compose) ===
POSTGRES_PASSWORD=<paste 24>
RELAY_APP_PASSWORD=<paste 24>
MINIO_ROOT_USER=relay
MINIO_ROOT_PASSWORD=<paste 24>
```

| Key | What it is | Notes |
|---|---|---|
| `POSTGRES_PASSWORD` | Superuser (`postgres`) password | Used by migrations + `initdb`; also in the Logto `DB_URL` |
| `RELAY_APP_PASSWORD` | Password for the **non-superuser** `relay_app`/`relay_admin` roles the gateway connects as | RLS applies to these roles; **must match** the password in `RELAY_DATABASE_URL` (§3) |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | MinIO root console login | You create a scoped access key later (§6) |

> **`RELAY_MASTER_KEY` is special** — it is the envelope-encryption KEK that wraps every stored provider credential (`sk-…`). If you lose it, all encrypted provider creds are unrecoverable; if it leaks, they are all exposed. Generate with `openssl rand -base64 32`, store in `.env` only, and back it up in a password manager — never in git, never in chat.

---

## 3. Compose the relay-server connection strings

These are derived, not invented — build them from values above.

```dotenv
# === relay-server ===
RELAY_DATABASE_URL=postgres://relay_app:<RELAY_APP_PASSWORD>@localhost:5432/relay
RELAY_MIGRATION_DATABASE_URL=postgres://postgres:<POSTGRES_PASSWORD>@localhost:5432/relay
RELAY_VALKEY_URL=redis://localhost:6379
RELAY_MASTER_KEY=<paste 32 from §2>
RELAY_MINIO_ENDPOINT=http://localhost:9000
RELAY_LOGTO_ENDPOINT=http://localhost:3001
RELAY_BOOTSTRAP_ADMIN_EMAIL=you@yourdomain.com
```

| Key | Value | Why |
|---|---|---|
| `RELAY_DATABASE_URL` | `relay_app` + its password + `localhost:5432/relay` | The gateway's **runtime** connection. `relay_app` is a non-superuser role; RLS is enforced against it |
| `RELAY_MIGRATION_DATABASE_URL` | `postgres` (superuser) + `POSTGRES_PASSWORD` + `localhost:5432/relay` | The connection `relay migrate` uses. Migrations run as **superuser** so they can `CREATE TABLE`, `FORCE ROW LEVEL SECURITY`, and `CREATE POLICY`; tables are owned by `postgres` and `relay_app` inherits access via the `ALTER DEFAULT PRIVILEGES` set in `initdb/01-init.sh`. The runtime role deliberately lacks `CREATE ON SCHEMA public` |
| `RELAY_VALKEY_URL` | `redis://localhost:6379` | Valkey speaks the Redis protocol; no auth locally |
| `RELAY_LOGTO_ENDPOINT` | `http://localhost:3001` | Logto's **OIDC** endpoint (token validation). Admin console is 3002 (§5) |
| `RELAY_BOOTSTRAP_ADMIN_EMAIL` | your email | Seeded as the first platform admin by `make seed-auth` |

> **Two DB URLs, by design.** Runtime traffic uses the RLS-bound `relay_app` role (`RELAY_DATABASE_URL`); schema changes use the superuser role (`RELAY_MIGRATION_DATABASE_URL`). This is the separation that lets RLS be `FORCE`d without the app role being able to bypass or alter it. Both point at the same `relay` database — only the role differs.

`RELAY_LOGTO_M2M_APP_ID`, `RELAY_LOGTO_M2M_APP_SECRET`, and the `RELAY_MINIO_*` keys stay blank for now — you fill them in §5 and §6.

---

## 4. Boot the infrastructure

```bash
cd deploy/compose
docker compose --profile core up -d --wait
docker compose ps        # postgres, valkey, logto, minio → healthy
```

First boot: Postgres runs `initdb/01-init.sh` (creates the `logto` DB + `relay_app`/`relay_admin` roles + pgvector), and Logto seeds ~71 tables (~30–60s). Wait until all four are `healthy`.

> **Infra passwords are baked on first boot only.** `POSTGRES_PASSWORD` **and** `RELAY_APP_PASSWORD` (the latter sets the `relay_app`/`relay_admin` role passwords via `initdb`) are applied only when Postgres initializes an empty data dir. If you change either in `.env` afterward, the running DB keeps the old password and `RELAY_DATABASE_URL` silently mismatches. To apply a change you must wipe the volume: `docker compose down -v` then `up` again (this destroys all local data). Same applies to `MINIO_ROOT_PASSWORD`.

---

## 5. Logto setup (admin → Management API app → console app → users)

Logto is the identity provider. You need: (a) an admin account to log in, (b) a **machine-to-machine (M2M)** app so the gateway can call Logto's Management API, and (c) a **console app** for the relay-console sign-in. Then create users.

### 5.1 Create the first admin account

1. Open the **admin console**: <http://localhost:3002>
2. On first run Logto shows a **"Create account"** screen (no admin exists yet). Set a username + password. **This is the Logto admin — store it in your password manager.**
3. You land in the Logto dashboard.

> This admin is separate from `RELAY_BOOTSTRAP_ADMIN_EMAIL`. The Logto admin manages the IdP; the bootstrap email becomes the first *platform admin of Relay* (seeded later via `make seed-auth`).

### 5.2 Create the Management API M2M app (fills `RELAY_LOGTO_M2M_*`)

The gateway uses this to create orgs/apps/users programmatically.

1. Left nav → **Applications** → **Create application**.
2. Choose **Machine-to-Machine** → name it `relay-server` → **Create**.
3. On the app page, open the **Permissions / API access** (Machine-to-Machine) tab.
4. Grant it the **Logto Management API** role (`Logto Management API access` / the default M2M role that maps to `all` on the Management API resource).
5. Copy from the app's **Settings**:
   - **App ID** → `RELAY_LOGTO_M2M_APP_ID`
   - **App Secret** → `RELAY_LOGTO_M2M_APP_SECRET`

```dotenv
RELAY_LOGTO_M2M_APP_ID=<app id from Logto>
RELAY_LOGTO_M2M_APP_SECRET=<app secret from Logto>
```

### 5.3 Create the console sign-in app (for relay-console, sprint Day 5+)

1. **Applications** → **Create application** → **Next.js (App Router)** (or "Traditional web").
2. Name it `relay-console` → **Create**.
3. Set **Redirect URIs**: `http://localhost:3000/callback`
   and **Post sign-out redirect URIs**: `http://localhost:3000`.
4. Note its **App ID** and **App Secret** — the console reads these (they are wired by `make seed-auth`; you don't need them in this `.env` for the gateway itself).

### 5.4 Create users

Two options:

**A. Let `make seed-auth` bootstrap the platform admin (recommended):**
```bash
cd <repo root>
make seed-auth        # idempotent — creates the relay app/M2M wiring + seeds RELAY_BOOTSTRAP_ADMIN_EMAIL as platform admin
```
(This target lands sprint Day 5; until then create users manually via B.)

**B. Manually in the Logto console:**
1. Left nav → **Users** → **Add user**.
2. Set email = your `RELAY_BOOTSTRAP_ADMIN_EMAIL` (and/or teammates).
3. Set a password or send an invite.
4. (Later) assign roles/organizations under **Organizations** + **Roles** once the entitlement templates exist.

---

## 6. MinIO access key (fills `RELAY_MINIO_*`)

Don't use the root credentials in the app — create a key **scoped to the `relay` bucket only**. A plain access key inherits the root (admin) policy; scoping requires attaching a restrictive policy.

1. Open the MinIO console: <http://localhost:9001>
2. Log in with `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` (from §2).
3. **Buckets** → **Create Bucket** → name `relay` (attachment/replay store).
4. **Policies** → **Create Policy** → name `relay-rw`, paste:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow",
         "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
         "Resource": ["arn:aws:s3:::relay", "arn:aws:s3:::relay/*"] }
     ]
   }
   ```
5. **Access Keys** → **Create access key** → under **Restrict beyond user policy / Attach policy** select `relay-rw` → **Create** → copy the **Access Key** and **Secret Key**.

```dotenv
RELAY_MINIO_ENDPOINT=http://localhost:9000
RELAY_MINIO_ACCESS_KEY=<access key>
RELAY_MINIO_SECRET_KEY=<secret key>
```

> Endpoint is the **API** port `9000`; `9001` is only the web console.
> Without the attached `relay-rw` policy the key can read/write **every** bucket — that is not "scoped". Verify the key cannot touch a second test bucket before trusting it.

---

## 7. Verify the whole setup

```bash
cd <repo root>
make bootstrap        # checks tools, installs, builds shared
make up               # boots core + (once implemented) migrate + seed
```

Manual smoke checks:

```bash
# Postgres reachable as the runtime app role (non-superuser)
psql "postgres://relay_app:$RELAY_APP_PASSWORD@localhost:5432/relay" -c '\conninfo'

# Postgres reachable as the migration superuser role
psql "postgres://postgres:$POSTGRES_PASSWORD@localhost:5432/relay" -c 'select current_user, session_user;'

# Valkey
docker compose -f deploy/compose/compose.yaml --profile core exec valkey valkey-cli ping   # PONG

# Logto OIDC discovery responds
curl -s http://localhost:3001/oidc/.well-known/openid-configuration | head -c 200

# MinIO health
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:9000/minio/health/live   # 200
```

> **Testing an actual completion?** The mock provider (`mockllm`) is in the `dev` profile, not `core`. Start it with `make dev` (or `docker compose --profile dev up -d`) — otherwise the gateway's hot path has nothing upstream to reach.

---

## 8. Filled-in example (values are placeholders — generate your own)

```dotenv
# === infra (docker compose) ===
POSTGRES_PASSWORD=Zx9k...redacted
RELAY_APP_PASSWORD=Qm4p...redacted
MINIO_ROOT_USER=relay
MINIO_ROOT_PASSWORD=Vt7s...redacted

# === relay-server ===
RELAY_DATABASE_URL=postgres://relay_app:Qm4p...redacted@localhost:5432/relay
RELAY_MIGRATION_DATABASE_URL=postgres://postgres:Zx9k...redacted@localhost:5432/relay
RELAY_VALKEY_URL=redis://localhost:6379
RELAY_MASTER_KEY=8f3c...redacted(32 bytes base64)
RELAY_LOGTO_ENDPOINT=http://localhost:3001
RELAY_LOGTO_M2M_APP_ID=abcd1234efgh5678
RELAY_LOGTO_M2M_APP_SECRET=xxxxxxxxredacted
RELAY_BOOTSTRAP_ADMIN_EMAIL=you@yourdomain.com
RELAY_MINIO_ENDPOINT=http://localhost:9000
RELAY_MINIO_ACCESS_KEY=RELAYxxxxxxxx
RELAY_MINIO_SECRET_KEY=xxxxxxxxredacted
```

> Note `RELAY_DATABASE_URL` (role `relay_app`) and `RELAY_MIGRATION_DATABASE_URL` (role `postgres`) carry **different** passwords: `RELAY_APP_PASSWORD` and `POSTGRES_PASSWORD` respectively.

---

## 9. Security rules (non-negotiable)

- **Never commit `.env`.** Only `.env.example` (empty values) is tracked; `.gitignore` blocks `.env`, and push protection + gitleaks are a second net.
- **`RELAY_MASTER_KEY`**: back up in a password manager; losing it bricks all encrypted provider creds. Rotating it requires re-encrypting (the `relay keys rewrap` CLI, sprint).
- **Passwords match where they must**: `RELAY_APP_PASSWORD` == the password inside `RELAY_DATABASE_URL`; `POSTGRES_PASSWORD` == the password inside `RELAY_MIGRATION_DATABASE_URL` (and the Logto `DB_URL`).
- **URL-safe passwords**: generate DB/MinIO passwords with `openssl rand -hex 24`, never `-base64` (avoids `/ + =` breaking connection URLs).
- **Scoped MinIO key** with an attached `relay-rw` policy, not root, in `RELAY_MINIO_*`.
- **Rotate** any value that was ever pasted somewhere shared, and treat "it was just a test key" as a real leak.

---

## 10. Checklist

- [ ] `.env` created from `.env.example`
- [ ] `POSTGRES_PASSWORD`, `RELAY_APP_PASSWORD`, `MINIO_ROOT_PASSWORD` generated with `openssl rand -hex 24` (not defaults, not base64)
- [ ] `RELAY_MASTER_KEY` = `openssl rand -base64 32`, backed up
- [ ] `RELAY_DATABASE_URL` uses `relay_app` + `RELAY_APP_PASSWORD`
- [ ] `RELAY_MIGRATION_DATABASE_URL` uses `postgres` + `POSTGRES_PASSWORD` (same `relay` DB)
- [ ] `docker compose --profile core up -d --wait` → 4 services healthy
- [ ] Logto admin account created (localhost:3002)
- [ ] Logto M2M app created → `RELAY_LOGTO_M2M_APP_ID` + `_SECRET` filled
- [ ] Logto console app (`relay-console`) created with redirect URIs
- [ ] Bootstrap admin user created (`make seed-auth` or manual)
- [ ] MinIO bucket `relay` + `relay-rw` policy + access key scoped to it → `RELAY_MINIO_*` filled
- [ ] `make up` boots clean; smoke checks (§7) pass
- [ ] `.env` is git-ignored (`git check-ignore deploy/compose/.env` prints the path)

---

*Relay Gateway — Environment & Credentials Setup Guide · llm/guidelines (tracked) · aligned with `deploy/compose/compose.yaml` + `initdb/01-init.sh`.*
