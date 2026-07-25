#!/usr/bin/env bash
# Restore a Postgres backup produced by scripts/backup.sh into the local compose stack.
# DESTRUCTIVE: --clean drops and recreates every object in the dump before reloading it.
#
#   scripts/restore.sh backups/relay-20260725T140000Z.dump
set -euo pipefail

COMPOSE="docker compose -f deploy/compose/compose.yaml"
DUMP="${1:-}"

[ -n "$DUMP" ] || { echo "usage: scripts/restore.sh <dump-file>" >&2; exit 1; }
[ -f "$DUMP" ] || { echo "restore: no such file: $DUMP" >&2; exit 1; }

echo "restore: ${DUMP} -> relay (this drops and recreates existing objects)"
# --clean --if-exists so a re-restore over a populated DB is idempotent; --no-owner because the app
# roles differ from the dumping superuser. Exit non-zero on any error (pipefail + ON_ERROR handling).
$COMPOSE exec -T postgres pg_restore --clean --if-exists --no-owner -U postgres -d relay <"$DUMP"
echo "restore complete."
