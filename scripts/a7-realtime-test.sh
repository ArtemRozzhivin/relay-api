#!/usr/bin/env bash
# A7 — realtime contract: events cross the worker→API boundary, are scoped to
# the owner's room, are never replayed, and a client that misses them recovers
# by re-reading the job.
set -uo pipefail
npm run build >/dev/null 2>&1 || { echo "build failed"; exit 1; }
lsof -ti tcp:3000 | xargs -r kill -9 2>/dev/null; pkill -f "dist/worker.js" 2>/dev/null; sleep 1

node dist/main.js   > /tmp/a7-api.log    2>&1 & API=$!
node dist/worker.js > /tmp/a7-worker.log 2>&1 & WRK=$!
for i in $(seq 1 25); do curl -sf -o /dev/null http://localhost:3000/health 2>/dev/null && break; sleep 1; done

echo "────────── A7 ──────────"
node scripts/a7-client.mjs
RESULT=$?

kill -TERM $API $WRK 2>/dev/null
exit $RESULT
