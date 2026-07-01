#!/usr/bin/env bash
# Smoke tests for agent-dock auth + rate-limit behavior.
# Starts server.js in test mode (rate limits off, sandbox data dir), then
# exercises a representative subset of endpoints.
set -euo pipefail

cd "$(dirname "$0")/.."

LOG_TMP="$(mktemp -d)"
trap "rm -rf '$LOG_TMP'" EXIT

export HERMES_API_TOKEN="smoke-test-$(date +%s)"
export HERMES_RATE_LIMIT="off"

# Sandbox the only FS paths the server touches outside /tmp
export PORT="17999"
# Replace /data and /root/.config references? Not feasible — server hardcodes /data.
# But server uses try/catch on those paths, and rate-limit-off keeps stateful
# modules happy. Spawn a real-ish process.
node ./server.js > "$LOG_TMP/server.log" 2>&1 &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap "cleanup; rm -rf '$LOG_TMP'" EXIT

# Wait for the listener
for _ in $(seq 1 50); do
  if curl -sS -o /dev/null "http://127.0.0.1:${PORT}/api/status"; then
    break
  fi
  sleep 0.2
done

BASE="http://127.0.0.1:${PORT}"
TOKEN="$HERMES_API_TOKEN"

pass=0; fail=0
check() {
  local name="$1"; local expected="$2"; local actual="$3"
  if [ "$expected" = "$actual" ]; then
    pass=$((pass+1))
    printf "  PASS  %s  (%s)\n" "$name" "$actual"
  else
    fail=$((fail+1))
    printf "  FAIL  %s  expected=%s got=%s\n" "$name" "$expected" "$actual"
  fi
}

status() { curl -sS -o /dev/null -w "%{http_code}" "$@"; }

echo "── Public status ──"
check "GET /api/status (public)"        "200" "$(status "$BASE/api/status")"

echo "── Auth required ──"
check "GET /api/sessions no token"      "401" "$(status "$BASE/api/sessions")"
check "GET /api/sessions wrong token"   "403" "$(status -H "Authorization: Bearer bogus" "$BASE/api/sessions")"
check "GET /api/sessions right token"   "200" "$(status -H "Authorization: Bearer $TOKEN" "$BASE/api/sessions")"

check "GET /api/logs no token"          "401" "$(status "$BASE/api/logs")"
check "GET /api/logs right token"       "200" "$(status -H "Authorization: Bearer $TOKEN" "$BASE/api/logs")"
check "GET /api/logs/daemon right tok"  "200" "$(status -H "Authorization: Bearer $TOKEN" "$BASE/api/logs/daemon")"
check "GET /api/logs/remote right tok"  "200" "$(status -H "Authorization: Bearer $TOKEN" "$BASE/api/logs/remote")"
check "GET /api/diagnostics no tok"     "401" "$(status "$BASE/api/diagnostics")"
check "GET /api/diagnostics right tok"  "200" "$(status -H "Authorization: Bearer $TOKEN" "$BASE/api/diagnostics")"
check "GET /api/relay-check no tok"     "401" "$(status "$BASE/api/relay-check")"

echo "── Write endpoints (auth + writeLimiter) ──"
check "POST /api/spin-up no token"      "401" "$(status -X POST "$BASE/api/spin-up")"
check "POST /api/spin-up empty body"    "400" "$(status -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' "$BASE/api/spin-up")"
check "POST /api/spin-up no branch"     "400" "$(status -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"repo_url":"https://example.com/x.git"}' "$BASE/api/spin-up")"
check "POST /api/spin-up empty branch"  "400" "$(status -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"repo_url":"https://example.com/x.git","branch":"   "}' "$BASE/api/spin-up")"
check "POST /api/spin-up bad branch chars" "400" "$(status -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"repo_url":"https://example.com/x.git","branch":"bad branch with spaces"}' "$BASE/api/spin-up")"
check "POST /api/spin-up bad ref ('..')"     "400" "$(status -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"repo_url":"https://example.com/x.git","branch":"feature..bad"}' "$BASE/api/spin-up")"
check "POST /api/spin-up bad URL no-.git"   "400" "$(status -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"repo_url":"https://example.com/no-suffix","branch":"main"}' "$BASE/api/spin-up")"
check "POST /api/spin-up valid .git+branch → 500 (clone fails)" "500" "$(status -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"repo_url":"https://example.com/nope.git","branch":"main"}' "$BASE/api/spin-up")"

# Show the human-readable error so we know WHY 400s are firing
echo
echo "── Error message spot-check (last 400 body each) ──"
for body in '{}' \
            '{"repo_url":"https://example.com/x.git"}' \
            '{"repo_url":"https://example.com/x.git","branch":"bad branch"}' \
            '{"repo_url":"https://example.com/x.git","branch":"feature..bad"}' \
            '{"repo_url":"https://example.com/no-suffix","branch":"main"}'; do
  msg=$(curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
              -d "$body" "$BASE/api/spin-up" | jq -r '.error // "(no error field)"' 2>/dev/null)
  printf "  body=%-72s → %s\n" "$body" "$msg"
done

check "POST /api/kill no token"         "401" "$(status -X POST "$BASE/api/kill/aa")"
check "POST /api/kill baddies"          "404" "$(status -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/kill/nope")"
check "POST /api/sessions/.../continue no token" "401" "$(status -X POST "$BASE/api/sessions/aa/continue")"

echo "── /api/status exposes security metadata ──"
SEC_META=$(curl -sS "$BASE/api/status")
if echo "$SEC_META" | grep -q '"token_required":true'; then
  pass=$((pass+1)); echo "  PASS  api_security.token_required=true"
else
  fail=$((fail+1)); echo "  FAIL  api_security.token_required missing — got: $SEC_META"
fi
if echo "$SEC_META" | grep -q '"token_autogenerated":false'; then
  pass=$((pass+1)); echo "  PASS  api_security.token_autogenerated=false (env-supplied)"
else
  fail=$((fail+1)); echo "  FAIL  token_autogenerated missing/wrong — got: $SEC_META"
fi
if echo "$SEC_META" | grep -q '"rate_limits": "disabled"\|"rate_limits":"disabled"\|"read_endpoints"'; then
  pass=$((pass+1)); echo "  PASS  rate_limits surfaced"
else
  fail=$((fail+1)); echo "  FAIL  rate_limits missing — got: $SEC_META"
fi

echo
echo "── Summary: ${pass} pass, ${fail} fail ──"
[ "$fail" -eq 0 ]
