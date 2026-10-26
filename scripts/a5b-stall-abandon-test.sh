#!/usr/bin/env bash
# A5b — A5's claim extended to the one failure the queue handles itself: a job
# that stalls past maxStalledCount is failed by BullMQ WITHOUT process() ever
# running again (see §7.6). It must still reach a terminal state that says why,
# and the operator must still be able to re-drive it — really re-drive it, not
# just receive a 202.
set -uo pipefail
PSQL="docker exec relay-postgres psql -U relay -d relay -t -A"
REDIS="docker exec relay-redis redis-cli"
Q=bull:relay-jobs
FAILED=0
ok()   { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; FAILED=1; }

newest_message () {  # the queue entry is keyed by the Outbox row, not the job
  echo "$1.$($PSQL -c "SELECT id FROM \"Outbox\" WHERE \"jobId\"='$1' ORDER BY id DESC LIMIT 1;")"
}

npm run build >/dev/null 2>&1 || { echo "build failed"; exit 1; }
lsof -ti tcp:3000 | xargs -r kill -9 2>/dev/null; pkill -f "dist/worker.js" 2>/dev/null; sleep 1

node dist/main.js > /tmp/sa-api.log 2>&1 & API=$!
for i in $(seq 1 25); do curl -sf -o /dev/null http://localhost:3000/health 2>/dev/null && break; sleep 1; done

EMAIL="sa-$(date +%s)@example.com"
curl -s -o /dev/null -X POST localhost:3000/auth/register -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"password123\"}"
TOKEN=$(curl -s -X POST localhost:3000/auth/login -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"password123\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['accessToken'])")

JID=$(curl -s -X POST localhost:3000/jobs -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H "Idempotency-Key: sa-$RANDOM" \
  -d '{"type":"MOCK","payload":{"durationMs":60000,"failureRate":0},"maxAttempts":5}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['id'])")
MSG=$(newest_message "$JID")
echo "job = $JID  (maxAttempts=5, so the retry budget is never the thing that stops it)"
echo "queue entry = $MSG"

cycle () {
  local n=$1
  node dist/worker.js > "/tmp/sa-worker$n.log" 2>&1 & local W=$!
  for i in $(seq 1 60); do
    A=$($PSQL -c "SELECT attempts||'/'||status FROM \"Job\" WHERE id='$JID';")
    [ "${A%%/*}" = "$n" ] && break
    sleep 1
  done
  echo "  after delivery $n: db=$A  stalledCount=$($REDIS HGET $Q:$MSG stc | tr -d '\r')"
  kill -9 $W 2>/dev/null
  sleep 1
  # SIGKILL leaves the lock behind with a 30s TTL; deleting it does exactly what
  # that expiry does, and is what lets the stalled checker see the job.
  $REDIS DEL "$Q:$MSG:lock" > /dev/null
}

echo "— delivery 1, then SIGKILL mid-handler"
cycle 1
echo "— delivery 2 (the stalled redelivery), then SIGKILL mid-handler again"
cycle 2

echo "— third worker: nothing left to interrupt it, the queue should abandon the job"
node dist/worker.js > /tmp/sa-worker3.log 2>&1 & W3=$!
for i in $(seq 1 60); do
  [ "$($PSQL -c "SELECT status FROM \"Job\" WHERE id='$JID';")" = "DEAD_LETTERED" ] && break
  sleep 1
done
sleep 2

read -r STATUS ATTEMPTS CODE <<<"$($PSQL -F' ' -c "SELECT status, attempts, coalesce(error->>'code','-') FROM \"Job\" WHERE id='$JID';")"
DELIVERIES=$(grep -ho "Running job $JID (MOCK) attempt [0-9]*/[0-9]*" /tmp/sa-worker*.log | wc -l | tr -d ' ')

echo
echo "────────── A5b ──────────"
echo "  job row            : $STATUS | attempts=$ATTEMPTS | code=$CODE"
echo "  stalledCount       : $($REDIS HGET $Q:$MSG stc | tr -d '\r')"
echo "  queue failedReason : $($REDIS HGET $Q:$MSG failedReason | tr -d '\r')"
echo "  deliveries seen by process():"
grep -ho "Running job $JID (MOCK) attempt [0-9]*/[0-9]*" /tmp/sa-worker*.log | sed 's/^/    /'
echo

if [ "$DELIVERIES" -lt 2 ] 2>/dev/null; then
  echo "  RESULT: INCONCLUSIVE — only $DELIVERIES delivery/deliveries; the stall was never exercised."
  kill -TERM $API $W3 2>/dev/null
  exit 0
fi
[ "$DELIVERIES" = "2" ] && ok "the queue abandoned the job after exactly 2 deliveries, below its budget of 5" \
                        || fail "process() ran $DELIVERIES times; an abandoned job must not be delivered again"
[ "$STATUS" = "DEAD_LETTERED" ] && ok "the row still reached a terminal state" \
                               || fail "row is $STATUS — abandoned by the queue and never finalised"
[ "$CODE" = "DELIVERY_ABANDONED" ] && ok "and records why ($CODE)" || fail "error code is '$CODE', expected DELIVERY_ABANDONED"

echo
echo "— can the operator recover it through the API?"
RETRY=$(curl -s -o /tmp/sa-retry.json -w '%{http_code}' -X POST "localhost:3000/jobs/$JID/retry" -H "Authorization: Bearer $TOKEN")
RSTATUS=$(python3 -c "import json;d=json.load(open('/tmp/sa-retry.json'));print(d.get('data',{}).get('status','-'))" 2>/dev/null || echo '-')
echo "   HTTP $RETRY  status=$RSTATUS"
[ "$RETRY" = "202" ] && [ "$RSTATUS" = "QUEUED" ] && ok "re-drive accepted" || fail "re-drive returned HTTP $RETRY ($RSTATUS)"

# A 202 is not evidence: a re-drive that silently enqueued nothing returns the
# same body. Only a delivery proves it, so wait for the worker to claim it.
REMSG=$(newest_message "$JID")
for i in $(seq 1 30); do
  [ "$($PSQL -c "SELECT attempts FROM \"Job\" WHERE id='$JID';")" != "0" ] && break
  sleep 1
done
read -r RESTATUS REATTEMPTS <<<"$($PSQL -F' ' -c "SELECT status, attempts FROM \"Job\" WHERE id='$JID';")"
echo "   re-driven entry = $REMSG → $RESTATUS | attempts=$REATTEMPTS"
[ "$REMSG" != "$MSG" ] && ok "the re-drive got its own queue entry" || fail "the re-drive reused the abandoned entry ($MSG)"
[ "$REATTEMPTS" != "0" ] && ok "and was really delivered to a worker" \
                         || fail "nothing ever claimed it — the re-drive enqueued nothing"

echo
[ "$FAILED" = "0" ] && echo "  RESULT: PASS" || echo "  RESULT: FAIL"
kill -TERM $API $W3 2>/dev/null
exit $FAILED
