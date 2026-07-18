#!/usr/bin/env bash
# Smoke test — end-to-end sanity against a running stack (mockllm + relay serve).
# Verifies the full request path and the response contracts. Fast, deterministic, no deps.
#
#   RELAY_BASE_URL=http://localhost:3000 RELAY_INTERNAL_URL=http://localhost:9090 scripts/smoke.sh
set -euo pipefail

BASE=${RELAY_BASE_URL:-http://localhost:3000}
INTERNAL=${RELAY_INTERNAL_URL:-http://localhost:9090}
AUTH='authorization: Bearer rk_live_smoke'
JSON='content-type: application/json'
pass() { echo "  ok   $1"; }
fail() { echo "SMOKE FAIL: $1" >&2; exit 1; }

echo "smoke: $BASE (internal $INTERNAL)"

curl -fsS "$INTERNAL/healthz" | grep -q '"status":"ok"' || fail "healthz"; pass "healthz"

curl -fsS "$BASE/v1/models" | grep -q '"object":"list"' || fail "GET /v1/models"; pass "models list"
curl -fsS "$BASE/v1/models/gpt-4o" | grep -q '"owned_by":"openai"' || fail "GET /v1/models/:id"; pass "model by id"

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/models/__nope__")
[ "$code" = 404 ] || fail "unknown model should 404 (got $code)"; pass "unknown model 404"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/chat/completions" -H "$JSON" -d '{"model":"gpt-4o","messages":[]}')
[ "$code" = 401 ] || fail "missing key should 401 (got $code)"; pass "auth reject 401"

curl -fsS -X POST "$BASE/v1/chat/completions" -H "$AUTH" -H "$JSON" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}' \
  | grep -q '"object":"chat.completion"' || fail "non-stream completion"; pass "non-stream completion"

curl -fsS -N -X POST "$BASE/v1/chat/completions" -H "$AUTH" -H "$JSON" \
  -d '{"model":"gpt-4o","stream":true,"messages":[{"role":"user","content":"hi"}]}' \
  | grep -q 'data: \[DONE\]' || fail "stream completion terminator"; pass "stream completion"

echo "SMOKE OK"
