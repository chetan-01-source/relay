#!/usr/bin/env bash
# RLS gate (PRD hard non-negotiable #1): every tenant table (has an org_id column)
# must, within db/migrations/*.sql:
#   1. ENABLE + FORCE ROW LEVEL SECURITY
#   2. CREATE POLICY tenant_isolation      (USING org_id = current_setting('app.current_org')::uuid)
#   3. CREATE POLICY platform_admin_access (platform-admin bypass, still scoped + audited)
#
# Static check — fast, no DB needed, runs on every PR. The dynamic proof is the
# isolation suite (test/isolation). Vacuously green until the first tenant migration.
set -euo pipefail
shopt -s nullglob

MIG_DIR="db/migrations"
fail=0

sqls=("$MIG_DIR"/*.sql)
if [ ${#sqls[@]} -eq 0 ]; then
  echo "RLS gate: no migrations yet — nothing to check."
  exit 0
fi

# tables created anywhere in the migration set
tables=$(grep -rhoiE 'CREATE TABLE (IF NOT EXISTS )?[a-z_][a-z0-9_]*' "$MIG_DIR"/*.sql \
         | awk '{print $NF}' | sort -u)

for t in $tables; do
  # only tenant tables (those with an org_id column) are gated
  if grep -rhiA 60 "CREATE TABLE.*\b${t}\b" "$MIG_DIR"/*.sql | grep -qiE '^\s*org_id\b'; then
    while IFS= read -r needle; do
      if ! grep -rqiF "$needle" "$MIG_DIR"/*.sql; then
        echo "RLS GATE FAIL: tenant table '$t' missing: $needle" >&2
        fail=1
      fi
    done <<EOF
ALTER TABLE $t ENABLE ROW LEVEL SECURITY
ALTER TABLE $t FORCE ROW LEVEL SECURITY
CREATE POLICY tenant_isolation ON $t
CREATE POLICY platform_admin_access ON $t
EOF
  fi
done

if [ $fail -eq 0 ]; then
  echo "RLS gate: all tenant tables covered."
fi
exit $fail
