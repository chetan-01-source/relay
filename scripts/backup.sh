#!/usr/bin/env bash
# Backup — Postgres (pg_dump, custom format) + best-effort MinIO object mirror. Runs against the
# local compose stack (make up). Restore with scripts/restore.sh. See docs/runbooks/backup-restore.md.
#
#   BACKUP_DIR=./backups scripts/backup.sh
set -euo pipefail

COMPOSE="docker compose -f deploy/compose/compose.yaml"
BACKUP_DIR="${BACKUP_DIR:-backups}"
# A sortable UTC stamp; the operator, not the app, decides when a backup happens.
TS="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="${BACKUP_DIR}/relay-${TS}.dump"

mkdir -p "$BACKUP_DIR"

echo "backup: pg_dump relay -> ${DUMP}"
# -Fc = custom format (compressed, restorable selectively with pg_restore). Runs inside the container
# as the postgres superuser so RLS never hides rows from the dump.
$COMPOSE exec -T postgres pg_dump -U postgres -Fc relay >"$DUMP"
echo "  ok   $(du -h "$DUMP" | cut -f1) written"

# MinIO object store (provider attachments). Best-effort: only mirrors when the `mc` client is on PATH
# and a bucket exists. Attachments are a Weeks-4+ feature, so an empty/absent store is not an error.
if command -v mc >/dev/null 2>&1; then
  : "${MINIO_ROOT_USER:=relay}" "${MINIO_ROOT_PASSWORD:=change-me-locally}"
  MIRROR="${BACKUP_DIR}/minio-${TS}"
  mc alias set relaybak "http://localhost:9000" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1 || true
  if mc mirror --overwrite relaybak "$MIRROR" >/dev/null 2>&1; then
    echo "  ok   MinIO mirrored -> ${MIRROR}"
  else
    echo "  skip MinIO mirror (no buckets or MinIO unreachable)"
  fi
else
  echo "  skip MinIO mirror (mc client not installed)"
fi

echo "backup complete: ${DUMP}"
