#!/usr/bin/env bash
# A6 — a crash between the commit and the enqueue must not strand the job: the
# outbox relay has to pick it up and run it exactly once.
set -uo pipefail
PSQL="docker exec relay-postgres psql -U relay -d relay -t -A"
REDIS="docker exec relay-redis redis-cli"
FAILED=0
ok()   { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; FAILED=1; }

npm run build >/dev/null 2>&1 || { echo "build failed"; exit 1; }
lsof -ti tcp:3000 | xargs -r kill -9 2>/dev/null; pkill -f "dist/worker.js" 2>/dev/null; sleep 1

RELAY_FAULT_AFTER_COMMIT=1 node dist/main.js > /tmp/a6-api.log 2>&1 & API=$!
node dist/worker.js > /tmp/a6-worker.log 2>&1 & WRK=$!
for i in $(seq 1 25); do curl -sf -o /dev/null http://localhost:3000/health 2>/dev/null && break; sleep 1; done

EMAIL="a6-$(date +%s)@example.com"
curl -s -o /dev/null -X POST localhost:3000/auth/register -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"password123\"}"
TOKEN=$(curl -s -X POST localhost:3000/auth/login -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"password123\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['accessToken'])")
USER_ID=$($PSQL -c "SELECT id FROM \"User\" WHERE email='$EMAIL';")

echo "submitting with the fault enabled…"
CODE=$(curl -s -o /tmp/a6.json -w '%{http_code}' -X POST localhost:3000/jobs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H "Idempotency-Key: a6-$RANDOM" \
  -d '{"type":"CHARGE","payload":{"amountCents":100,"reference":"gap"}}')
echo "  HTTP $CODE  $(python3 -c "import json;d=json.load(open('/tmp/a6.json'));print(d['error']['code'])" 2>/dev/null)"

echo "  waiting for the outbox relay…"
sleep 8
JID=$($PSQL -c "SELECT id FROM \"Job\" WHERE \"userId\"='$USER_ID';")
STATUS=$($PSQL -c "SELECT status FROM \"Job\" WHERE id='$JID';")
OID=$($PSQL -c "SELECT id FROM \"Outbox\" WHERE \"jobId\"='$JID' ORDER BY id DESC LIMIT 1;")
INQ=$($REDIS EXISTS "bull:relay-jobs:$JID.$OID" | tr -d '\r')
LEDGER=$($PSQL -c "SELECT count(*) FROM \"SideEffect\" WHERE \"jobId\"='$JID';")
UNPUBLISHED=$($PSQL -c "SELECT count(*) FROM \"Outbox\" WHERE \"jobId\"='$JID' AND \"publishedAt\" IS NULL;")
RELAY_PUBLISHED=$($PSQL -c "SELECT coalesce(max(attempts),0) FROM \"Outbox\" WHERE \"jobId\"='$JID';")

echo
echo "────────── A6 ──────────"
echo "  job row in Postgres  : $STATUS"
echo "  entry in Redis queue : $INQ  (1 = present, 0 = missing)"
echo "  ledger rows          : $LEDGER"
echo "  unpublished outbox   : $UNPUBLISHED"
echo "  relay publish count  : $RELAY_PUBLISHED  (>0 = the relay did the enqueue, not submit())"
echo
# The fault has to have fired, or the inline enqueue would satisfy everything
# below and the test would pass without the outbox being involved at all.
[ "$CODE" = "500" ] && ok "submit() failed after the commit (HTTP 500)" \
                    || fail "expected HTTP 500 from the injected fault, got $CODE — is RELAY_FAULT_AFTER_COMMIT reaching the API?"
# Only the relay increments Outbox.attempts; markPublished() never does.
[ "$RELAY_PUBLISHED" -ge 1 ] 2>/dev/null && ok "the relay published the stranded row" \
                                         || fail "the relay never published anything (attempts=$RELAY_PUBLISHED)"
[ "$STATUS" = "SUCCEEDED" ] && ok "the job ran and succeeded" || fail "job is $STATUS, expected SUCCEEDED"
[ "$LEDGER" = "1" ]        && ok "charged exactly once"       || fail "ledger has $LEDGER rows, expected 1"
[ "$UNPUBLISHED" = "0" ]   && ok "no outbox backlog left"     || fail "$UNPUBLISHED unpublished outbox row(s) left"

echo
if [ "$FAILED" = "0" ]; then
  echo "  RESULT: PASS — the relay recovered the stranded job and it ran exactly once"
else
  echo "  RESULT: FAIL"
fi
kill -TERM $API $WRK 2>/dev/null
exit $FAILED
