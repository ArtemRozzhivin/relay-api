#!/usr/bin/env bash
# A3 — every submitted job runs its side effect exactly once, even when the
# worker is killed mid-charge.
set -uo pipefail
FAILED=0
N=${N:-6}
DELAY_MS=${DELAY_MS:-10000}
KILL_AFTER=${KILL_AFTER:-3}
PSQL="docker exec relay-postgres psql -U relay -d relay -t -A"

npm run build >/dev/null 2>&1 || { echo "build failed"; exit 1; }
lsof -ti tcp:3000 | xargs -r kill -9 2>/dev/null
pkill -f "dist/worker.js" 2>/dev/null
sleep 1

node dist/main.js > /tmp/a3-api.log 2>&1 & API=$!
for i in $(seq 1 25); do curl -sf -o /dev/null http://localhost:3000/health 2>/dev/null && break; sleep 1; done

EMAIL="a3-$(date +%s)@example.com"
curl -s -o /dev/null -X POST localhost:3000/auth/register -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password123\"}"
TOKEN=$(curl -s -X POST localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password123\"}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['accessToken'])")
USER_ID=$($PSQL -c "SELECT id FROM \"User\" WHERE email='$EMAIL';")

echo "submitting $N charge jobs (delayMs=$DELAY_MS)…"
for i in $(seq 1 "$N"); do
  curl -s -o /dev/null -X POST localhost:3000/jobs \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -H "Idempotency-Key: a3-$i-$RANDOM" \
    -d "{\"type\":\"CHARGE\",\"payload\":{\"amountCents\":1000,\"reference\":\"inv-$i\",\"delayMs\":$DELAY_MS}}"
done

node dist/worker.js > /tmp/a3-worker1.log 2>&1 & W1=$!
sleep "$KILL_AFTER"
echo "SIGKILL the worker mid-charge…"
kill -9 $W1 2>/dev/null
sleep 1
LEDGER_AT_KILL=$($PSQL -c "SELECT count(*) FROM \"SideEffect\" se JOIN \"Job\" j ON j.id=se.\"jobId\" WHERE j.\"userId\"='$USER_ID';")
INTERRUPTED=$($PSQL -c "SELECT count(*) FROM \"Job\" WHERE \"userId\"='$USER_ID' AND status='RUNNING';")
echo "  ledger rows right after the kill : $LEDGER_AT_KILL"
echo "  jobs interrupted mid-charge      : $INTERRUPTED"

echo "restarting the worker…"
node dist/worker.js > /tmp/a3-worker2.log 2>&1 & W2=$!
for i in $(seq 1 90); do
  LEFT=$($PSQL -c "SELECT count(*) FROM \"Job\" WHERE \"userId\"='$USER_ID' AND status IN ('QUEUED','RUNNING');")
  [ "$LEFT" = "0" ] && break
  sleep 2
done

TERMINAL=$($PSQL -c "SELECT count(*) FROM \"Job\" WHERE \"userId\"='$USER_ID' AND status IN ('SUCCEEDED','DEAD_LETTERED');")
SUCCEEDED=$($PSQL -c "SELECT count(*) FROM \"Job\" WHERE \"userId\"='$USER_ID' AND status='SUCCEEDED';")
LEDGER=$($PSQL -c "SELECT count(*) FROM \"SideEffect\" se JOIN \"Job\" j ON j.id=se.\"jobId\" WHERE j.\"userId\"='$USER_ID';")

echo
echo "────────── A3 ──────────"
echo "  jobs submitted        : $N"
echo "  terminal jobs         : $TERMINAL"
echo "  succeeded jobs        : $SUCCEEDED"
echo "  ledger rows (charges) : $LEDGER"
echo "  interrupted mid-charge: $INTERRUPTED"
if [ "$INTERRUPTED" = "0" ]; then
  echo "  RESULT: INCONCLUSIVE — nothing was interrupted, so no redelivery happened."
  echo "          Raise DELAY_MS or lower KILL_AFTER."
elif [ "$LEDGER" -gt "$N" ]; then
  FAILED=1
  echo "  RESULT: FAIL — $((LEDGER - N)) duplicate charge(s); effectKey is not deduplicating"
  $PSQL -F' x ' -c "SELECT se.\"jobId\", count(*) FROM \"SideEffect\" se JOIN \"Job\" j ON j.id=se.\"jobId\" WHERE j.\"userId\"='$USER_ID' GROUP BY se.\"jobId\" HAVING count(*) > 1;" | sed 's/^/          doubled: /'
elif [ "$SUCCEEDED" = "$N" ] && [ "$LEDGER" = "$N" ]; then
  echo "  RESULT: PASS"
else
  FAILED=1
  echo "  RESULT: FAIL — lost work: $SUCCEEDED/$N succeeded, $LEDGER/$N charged"
  $PSQL -F' | ' -c "SELECT status, count(*) FROM \"Job\" WHERE \"userId\"='$USER_ID' GROUP BY status;" | sed 's/^/          /'
fi

kill -TERM $API $W2 2>/dev/null
# INCONCLUSIVE exits 0 on purpose: the run proved nothing, but nothing is broken.
exit $FAILED
