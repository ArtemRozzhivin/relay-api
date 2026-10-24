#!/usr/bin/env bash
# A5 — a job that always fails exhausts its attempts, dead-letters exactly once,
# and does not return to QUEUED on its own. A re-drive runs it again; re-driving
# anything that is not dead-lettered is refused.
set -uo pipefail
PSQL="docker exec relay-postgres psql -U relay -d relay -t -A"
FAILED=0
ok()   { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; FAILED=1; }

await_status() {
  local jid=$1 want=$2 tries=${3:-60}
  for _ in $(seq 1 "$tries"); do
    [ "$($PSQL -c "SELECT status FROM \"Job\" WHERE id='$jid';")" = "$want" ] && return 0
    sleep 1
  done
  return 1
}

npm run build >/dev/null 2>&1 || { echo "build failed"; exit 1; }
lsof -ti tcp:3000 | xargs -r kill -9 2>/dev/null; pkill -f "dist/worker.js" 2>/dev/null; sleep 1

node dist/main.js   > /tmp/a5-api.log    2>&1 & API=$!
node dist/worker.js > /tmp/a5-worker.log 2>&1 & WRK=$!
for i in $(seq 1 25); do curl -sf -o /dev/null http://localhost:3000/health 2>/dev/null && break; sleep 1; done

EMAIL="a5-$(date +%s)@example.com"
curl -s -o /dev/null -X POST localhost:3000/auth/register -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"password123\"}"
TOKEN=$(curl -s -X POST localhost:3000/auth/login -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"password123\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['accessToken'])")

echo "submitting a job that always fails, maxAttempts=3…"
JID=$(curl -s -X POST localhost:3000/jobs -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H "Idempotency-Key: a5-$RANDOM" \
  -d '{"type":"MOCK","payload":{"durationMs":1,"failureRate":1},"maxAttempts":3}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['id'])")

await_status "$JID" DEAD_LETTERED || true

echo
echo "────────── A5 ──────────"
read -r STATUS ATTEMPTS MAXA CODE <<<"$($PSQL -F' ' -c "SELECT status, attempts, \"maxAttempts\", coalesce(error->>'code','-') FROM \"Job\" WHERE id='$JID';")"
echo "  status|attempts|max|code: $STATUS | $ATTEMPTS | $MAXA | $CODE"
echo "  attempt log from the worker:"
grep -oE "attempt [0-9]+/[0-9]+ failed, will retry|dead-lettered after [0-9]+ attempt" /tmp/a5-worker.log | sed 's/^/    /'
RETRIES=$(grep -cE "attempt [0-9]+/[0-9]+ failed, will retry" /tmp/a5-worker.log)
DEADLINES=$(grep -cE "dead-lettered after [0-9]+ attempt" /tmp/a5-worker.log)

echo
[ "$STATUS" = "DEAD_LETTERED" ] && ok "ended DEAD_LETTERED" || fail "ended $STATUS, expected DEAD_LETTERED"
[ "$ATTEMPTS" = "3" ]          && ok "stopped after exactly 3 attempts" || fail "attempts=$ATTEMPTS, expected 3"
[ "$CODE" = "ATTEMPTS_EXHAUSTED" ] && ok "recorded why it died" || fail "error code is '$CODE', expected ATTEMPTS_EXHAUSTED"
[ "$RETRIES" = "2" ]           && ok "retried twice before giving up" || fail "saw $RETRIES retry log line(s), expected 2"
[ "$DEADLINES" = "1" ]         && ok "dead-lettered exactly once"     || fail "saw $DEADLINES dead-letter log line(s), expected 1"

echo
echo "── re-drive it"
RETRY=$(curl -s -o /tmp/a5-retry.json -w '%{http_code}' -X POST "localhost:3000/jobs/$JID/retry" -H "Authorization: Bearer $TOKEN")
RSTATUS=$(python3 -c "import json;d=json.load(open('/tmp/a5-retry.json'));print(d.get('data',{}).get('status','-'))" 2>/dev/null || echo '-')
RATTEMPTS=$(python3 -c "import json;d=json.load(open('/tmp/a5-retry.json'));print(d.get('data',{}).get('attempts','-'))" 2>/dev/null || echo '-')
echo "   HTTP $RETRY  status=$RSTATUS attempts=$RATTEMPTS"
[ "$RETRY" = "202" ] && ok "re-drive accepted (202)" || fail "re-drive returned HTTP $RETRY, expected 202"
[ "$RSTATUS" = "QUEUED" ] && ok "back to QUEUED" || fail "re-drive left it $RSTATUS"
[ "$RATTEMPTS" = "0" ]    && ok "attempt counter reset" || fail "attempts=$RATTEMPTS after re-drive, expected 0"

await_status "$JID" DEAD_LETTERED || true
read -r STATUS2 ATTEMPTS2 <<<"$($PSQL -F' ' -c "SELECT status, attempts FROM \"Job\" WHERE id='$JID';")"
echo "   after the re-driven run: $STATUS2 | $ATTEMPTS2"
[ "$STATUS2" = "DEAD_LETTERED" ] && ok "the re-driven run really ran and died again" || fail "after re-drive it is $STATUS2"
[ "$ATTEMPTS2" = "3" ]           && ok "and spent a fresh budget of 3"              || fail "attempts=$ATTEMPTS2, expected 3"

echo
echo "── re-drive a job that is NOT dead-lettered → expect 409"
OK=$(curl -s -X POST localhost:3000/jobs -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H "Idempotency-Key: ok-$RANDOM" -d '{"type":"MOCK","payload":{"durationMs":1}}' | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['id'])")
await_status "$OK" SUCCEEDED || true
GUARD=$(curl -s -o /tmp/a5-guard.json -w '%{http_code}' -X POST "localhost:3000/jobs/$OK/retry" -H "Authorization: Bearer $TOKEN")
GCODE=$(python3 -c "import json;d=json.load(open('/tmp/a5-guard.json'));print(d.get('error',{}).get('code','-'))" 2>/dev/null || echo '-')
echo "   HTTP $GUARD  $GCODE"
[ "$GUARD" = "409" ] && ok "refused with 409" || fail "expected HTTP 409, got $GUARD"
[ "$GCODE" = "JOB_NOT_DEAD_LETTERED" ] && ok "with the right error code" || fail "error code is '$GCODE'"

echo
[ "$FAILED" = "0" ] && echo "  RESULT: PASS" || echo "  RESULT: FAIL"
kill -TERM $API $WRK 2>/dev/null
exit $FAILED
