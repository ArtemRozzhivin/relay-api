#!/usr/bin/env bash
# A3b — a worker that loses a job while still running it must not write over
# whoever holds it now. Without the attempt-ownership check, the stale worker's
# requeueForRetry() puts a row back to QUEUED under the live worker, the live
# worker's succeed() is then refused, and the row is stranded QUEUED with its
# queue entry already completed: nothing redelivers it, /retry refuses it, and
# for a CHARGE job the money has already moved.
set -uo pipefail
PSQL="docker exec relay-postgres psql -U relay -d relay -t -A"
REDIS="docker exec relay-redis redis-cli"
Q=bull:relay-jobs
N=${N:-6}
D=${D:-10000}
DRAIN_TIMEOUT=${DRAIN_TIMEOUT:-300}
export WORKER_CONCURRENCY=8
FAILED=0
ok()   { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; FAILED=1; }

npm run build >/dev/null 2>&1 || { echo "build failed"; exit 1; }
lsof -ti tcp:3000 | xargs -r kill -9 2>/dev/null; pkill -f "dist/worker.js" 2>/dev/null; sleep 1

node dist/main.js > /tmp/sw-api.log 2>&1 & API=$!
for i in $(seq 1 25); do curl -sf -o /dev/null http://localhost:3000/health 2>/dev/null && break; sleep 1; done

EMAIL="sw-$(date +%s)@example.com"
curl -s -o /dev/null -X POST localhost:3000/auth/register -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"password123\"}"
TOKEN=$(curl -s -X POST localhost:3000/auth/login -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"password123\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['accessToken'])")
USER_ID=$($PSQL -c "SELECT id FROM \"User\" WHERE email='$EMAIL';")

echo "submitting $N jobs that take ${D}ms and fail half the time, maxAttempts=5…"
for i in $(seq 1 "$N"); do
  curl -s -o /dev/null -X POST localhost:3000/jobs -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -H "Idempotency-Key: sw-$i-$RANDOM" \
    -d "{\"type\":\"MOCK\",\"payload\":{\"durationMs\":$D,\"failureRate\":0.5},\"maxAttempts\":5}"
done

echo "— W1 claims them all"
node dist/worker.js > /tmp/sw-w1.log 2>&1 & W1=$!
for i in $(seq 1 60); do
  [ "$($PSQL -c "SELECT count(*) FROM \"Job\" WHERE \"userId\"='$USER_ID' AND attempts=1;")" = "$N" ] && break
  sleep 1
done

echo "— freeze W1 near the end of its handlers and expire its locks"
sleep $(( D/1000 - 6 ))
kill -STOP $W1
for J in $($PSQL -c "SELECT id FROM \"Job\" WHERE \"userId\"='$USER_ID';"); do
  OID=$($PSQL -c "SELECT id FROM \"Outbox\" WHERE \"jobId\"='$J' ORDER BY id DESC LIMIT 1;")
  $REDIS DEL "$Q:$J.$OID:lock" > /dev/null
done

echo "— W2 takes them over via the stalled checker"
node dist/worker.js > /tmp/sw-w2.log 2>&1 & W2=$!
for i in $(seq 1 90); do
  RECLAIMED=$($PSQL -c "SELECT count(*) FROM \"Job\" WHERE \"userId\"='$USER_ID' AND attempts=2;")
  [ "$RECLAIMED" = "$N" ] && break
  sleep 1
done
echo "  W2 reclaimed $RECLAIMED/$N"

echo "— thaw W1: its writes now target rows it no longer owns"
kill -CONT $W1

# Drain is the discriminator, not a fixed wait. A row the stale worker stranded
# is QUEUED with its queue entry already finished: nothing redelivers it and it
# never becomes terminal, so a generous poll separates "stranded" from "still
# retrying" without guessing how many retries a 50%-failure job will need.
echo "— waiting up to ${DRAIN_TIMEOUT}s for every job to reach a terminal state"
for i in $(seq 1 "$DRAIN_TIMEOUT"); do
  LEFT=$($PSQL -c "SELECT count(*) FROM \"Job\" WHERE \"userId\"='$USER_ID' AND status IN ('QUEUED','RUNNING');")
  [ "$LEFT" = "0" ] && break
  sleep 1
done
echo "  non-terminal after the wait: $LEFT"

STRANDED=$($PSQL -c "SELECT count(*) FROM \"Job\" WHERE \"userId\"='$USER_ID' AND status NOT IN ('SUCCEEDED','DEAD_LETTERED');")
TERMINAL=$($PSQL -c "SELECT count(*) FROM \"Job\" WHERE \"userId\"='$USER_ID' AND status IN ('SUCCEEDED','DEAD_LETTERED');")
REFUSED=$(grep -hc "no longer owns it" /tmp/sw-w1.log /tmp/sw-w2.log 2>/dev/null | paste -sd+ - | bc)

echo
echo "────────── A3b ──────────"
$PSQL -F' | ' -c "SELECT status, count(*) FROM \"Job\" WHERE \"userId\"='$USER_ID' GROUP BY status;" | sed 's/^/  /'
echo "  stale writes refused by the ownership check: $REFUSED"
if [ "$STRANDED" != "0" ]; then
  echo "  rows still non-terminal (wait/active/delayed = a live queue entry, all blank = stranded):"
  for J in $($PSQL -c "SELECT id FROM \"Job\" WHERE \"userId\"='$USER_ID' AND status NOT IN ('SUCCEEDED','DEAD_LETTERED');"); do
    OID=$($PSQL -c "SELECT id FROM \"Outbox\" WHERE \"jobId\"='$J' ORDER BY id DESC LIMIT 1;")
    echo "    $J $($PSQL -c "SELECT status FROM \"Job\" WHERE id='$J';") — waitPos=$($REDIS LPOS $Q:wait "$J.$OID" | tr -d '\r') activePos=$($REDIS LPOS $Q:active "$J.$OID" | tr -d '\r') delayed=$($REDIS ZSCORE $Q:delayed "$J.$OID" | tr -d '\r') completed=$($REDIS ZSCORE $Q:completed "$J.$OID" | tr -d '\r') /retry→$(curl -s -o /dev/null -w '%{http_code}' -X POST "localhost:3000/jobs/$J/retry" -H "Authorization: Bearer $TOKEN")"
  done
fi
echo

if [ "$RECLAIMED" != "$N" ] || [ "${REFUSED:-0}" = "0" ]; then
  echo "  RESULT: INCONCLUSIVE — the stale interleaving did not happen"
  echo "          (reclaimed $RECLAIMED/$N, $REFUSED refused writes). Raise D."
  kill -CONT $W1 2>/dev/null; kill -9 $W1 $W2 2>/dev/null; kill -TERM $API 2>/dev/null
  exit 0
fi
ok "the stale worker really did try to write over the live one ($REFUSED refused)"
[ "$STRANDED" = "0" ] && ok "every job drained to a terminal state; none was stranded" \
                      || fail "$STRANDED row(s) never drained in ${DRAIN_TIMEOUT}s"
[ "$TERMINAL" = "$N" ] && ok "all $N jobs reached a terminal state" || fail "only $TERMINAL/$N terminal"

echo
[ "$FAILED" = "0" ] && echo "  RESULT: PASS" || echo "  RESULT: FAIL"
kill -CONT $W1 2>/dev/null; kill -9 $W1 $W2 2>/dev/null; kill -TERM $API 2>/dev/null
exit $FAILED
