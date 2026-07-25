# Runbook — Backup & Restore

How to back up and restore Relay's durable state. Phase-1 durable state is **two** stores:

| Store          | Holds                                                            | Tool                     |
| -------------- | ---------------------------------------------------------------- | ------------------------ |
| **Postgres**   | tenants, keys (hashed), providers (sealed), routes, usage, audit | `pg_dump` / `pg_restore` |
| **MinIO (S3)** | provider attachments (image passthrough — Weeks-4+)              | `mc mirror`              |

Postgres is the source of truth; MinIO is empty until the attachments feature ships, so its mirror is
best-effort. Nothing here ever decrypts a sealed credential or a hashed key — the dump carries the
ciphertext exactly as stored, so a restore preserves the two-key discipline.

## Back up

```bash
make backup                      # -> ./backups/relay-<UTC-timestamp>.dump  (+ MinIO mirror if mc present)
# or choose the location:
BACKUP_DIR=/secure/backups scripts/backup.sh
```

`pg_dump -Fc` (custom, compressed, selectively restorable) runs inside the `postgres` container as the
superuser, so **RLS never hides rows from the dump** — every tenant's data is captured. Verify an
archive without touching the database:

```bash
docker compose -f deploy/compose/compose.yaml exec -T postgres pg_restore --list < backups/relay-<ts>.dump
```

## Restore

**Destructive** — `--clean --if-exists` drops and recreates every object in the dump before reloading.
Take a fresh backup first, and expect open gateway connections to drop during the reload.

```bash
make restore DUMP=backups/relay-20260725T140000Z.dump
# or:
scripts/restore.sh backups/relay-20260725T140000Z.dump
```

`--no-owner` reloads cleanly even though the dumping superuser differs from the runtime `relay_app`
role. After a restore, re-run `make migrate` (idempotent) to confirm the schema is at head, then
`relay audit verify` to confirm every org's hash chain is intact.

## Schedule (production)

Run `scripts/backup.sh` from cron (or the orchestrator's job scheduler), ship `./backups` off-box
(the MinIO mirror or an object-store sync), and test a restore into a scratch database on a regular
cadence — an untested backup is not a backup. Retention and off-site copy are deployment policy, not
baked into the script.
