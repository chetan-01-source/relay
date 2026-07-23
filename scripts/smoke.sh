#!/usr/bin/env bash
# Smoke test — end-to-end sanity against a running stack (mockllm + relay serve).
# Verifies the full request path and the response contracts. Fast, deterministic, no deps.
#
# A REAL virtual key is required now that identity resolves keys (Day 6). Seed one first
# (`make seed-demo` writes it to .relay/seed-demo.key) or pass RELAY_SMOKE_KEY:
#
#   RELAY_BASE_URL=http://localhost:3000 RELAY_INTERNAL_URL=http://localhost:9090 scripts/smoke.sh
set -euo pipefail

BASE=${RELAY_BASE_URL:-http://localhost:3000}
INTERNAL=${RELAY_INTERNAL_URL:-http://localhost:9090}
KEY=${RELAY_SMOKE_KEY:-$(cat .relay/seed-demo.key 2>/dev/null || true)}
AUTH="authorization: Bearer ${KEY}"
JSON='content-type: application/json'
pass() { echo "  ok   $1"; }
fail() { echo "SMOKE FAIL: $1" >&2; exit 1; }

echo "smoke: $BASE (internal $INTERNAL)"
[ -n "$KEY" ] || fail "no virtual key — run 'make seed-demo' or set RELAY_SMOKE_KEY"

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

# Response-header contract (§4.2 / Day 12c): every proxied response carries the full header set.
hdrs=$(curl -fsS -D - -o /dev/null -X POST "$BASE/v1/chat/completions" -H "$AUTH" -H "$JSON" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}')
for h in x-relay-trace-id x-relay-provider x-relay-cache x-relay-failover x-relay-cost-usd x-relay-modalities; do
  echo "$hdrs" | grep -qi "^$h:" || fail "response missing header $h"
done
echo "$hdrs" | grep -qi '^x-relay-modalities: *text' || fail "x-relay-modalities should include text"
pass "response-header contract"

curl -fsS -N -X POST "$BASE/v1/chat/completions" -H "$AUTH" -H "$JSON" \
  -d '{"model":"gpt-4o","stream":true,"messages":[{"role":"user","content":"hi"}]}' \
  | grep -q 'data: \[DONE\]' || fail "stream completion terminator"; pass "stream completion"

# Control plane (/api/*): a missing/invalid Logto JWT is rejected 401 on every route group.
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/me")
[ "$code" = 401 ] || fail "control plane /api/v1/me should 401 without a JWT (got $code)"; pass "control-plane me 401"

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/platform/orgs")
[ "$code" = 401 ] || fail "control plane orgs list should 401 without a JWT (got $code)"; pass "control-plane orgs 401"

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/providers")
[ "$code" = 401 ] || fail "providers list should 401 without a JWT (got $code)"; pass "control-plane providers 401"

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/analytics/usage")
[ "$code" = 401 ] || fail "analytics usage should 401 without a JWT (got $code)"; pass "control-plane analytics 401"

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/audit")
[ "$code" = 401 ] || fail "audit list should 401 without a JWT (got $code)"; pass "control-plane audit 401"

echo "SMOKE OK"
