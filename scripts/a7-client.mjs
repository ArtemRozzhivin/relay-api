// A7 — the realtime contract. Pub/sub is at-most-once on purpose: an event sent
// while a client is away is gone for good, and the client's recovery is to
// re-read GET /jobs/:id. This asserts both halves, plus that the room is
// derived from the token rather than from anything the client asks for.
import { io } from 'socket.io-client';

const BASE = process.env.BASE ?? 'http://localhost:3000';
let failed = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => {
  console.log(`  ✗ ${m}`);
  failed = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (path, init = {}) => {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
};

const signUp = async (label) => {
  const email = `a7-${label}-${Date.now()}@example.com`;
  await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'password123' }),
  });
  const { body } = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'password123' }),
  });
  return body.data.accessToken;
};

const connect = (token) =>
  new Promise((resolve, reject) => {
    const socket = io(`${BASE}/events`, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (error) => reject(error));
  });

const submit = (token, payload) =>
  api('/jobs', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': `a7-${Math.random().toString(36).slice(2)}`,
    },
    body: JSON.stringify(payload),
  });

const waitFor = (events, predicate, ms) =>
  new Promise((resolve) => {
    const deadline = Date.now() + ms;
    const poll = setInterval(() => {
      const hit = events.find(predicate);
      if (hit || Date.now() > deadline) {
        clearInterval(poll);
        resolve(hit);
      }
    }, 100);
  });

console.log('── an unauthenticated socket is refused at the handshake');
for (const [label, token] of [
  ['no token', undefined],
  ['a forged token', 'not.a.jwt'],
]) {
  try {
    const socket = await connect(token);
    socket.close();
    fail(`${label} was accepted`);
  } catch (error) {
    ok(`${label} → ${error.message}`);
  }
}

const tokenA = await signUp('a');
const tokenB = await signUp('b');

console.log('\n── a connected client sees its own job move');
const socketA = await connect(tokenA);
const socketB = await connect(tokenB);
const seenA = [];
const seenB = [];
socketA.on('job.updated', (job) => seenA.push(job));
socketB.on('job.updated', (job) => seenB.push(job));

const { body } = await submit(tokenA, {
  type: 'MOCK',
  payload: { durationMs: 8000, failureRate: 0 },
});
const jobId = body.data.id;
console.log(`   job = ${jobId}`);

const queued = await waitFor(seenA, (j) => j.id === jobId && j.status === 'QUEUED', 5000);
queued ? ok('QUEUED event arrived from the API process') : fail('no QUEUED event');

const running = await waitFor(seenA, (j) => j.id === jobId && j.status === 'RUNNING', 15000);
running
  ? ok('RUNNING event crossed the process boundary from the worker')
  : fail('no RUNNING event — the worker→Redis→API bridge is broken');

console.log('\n── the other tenant saw none of it');
seenB.some((j) => j.id === jobId)
  ? fail("user B received user A's job events")
  : ok('user B received nothing for a job it does not own');

console.log('\n── drop the socket mid-processing, finish the job while it is away');
socketA.close();
const before = seenA.length;

let terminal;
for (let i = 0; i < 60; i += 1) {
  const { body: polled } = await api(`/jobs/${jobId}`, {
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  if (['SUCCEEDED', 'DEAD_LETTERED'].includes(polled.data.status)) {
    terminal = polled.data.status;
    break;
  }
  await sleep(1000);
}
terminal ? ok(`the job reached ${terminal} while no socket was listening`) : fail('job never finished');

console.log('\n── reconnect and reconcile');
const reconnected = await connect(tokenA);
const seenAfter = [];
reconnected.on('job.updated', (job) => seenAfter.push(job));
await sleep(2000);

seenA.length === before
  ? ok('the terminal event was never delivered — at-most-once, as designed')
  : fail('the closed socket somehow received events');
seenAfter.some((j) => j.id === jobId)
  ? fail('a replayed event arrived on reconnect; pub/sub must not buffer')
  : ok('no event is replayed on reconnect');

const { body: reconciled } = await api(`/jobs/${jobId}`, {
  headers: { Authorization: `Bearer ${tokenA}` },
});
reconciled.data.status === terminal
  ? ok(`GET /jobs/:id reconciles the client to ${terminal}`)
  : fail(`reconciliation returned ${reconciled.data.status}, expected ${terminal}`);

reconnected.close();
socketB.close();

console.log(failed ? '\n  RESULT: FAIL' : '\n  RESULT: PASS');
process.exit(failed);
