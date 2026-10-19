# Relay — Technical Specification

**Version:** 0.1 (draft) · **Date:** 2026-09-01 · **Status:** pre-implementation

An async job-processing API. Clients submit jobs that are too slow or too important to run
inside a request; a fleet of workers processes them in the background; clients watch progress
in realtime over a WebSocket.

**v1 is phases 1–11.** Sections 1–14 specify phases 1–7 in full. Phases 8–11 are in scope with
their objectives fixed in §15; their detail is written at the start of each phase, when the
measurements they depend on exist.

Sections marked **DECISION** carry the options considered and their consequences. Each is
stamped **RESOLVED** or **DEFERRED — phase N** with the trigger that will force it; §16 indexes
both. A deferred decision is open by design: the phase that forces it is also the phase that
supplies the evidence to settle it.

---

## 1. The invariant

> **Every submitted job runs to completion exactly once — even when a worker crashes mid-job,
> the network drops, or the client retries the same request.**

Stated so it can be falsified:

> For **N** submissions carrying **K** distinct idempotency keys, when the queue has drained:
> exactly **K** `Job` rows exist, exactly **K** jobs are in a terminal state, and the
> side-effect ledger contains exactly **K** rows — regardless of how many workers were killed
> during the run.

Every rule below exists to serve that sentence. A design choice that does not defend it is
scope, not architecture.

**The two things that make it hard**, and which no `try/catch` inside a request can fix:

1. **Work must leave the request lifecycle**, so it can outlive the connection and survive
   process death.
2. **A queue only guarantees at-least-once delivery.** BullMQ will redeliver a job whose worker
   died. It does not promise exactly-once — that is this application's job, and the tool for it
   is the database's unique constraint, not the queue.

The governing principle: *the database is the guarantee; application logic is only the
coordinator.* A unique constraint is what prevents a card being charged twice — not the care
taken by the code around it.

---

## 2. Scope and non-goals

### In scope for v1

- User registration and login; JWT access tokens with refresh-token rotation.
- Submit a job (`202 Accepted`), read one, list your own.
- A worker process, separate from the API, consuming a Redis-backed BullMQ queue.
- Idempotency at both the submit boundary and the side-effect boundary.
- Retries with exponential backoff and jitter; a dead-letter path.
- Realtime `job.updated` events over a WebSocket, authenticated on connect.
- Liveness and readiness endpoints for both processes.
- Prometheus metrics, rate limiting, and HTTP hardening.
- An automated test suite covering the reliability assertions, running in CI.
- A load test that holds the invariant under contention, with numeric targets.
- A hand-provisioned VPS deployment behind Caddy, on a real domain over HTTPS.

### Job types in v1

Only two, both deliberately fake — the *machinery* is the subject, not the work:

| Type | Behaviour | Why it exists |
|---|---|---|
| `MOCK` | `await sleep(payload.durationMs)`, then fail with probability `payload.failureRate` | Drives the queue, retries, backoff, and the dead-letter path deterministically |
| `CHARGE` | Writes one row to the side-effect ledger, logs "charged". No gateway, no network | The job whose double-execution is observably wrong — the subject of A1/A3 |

`MOCK` must `await`, never spin. A CPU-blocking processor starves the event loop, fails to renew
its BullMQ lock, and stalls itself — a self-inflicted redelivery that invalidates every
reliability measurement (§7.6).

### Explicit non-goals (v2)

Real payment or email side effects · real heavy processing (transcode, LLM calls) · job DAGs
and workflow orchestration · scheduled/repeating jobs (BullMQ Job Schedulers) · multi-tenant
billing · Kubernetes or autoscaling · distributed tracing across services · a polished frontend
(a single static HTML page that opens the socket is sufficient to *demonstrate* realtime) ·
GraphQL · read replicas.

---

## 3. Process topology

Four processes. Two are ours.

```
                    ┌──────────────────────────┐
   HTTP  ─────────▶ │  API      (Nest, HTTP)   │ ─────┐
   WS    ─────────▶ │  + WebSocket gateway     │      │
                    └──────────────────────────┘      │
                            │           │             │
                       (produce)     (read)           │
                            ▼           ▼             │
                    ┌───────────┐  ┌──────────┐       │
                    │   Redis   │  │ Postgres │ ◀─────┘
                    └───────────┘  └──────────┘
                            ▲           ▲
                       (consume)     (write)
                            │           │
                    ┌──────────────────────────┐
                    │  WORKER  (Nest, no HTTP) │
                    │  BullMQ processor        │
                    └──────────────────────────┘
```

| Process | Nest bootstrap | Owns | Never does |
|---|---|---|---|
| **API** | `NestFactory.create()` (HTTP + WS) | Auth, job submission, job reads, the socket server | Instantiate a BullMQ `Worker`. Execute job side effects. |
| **WORKER** | `NestFactory.createApplicationContext()` (no HTTP server) | The `@Processor`, all side effects, all status transitions after `QUEUED` | Serve HTTP. Hold client sockets. |

**The single most important structural rule in this document:** the module that declares the
`@Processor` must **not** be reachable from the API's root module. `BullModule.registerQueue()`
plus a `WorkerHost` class in the same module makes that process a *consumer*. If `AppModule`
transitively imports it, the API silently becomes a second worker — real concurrency is double
what this spec claims, and "kill the worker" (assertion A3) tests nothing because the API is
still processing. §10 defines two disjoint root modules to make this structurally impossible
rather than merely discouraged.

Both processes connect to the same Postgres and the same Redis. They share code through
importable modules, never through a shared root.

---

## 4. Data model

Postgres via Prisma. Constraints listed as **DB** are enforced by the database and hold even if
every line of application code is wrong; constraints listed as **APP** are policy.

### 4.1 `User`

| Column | Type | Constraints |
|---|---|---|
| `id` | `uuid` | PK |
| `email` | `text` | **DB** unique, stored lower-cased |
| `passwordHash` | `text` | argon2id |
| `role` | `Role` enum | `USER` \| `ADMIN`, default `USER` |
| `createdAt` / `updatedAt` | `timestamptz(6)` | |

### 4.2 `RefreshToken`

| Column | Type | Constraints |
|---|---|---|
| `id` | `uuid` | PK |
| `userId` | `uuid` | **DB** FK → `User`, `ON DELETE CASCADE` |
| `tokenHash` | `text` | **DB** unique. SHA-256 of the opaque token — the token itself is never stored |
| `expiresAt` | `timestamptz(6)` | |
| `revokedAt` | `timestamptz(6)?` | Rotation sets this on the presented token |

### 4.3 `Job` — the core table

| Column | Type | Constraints / notes |
|---|---|---|
| `id` | `uuid` | PK. This is the id returned to the client and the only thing put on the queue (§8.3) |
| `userId` | `uuid` | **DB** FK → `User`, `ON DELETE CASCADE` |
| `type` | `JobType` enum | `MOCK` \| `CHARGE` |
| `payload` | `jsonb` | Validated per-type at the edge (§6.4) |
| `status` | `JobStatus` enum | See §5 |
| `attempts` | `int` | Default `0`. Incremented by the worker when it *claims* the job |
| `maxAttempts` | `int` | Default `5`. **DB** `CHECK (maxAttempts BETWEEN 1 AND 20)` |
| `idempotencyKey` | `text` | See D1 |
| `result` | `jsonb?` | Set on `SUCCEEDED` |
| `error` | `jsonb?` | `{ code, message, retryable, attempt }` — set on every failed attempt, last one wins |
| `correlationId` | `text` | The submitting request's id. Carried onto the queue so worker logs join API logs (§12.1) |
| `createdAt` | `timestamptz(6)` | |
| `updatedAt` | `timestamptz(6)` | |
| `startedAt` | `timestamptz(6)?` | First claim |
| `finishedAt` | `timestamptz(6)?` | Terminal transition |

**Indexes**

- **DB** `UNIQUE (userId, idempotencyKey)` — *the* guarantee behind assertion A1. Scoped per user
  so one tenant's key can never collide with another's (see D1).
- `(userId, status, createdAt DESC)` — the list endpoint's query.
- `(status)` partial `WHERE status IN ('QUEUED','RUNNING')` — operational "what is in flight".

**DB** `CHECK (attempts >= 0 AND attempts <= maxAttempts)`.

### 4.4 `SideEffect` — the effect-level ledger

This table is what makes the difference between "we didn't create two rows" and "we didn't charge
the card twice." It is written **in the same transaction as the effect it records**.

| Column | Type | Constraints |
|---|---|---|
| `id` | `uuid` | PK |
| `effectKey` | `text` | **DB** unique. Deterministic, derived from the job — never from a clock or a random source |
| `jobId` | `uuid` | **DB** FK → `Job` |
| `kind` | `text` | e.g. `charge` |
| `detail` | `jsonb` | What was done (amount, reference) |
| `createdAt` | `timestamptz(6)` | |

A retry of an already-executed effect attempts the same insert, hits the unique violation
(Prisma `P2002`), and treats it as "already done" — skip the effect, proceed to record success.
**The insert is the check.** A `SELECT` first is an optimisation, never the guard (§7.3).

### 4.5 `Outbox` — phase 6, specified now

Closes the commit-then-enqueue gap (D5). Written in the same transaction as the `Job` row.

| Column | Type | Notes |
|---|---|---|
| `id` | `bigserial` | PK. Serial, not uuid — the relay publishes in insertion order |
| `jobId` | `uuid` | **DB** FK → `Job` |
| `queue` / `jobName` | `text` | Destination |
| `payload` | `jsonb` | The queue message (§8.3) |
| `createdAt` | `timestamptz(6)` | |
| `publishedAt` | `timestamptz(6)?` | `NULL` = pending |
| `attempts` | `int` | Relay publish attempts |

**DB** partial index `(createdAt) WHERE publishedAt IS NULL` — the relay's only query, and it
stays small because published rows fall out of the index.

### 4.6 What is *not* a table

- **Dead letters.** Not a separate table in v1 — a terminal `Job.status` plus the populated
  `error` column (see D6b). BullMQ's own `failed` set is trimmed by `removeOnFail` and lives in
  Redis, which this spec treats as disposable. Anything that must survive a Redis flush is a
  Postgres row.
- **Attempt history.** `attempts` is a counter, not a log, in v1. Per-attempt rows are v2.

> **DECISION — D4 · Where does job status live?**
>
> **Status: RESOLVED.** Blocks phase 4 — a schema fact phase-4 code cannot avoid.
>
> - **(a) Postgres only.** BullMQ state is incidental transport detail, never read by the API. One
>   source of truth. Every status read costs a query.
> - **(b) Redis/BullMQ as the status store.** Fast, no extra writes. But job history dies with
>   `removeOnComplete`, and "all failed jobs for user X last week" becomes unanswerable.
> - **(c) Both** — Postgres canonical, Redis a projection. Fastest reads, and the drift bug: two
>   writers, two clocks, and a status in Redis that Postgres never received.
>
> The question that settles it: **if BullMQ says `completed` and Postgres says `RUNNING`, which is
> right, and what code makes them agree again?** If you cannot write that reconciliation, and you
> cannot write assertion A8, the answer is (a).
>
> **DECIDED 2026-09-01 — (a) Postgres only.** BullMQ's internal state is transport detail and is
> never read by the API. `GET /jobs/:id` is a single DB read.
>
> **Why:** a second source of truth is only worth its drift risk once a measurement demands it,
> and nothing has been measured yet. Adding a Redis projection later is easy; removing one after
> code depends on it is not. Revisit at D12 if `GET /jobs/:id` is ever *measured* slow.

---

## 5. Job state machine

### 5.1 States

| State | Terminal | Meaning |
|---|---|---|
| `QUEUED` | no | Row committed. Waiting for a worker (or waiting between retries). |
| `RUNNING` | no | A worker has claimed it and is executing. |
| `SUCCEEDED` | **yes** | Effect done, `result` written. |
| `DEAD_LETTERED` | **yes** | `attempts` reached `maxAttempts`, or a terminal error. `error` populated. Requires an explicit re-drive to move again. |

Four states, one of which is the dead letter. `RETRYING` is deliberately absent — a job waiting
for its next attempt is `QUEUED` with `attempts > 0`, which is the same fact with one less state
to guard. Revisit if the status stream turns out to be unreadable without it (§16, D3b).

### 5.2 Legal transitions — everything not listed is illegal

| From | To | Actor | Guard (the `WHERE` clause is the truth) |
|---|---|---|---|
| — | `QUEUED` | API | `INSERT`; unique violation on `(userId, idempotencyKey)` = replay |
| `QUEUED` | `RUNNING` | Worker | `WHERE id = ? AND status = 'QUEUED'`, sets `attempts = attempts + 1`, `startedAt` |
| `RUNNING` | `RUNNING` | Worker | **See D7** — this is the redelivery-after-stall case |
| `RUNNING` | `SUCCEEDED` | Worker | `WHERE id = ? AND status = 'RUNNING'` |
| `RUNNING` | `QUEUED` | Worker | `WHERE id = ? AND status = 'RUNNING' AND attempts < maxAttempts` |
| `RUNNING` | `DEAD_LETTERED` | Worker | `WHERE id = ? AND status = 'RUNNING'` and (attempts exhausted OR terminal error) |
| `DEAD_LETTERED` | `QUEUED` | API (re-drive) | `WHERE id = ? AND status = 'DEAD_LETTERED'`, resets `attempts = 0` |

**`SUCCEEDED` has no outgoing edge.** That is not a formality — it is the assertion that catches
a redelivered job whose success was committed but whose queue ack was lost. The guard makes the
second execution a no-op instead of a second charge.

### 5.3 The transition mechanism

Every transition is a **guarded conditional update**:

```ts
const { count } = await tx.job.updateMany({
  where: { id, status: 'RUNNING' },   // the expected state, not one read earlier
  data:  { status: 'SUCCEEDED', result, finishedAt: new Date() },
});
if (count === 0) { /* someone else moved it — do nothing, do not throw */ }
```

**The row count is the source of truth, never a value read before the write.** A count of `0`
means the row moved underneath us — a concurrent redelivery, a re-drive — and the correct
response is to stop, not to retry or to error. This is what makes every transition safe to
attempt twice, which is exactly what at-least-once delivery guarantees will happen.

---

## 6. API surface

Base path `/api/v1`. All job routes require a valid access token.

### 6.1 Response envelope

```jsonc
// success
{ "success": true, "data": { ... }, "requestId": "01J..." }
// error
{ "success": false, "error": { "code": "JOB_NOT_FOUND", "message": "Job not found" }, "requestId": "01J..." }
```

Produced by a global interceptor (success) and a global exception filter (error). `requestId`
is echoed in the `X-Request-Id` response header and is the same value stored on
`Job.correlationId`.

### 6.2 Endpoints

| Method | Path | Auth | Success | Notes |
|---|---|---|---|---|
| `POST` | `/auth/register` | — | `201` | argon2id hash |
| `POST` | `/auth/login` | — | `200` | Access + refresh pair |
| `POST` | `/auth/refresh` | refresh token | `200` | Rotation: presented token revoked, new pair issued |
| `POST` | `/auth/logout` | refresh token | `204` | Idempotent — revoking an already-revoked token is a no-op |
| `GET` | `/auth/me` | access | `200` | |
| `POST` | `/jobs` | access | **`202`** | Persist + enqueue. See §6.3 |
| `GET` | `/jobs/:id` | access | `200` | 404 for a job you don't own — never 403 |
| `GET` | `/jobs` | access | `200` | Filter `?status=`, `?type=`; offset pagination in v1 |
| `POST` | `/jobs/:id/retry` | access | `202` | Re-drive a `DEAD_LETTERED` job. Phase 6. See D6b |
| `GET` | `/health` | — | `200` | Liveness — process is up. No dependency checks |
| `GET` | `/ready` | — | `200`/`503` | Readiness — Postgres and Redis reachable *now* |

`404`-before-`403` on ownership: a job belonging to another user is *not found*. The API does not
reveal that a resource exists to someone with no right to it.

### 6.3 `POST /jobs` — the submit contract

**Request**

```
POST /api/v1/jobs
Authorization: Bearer <access token>
Idempotency-Key: <opaque client string, see D1>

{ "type": "CHARGE", "payload": { "amountCents": 1500, "reference": "inv_1029" }, "maxAttempts": 5 }
```

**Response — `202 Accepted`**, on both a first submit and a replay:

```jsonc
{ "success": true,
  "data": { "id": "…uuid…", "status": "QUEUED", "type": "CHARGE", "createdAt": "…", "replayed": false },
  "requestId": "01J…" }
```

A replay returns `202` with **the identical job id** and `"replayed": true`. It is not a `409`:
the client asked for the job to exist and it does. Returning an error would push retry logic back
onto the client, which is the thing idempotency exists to remove.

Because the response body is derivable entirely from the existing `Job` row, **no separate
idempotency-record table is needed** for the submit boundary. If the response ever grows a field
that is not on the row, that stops being true and a stored-response table becomes necessary.

`202`, not `200` or `201`: the work has been *accepted*, not *done*. The client polls
`GET /jobs/:id` or listens on the socket.

### 6.4 Validation

Nest 12's first-party `StandardSchemaValidationPipe` with Zod schemas, registered globally.
`nestjs-zod` is **not** used (§13.2).

- Body, params, and query validated at the edge; services assume clean input.
- `.strict()` on every object schema — mass-assignment protection. A client cannot smuggle
  `status`, `attempts`, or `userId` into a submit body.
- `payload` is validated by a **discriminated union on `type`**, so a `CHARGE` payload missing
  `amountCents` is a `400` at the edge, not a terminal failure discovered in a worker four
  seconds later.
- Path `:id` is validated as a UUID — a malformed id is a clean `400`, not a `500` from a
  Postgres cast error.

Three checks, three homes: shape → pipe (`400`); business rules → service
(`404`/`403`/`409`); integrity → database.

---

## 7. Reliability rules

Numbers in this section are contractual — the assertions in §14 verify them.

### 7.1 Two idempotency guards, not one

They protect different operations at different layers, and a spec that names only the first
still double-charges.

| | Submit guard | Effect guard |
|---|---|---|
| **Protects against** | The *client* retrying `POST /jobs` | The *queue* redelivering a job after a crash |
| **Question it answers** | "Did we already accept this request?" | "Did we already do this thing?" |
| **Enforced by** | `UNIQUE (userId, idempotencyKey)` on `Job` | `UNIQUE (effectKey)` on `SideEffect` |
| **Key** | D1 | Deterministic from `jobId` (§7.4) |
| **Fails how** | Duplicate job rows | **Duplicate charges** |

Assertion A3 (kill the worker mid-job) is the test that fails if only the submit guard exists.

> **DECISION — D1 · Who mints the idempotency key, and what is its scope?**
>
> **Status: RESOLVED.** Blocks phase 4 — the *scope* half is the unique index in the phase-4
> migration.
>
> - **(a) Client-supplied `Idempotency-Key` header, treated as opaque.** Correct for client
>   retries — *if the client reuses the key*. A naive client that generates a fresh UUID per
>   retry gets duplicate jobs, and the server cannot detect it.
> - **(b) Server-derived:** `sha256(userId | type | canonicalJson(payload))`. Dedups even a naive
>   client. But "submit the same job twice on purpose" becomes impossible — a real product
>   constraint, not just a technical one.
> - **(c) Both:** client key wins when present, server-derived hash as the fallback.
>
> Sub-questions the answer must also settle:
> - **Scope.** This spec assumes **per-user** (`UNIQUE (userId, idempotencyKey)`). A global unique
>   index would let user B's key collide with user A's — both an information leak and a
>   correctness bug. Confirm or change.
> - **Lifetime.** Forever, or does a key expire after some TTL and become reusable? Forever is
>   simpler and makes the unique index sufficient; a TTL requires a sweeper and a compound key.
> - **If (b) or (c): canonicalisation.** A key hashed from a payload containing `Date.now()`, a
>   UUID, a float, or unordered object keys is not a key — it is a random string with extra
>   steps. Define stable key ordering and the excluded fields.
>
> **DECIDED 2026-09-01 — (a), scoped per user, no expiry.** The client sends an opaque
> `Idempotency-Key` header; the guarantee is `UNIQUE (userId, idempotencyKey)` on `Job`.
>
> **Why:** it matches the prevailing industry contract, so integrating clients need no bespoke
> handling. Per-user scope is the load-bearing half — it ships in the phase-4 migration and
> prevents one user's key from colliding with another's. No expiry keeps the unique index
> sufficient on its own, with no sweeper to maintain. "Who mints the key" is cheap to change
> later; the index is not.

**Design rule.** Both guards are mandatory. The submit guard alone satisfies A1 and still fails
A3: a redelivery issues no HTTP request and inserts no `Job` row, so the submit index is never
consulted. Any review of this area checks for two distinct unique constraints, on two tables,
written by two different processes.

### 7.2 What `Idempotency-Key` is required on

Required on `POST /jobs`. A submit without the header is a `400` — not a silently-accepted
unguarded job. Making it optional means the guarantee is opt-in, and the one client that forgets
is the one that double-charges.

### 7.3 The insert is the check

Never `SELECT` for an existing key and then `INSERT`. Two concurrent submits both see "not
found", both insert, and the guarantee is gone — the classic check-then-act race.

```
attempt INSERT
  → success            → new job, enqueue it
  → P2002 unique error → replay: load the existing row, return it with replayed: true
```

The unique index is the coordinator. Catching `P2002` is the control flow, not an error path.

### 7.4 `effectKey` derivation

Deterministic and stable across redeliveries of the same job:

```
effectKey = `${jobId}:${kind}`          // e.g. "3f2a…:charge"
```

`jobId` is stable (the row already exists before the job is ever enqueued), so every redelivery
of that job derives the same key. **Not** the attempt number — that changes per delivery and
would make each retry look like a new effect. **Not** a timestamp. **Not** the BullMQ job id
unless §8.2's `jobId` and `Job.id` are kept identical, which this spec assumes.

A job with multiple side effects gets one ledger row per effect (`:charge`, `:notify`), each
inserted in the same transaction as its own effect. A multi-step job that is not
per-step-guarded will redo earlier steps on retry.

### 7.5 Retry policy

| Setting | v1 value |
|---|---|
| `maxAttempts` | 5 (per-job, client-overridable up to 20) |
| Backoff | Exponential, base 1000 ms: `2^(attempt-1) * 1000` → 1s, 2s, 4s, 8s, 16s |
| Jitter | **Required.** Full jitter: `random(0, computed)`. Without it, a batch that fails together retries together, and the spike recurs at every doubling |
| Terminal errors | Skip retries entirely — straight to `DEAD_LETTERED` (§7.7) |

BullMQ implements the backoff (`attempts`, `backoff: { type: 'custom' }` for jitter). Which
counter is *policy* is D7.

### 7.6 Stalled jobs — what BullMQ actually does

Worth stating precisely, because the mental model most people have is wrong:

- **There is no `stalled` state.** There is a *stalled event*, fired when an active job's lock is
  not renewed within the check window (~30 s default).
- A stalled job is moved **back to wait** and redelivered — or failed, once `maxStalledCount`
  (default **1**) is exceeded, with the error *"job stalled more than allowable limit"*.
- **A job can stall itself.** Blocking the event loop prevents lock renewal, so a CPU-bound
  processor is redelivered even though nothing crashed. This is why `MOCK` must `await sleep()`
  and never spin — otherwise reliability measurements reflect the fixture, not the system.
- A stall-induced redelivery is **not** an error retry. It interacts with whichever attempt
  counter D7 makes authoritative, and the two counters will diverge the first time it happens.

### 7.7 Error taxonomy

The worker classifies every failure into exactly one of three:

| Class | Example | Worker behaviour |
|---|---|---|
| **Transient** | DB connection blip, mock random failure | Throw a plain `Error` → BullMQ retries with backoff |
| **Terminal** | Payload fails a business rule, user deleted, unknown job type | Throw **`UnrecoverableError`** → no further retries, straight to `DEAD_LETTERED` |
| **Poison** | Repeated transient failures that exhaust `maxAttempts` | Falls through to `DEAD_LETTERED` on the last attempt |

Without this taxonomy, a validation bug burns all five attempts over 31 seconds and lands in the
dead letter with a useless error message. (`UnrecoverableError` replaces the removed
`Job#discard()` from BullMQ v5.)

> **DECISION — D5 · The ordering of "persist" and "enqueue"**
>
> **Status: RESOLVED.** Sequenced by §17: (b) in phase 5, (c) in phase 6, with assertion A6
> quantifying the exposure in between.
>
> This is the decision most first-draft specs make by accident, by writing "we persist the job and
> enqueue it" as one bullet — specifying an atomic operation that does not exist.
>
> - **(a) Enqueue inside the Prisma transaction.** **Wrong, and worth understanding why:** Redis
>   does not participate in the Postgres transaction, so a rollback leaves a queue message
>   pointing at a row that never existed. It also parks an interactive transaction open across a
>   network call.
> - **(b) Commit, then enqueue.** Correct on the happy path. A crash in the gap leaves a committed
>   `QUEUED` row that nobody will ever run — silent, permanent loss.
> - **(c) Transactional outbox.** Commit the `Job` row and an `Outbox` row atomically (§4.5); a
>   relay publishes pending outbox rows and marks them sent. Closes the hole. Adds a relay and
>   at-least-once publishing — which is fine, because §7.1's effect guard already made the
>   consumer idempotent.
>
> **Recommendation:** **(b) for phases 4–5, with the hole named and A6 written to prove it; (c) in
> phase 6.** Shipping (c) first hides the failure mode you are building this project to
> understand.
>
> If (c): **who relays?** A `@nestjs/schedule` tick in the API, a dedicated relay process, or
> Postgres `LISTEN/NOTIFY`. Each has a different failure mode when the relay itself dies — say
> which one you are accepting.
>
> **DECIDED 2026-09-01 — (b) for phases 4–5, (c) in phase 6.** Phase 5 commits the `Job` row and
> then enqueues. Phase 6 replaces that with the outbox, relayed by a `@nestjs/schedule` tick
> inside the API process.
>
> **Why (b) first:** the gap is small and the rows are durable, so (b) is acceptable through
> phase 5 provided it is measured rather than assumed. Assertion **A6** quantifies the exposure
> before (c) closes it.
>
> **Why a `@nestjs/schedule` tick as the relay host:** fewest new moving parts — no third
> deployable. Its failure mode is honest and worth naming: **if the API process is down, nothing
> relays, so jobs sit unpublished until it returns.** Acceptable because the rows are durable and
> the relay catches up; revisit if the API ever becomes the flaky tier.

### 7.8 The forbidden operations

Three rules that are checkable in review:

1. **Never enqueue inside a Prisma transaction.** Redis does not roll back. A rolled-back
   transaction leaves a queue message pointing at a row that does not exist, and the network call
   holds an interactive transaction open against its timeout.
2. **Never perform a side effect inside a transaction** — only *record* it. The transaction
   commits the ledger row and the status together; the effect itself (once it is real) happens
   outside, guarded by the ledger.
3. **Never emit a WebSocket event before commit.** Emit a state the DB then rolls back and
   every listening client is permanently wrong (§9.3). The same ordering rule applies to cache
   invalidation: commit first, then publish.

---

## 8. Queue topology

### 8.1 Queues

One queue, `relay-jobs`, with the BullMQ **job name** set to the `Job.type`.

> **Corrected 2026-10-16:** originally specified as `relay:jobs`. BullMQ v6 rejects a queue name
> containing `:`, which it reserves as its Redis key separator (`Error: Queue name cannot
> contain :`). Namespacing belongs in the `prefix` option, not the name.

> **DECISION — D6a · One queue or one per type?**
>
> **Status: DEFERRED — phase 10.** Trigger: the load test shows one job type starving another.
> Undecidable before that measurement. One queue for v1.
>
> - **(a) One queue, job name = type.** Simplest. One slow type starves the others — worker
>   concurrency is shared across all types.
> - **(b) Queue per type.** Isolation, per-type concurrency and rate limits. More wiring; the
>   worker must register every queue, and adding a type touches the worker's module.
> - **(c) One queue plus priorities.** Ordering control without isolation — priority does not
>   prevent starvation of the low-priority class, it guarantees it under sustained load.
>
> **Recommendation:** (a) for v1. With two mock job types there is nothing to isolate, and the
> trigger for splitting is measurable (§16). Do not pre-build isolation you cannot observe.
>
> **Resolution:** open — see Status above.

### 8.2 Job options

```ts
{
  jobId: job.id,                    // = the Postgres Job.id — a cheap first-line dedup only
  attempts: job.maxAttempts,
  backoff: { type: 'jitteredExponential' },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86400 },
}
```

**`jobId` is not durable dedup.** BullMQ ignores a duplicate job id only *while the job is in the
queue*; jobs removed by `removeOnComplete`/`removeOnFail` are no longer considered duplicates. So
with any sane retention config, jobId-based dedup silently expires. It is a cheap first filter.
**The Postgres unique index is the guarantee.** The same applies to BullMQ's `deduplication`
option — a lifecycle/time-window feature, not a correctness guarantee.

### 8.3 The queue message

```jsonc
{ "jobId": "…uuid…", "correlationId": "01J…" }
```

**Only the id, never the payload.** The payload of record lives in the `Job` row; the worker loads
it. This costs one read per job and eliminates an entire class of bug — payload drift between two
stores, and PII sitting in Redis where this spec says data is disposable. The `correlationId`
rides along so the worker's logs join the submitting request's logs (§12.1).

### 8.4 Worker

| Setting | v1 value |
|---|---|
| Concurrency | `5` per worker process (`WORKER_CONCURRENCY`) |
| Instances | 1 in dev; ≥2 in the load test, to prove no double-processing |
| Registration | `BullModule.registerQueue({ name: 'relay-jobs' })` **+** a `WorkerHost` class — in the worker root only |

Processor shape is BullMQ v6 / `@nestjs/bullmq` v12:

```ts
@Processor('relay-jobs')
export class JobsProcessor extends WorkerHost {
  async process(job: Job<JobMessage>): Promise<unknown> { /* … */ }
}
```

Not the `@Process()`-decorated-method style — that is the legacy `@nestjs/bull` API and does
not apply here.

> **DECISION — D7 · What does the worker do on claim, and what happens when it dies?**
>
> **Status: DEFERRED — phase 6.** Trigger: a killed worker leaves a row stuck in `RUNNING`.
> Phase 5 ships `WHERE status = 'QUEUED'`, which is sufficient there because phase 5 introduces
> neither crashes nor retries. The correct guard is chosen in phase 6 against observed
> behaviour, when stall semantics can actually be exercised.
>
> **On claim.** A blind `UPDATE status = 'RUNNING'` cannot tell a fresh job from a redelivery of
> one that already succeeded. A guarded transition can. But the naive guard
> `WHERE status = 'QUEUED'` rejects a legitimate redelivery after a stall, because that row is
> still `RUNNING`. Options:
> - **(a)** `WHERE status = 'QUEUED'` only. Count `0` → skip. Safe, but a stalled job is never
>   retried — it is stuck in `RUNNING` forever.
> - **(b)** `WHERE status IN ('QUEUED','RUNNING')`. Claims both fresh and redelivered jobs;
>   still refuses `SUCCEEDED` and `DEAD_LETTERED`, which is the case that matters.
> - **(c)** `WHERE status NOT IN ('SUCCEEDED','DEAD_LETTERED')`. Equivalent to (b) today,
>   survives adding a state later.
>
> **On death.** Nothing in Postgres changes — the row sits in `RUNNING` until something acts.
> What reconciles it: BullMQ's own stalled-detection redelivery, or a periodic sweeper? If the
> claim guard is (b)/(c), redelivery alone may reconcile the row and a sweeper is dead code. The
> case that decides it: when `maxStalledCount` is exceeded BullMQ fails the job permanently and
> no worker claims it again — nothing then moves the Postgres row out of `RUNNING`.
>
> **Which attempt counter is authoritative:** `Job.attempts` (Postgres) or BullMQ's
> `attemptsMade`? They *will* diverge — the first stall does it. Pick one for **policy** (when to
> dead-letter) and treat the other as observability. Two policies on two counters is a bug that
> only appears under failure, which is the worst time to find it.
>
> **Resolution:** open — see Status above.

> **DECISION — D6b · What is the dead-letter path, physically?**
>
> **Status: DEFERRED — phase 6.** Trigger: the first job that actually dies. The spec leans (a);
> confirm it then.
>
> - **(a) A terminal `Job.status = 'DEAD_LETTERED'` + `error`.** Queryable, durable, survives a
>   Redis flush. This spec assumes it.
> - **(b) BullMQ's `failed` set.** Trimmed by `removeOnFail`, lives in Redis — which §4.6 calls
>   disposable. Fine for debugging, wrong as storage.
> - **(c) A dedicated `dead-letter` queue** pushed to explicitly. Useful if a separate consumer
>   should react to failures; more machinery than v1 needs.
>
> And: **does a re-drive reuse the idempotency key?** It must — a re-driven job is the same job
> (same row, same `id`), so `effectKey` is unchanged and a re-drive of a job whose effect already
> landed is correctly a no-op. Confirm this is what §7.4 gives you.
>
> **Resolution:** open — see Status above.

---

## 9. Realtime contract

### 9.1 Connection and auth

- Socket.io via `@nestjs/websockets` + `@nestjs/platform-socket.io`, namespace `/events`.
- **Authenticated on connect**, not per message — a socket cannot carry an `Authorization` header
  per frame. The access token is passed in the handshake `auth` payload; an invalid or expired
  token means the connection is refused, not degraded.
- On successful connect the socket joins the room `user:<userId>`. **The server assigns the room
  from the verified token — never from anything the client sends.** Identity from the token,
  ownership from the DB; the moment either comes from client input the check collapses.

### 9.2 Events

| Event | Payload |
|---|---|
| `job.updated` | `{ id, status, attempts, result?, error?, updatedAt }` |

One event, fired on every status transition. Separate `job.succeeded` / `job.failed` events are
not worth the client-side branching when `status` already carries it.

### 9.3 Delivery guarantee — stated bluntly

**Best-effort. Not guaranteed.** A client that is disconnected during a transition misses that
event permanently; there is no replay buffer in v1.

Therefore: **`GET /jobs/:id` is the reconciliation path**, and the client contract is *on
connect and on reconnect, re-fetch the jobs you care about.* Assertion A7 tests exactly this. A
realtime channel that clients are allowed to treat as authoritative is a correctness bug wearing
a feature's clothes.

**Emit after commit, never inside the transaction** (§7.8, rule 3).

> **DECISION — D8 · Who emits, and how does the event cross the process boundary?**
>
> **Status: DEFERRED — phase 7.** Trigger: the first cross-process emission attempt. The
> mechanism depends on how the gateway is deployed, which is not fixed until phase 7.
>
> The transitions happen in the **worker**. The sockets live in the **API**. `server.emit()` from
> the worker reaches nobody.
>
> - **(a) Worker emits via a Redis pub/sub bridge**; the API subscribes and forwards to the room.
>   Lowest latency, explicit, one more moving part.
> - **(b) API subscribes to BullMQ `QueueEvents`.** No custom bridge. But queue events describe
>   *queue* state, not *domain* state — `completed` fires without your `result` in hand, so the
>   API must re-read the row anyway, and states like a guarded no-op transition produce no queue
>   event at all.
> - **(c) An event outbox:** the same transaction that writes the status writes an event row; a
>   publisher emits after commit. Cannot ever emit a state the DB does not have. Most machinery.
>
> **Recommendation:** (a) for phase 7 — it is the honest shape (the worker knows the domain
> event; the API owns the sockets) and it is the same component you will need in phase 11 for
> multi-instance socket.io anyway.
>
> Second API instance (phase 11, not now) additionally needs `@socket.io/redis-adapter` **plus**
> either `transports: ['websocket']` on the client or sticky routing at the proxy. Redis alone is
> not sufficient — the polling handshake will break across instances.
>
> **Resolution:** open — see Status above.

---

## 10. Nest composition

### 10.1 Two root modules

```
ApiModule  (bootstrap: NestFactory.create)
├── ConfigModule.forRoot({ isGlobal: true, validate: zodEnv })
├── PrismaModule            (global; exports PrismaService)
├── RedisModule             (global; exports the ioredis client)
├── AuthModule              → AuthController, AuthService, TokenService, JwtStrategy
├── JobsModule              → JobsController, JobsService, JobsRepository
│    └── imports BullModule.registerQueue({ name: 'relay-jobs' })   // PRODUCER ONLY
├── EventsModule            → EventsGateway (+ the bridge subscriber, D8)
└── HealthModule            → Terminus: Postgres + Redis

WorkerModule  (bootstrap: NestFactory.createApplicationContext)
├── ConfigModule / PrismaModule / RedisModule    (same modules, reused)
├── ProcessingModule        → JobsProcessor (WorkerHost), the handler registry
│    └── imports BullModule.registerQueue({ name: 'relay-jobs' })   // CONSUMER
└── HealthModule            (optional: a tiny HTTP listener for container health)
```

**`ApiModule` must never transitively import `ProcessingModule`.** Shared code (Prisma, Redis,
config, the domain services the processor calls) lives in modules both roots import — never in a
module that also declares the processor. This is §3's rule made structural.

### 10.2 Global registrations

Registered via **provider tokens**, not `app.useGlobalX(new X())` — the token form goes through
the DI container, so a guard or filter can inject `PrismaService`. The `new X()` form cannot
inject anything, which is discovered the moment a guard needs a DB read.

| Token | Provider |
|---|---|
| `APP_PIPE` | `StandardSchemaValidationPipe` |
| `APP_GUARD` | `JwtAuthGuard` (opt out per-route with `@Public()`) |
| `APP_GUARD` | `RolesGuard` (`@Roles('ADMIN')`) |
| `APP_INTERCEPTOR` | `ResponseEnvelopeInterceptor` |
| `APP_INTERCEPTOR` | `LoggingInterceptor` (request id, timing) |
| `APP_FILTER` | `DomainExceptionFilter` |

### 10.3 Lifecycle order — where it bites

```
middleware → guards → interceptors (pre) → pipes → handler → interceptors (post) → exception filter
```

- **Guards run before pipes.** A guard cannot read a validated body. Ownership checks that need a
  DB read belong in the **service** — not in a guard, and not in the controller.
- **Exception filters do not cover the worker.** An HTTP filter never sees an error thrown inside
  a processor. The worker needs its own error handling, its own logger wiring, and an explicit
  policy for unhandled rejections — with a container restart policy, a crash is a feature; without
  one, it is silent death. **v1: the worker's Docker service uses `restart: unless-stopped`.**
- Nest 12 changed lifecycle-hook ordering to be by component hierarchy level. Nothing here should
  depend on `onModuleInit` order; if something starts to, make it explicit rather than implicit.

---

## 11. Configuration

Validated at boot with a Zod schema through `@nestjs/config` (v12 accepts Standard Schema
validators directly — no Joi). **Misconfiguration crashes startup, never a request at 3am.**
`process.env` is read in exactly one file.

| Variable | Type | API | Worker | Notes |
|---|---|---|---|---|
| `NODE_ENV` | enum | ✓ | ✓ | |
| `PORT` | int | ✓ | — | |
| `DATABASE_URL` | url | ✓ | ✓ | |
| `REDIS_URL` | url | ✓ | ✓ | |
| `JWT_ACCESS_SECRET` | str ≥32 | ✓ | — | |
| `JWT_REFRESH_SECRET` | str ≥32 | ✓ | — | The worker mints no tokens |
| `ACCESS_TOKEN_TTL` | duration | ✓ | — | Default `15m` |
| `REFRESH_TOKEN_TTL` | duration | ✓ | — | Default `30d` |
| `WORKER_CONCURRENCY` | int | — | ✓ | Default 5 |
| `JOB_MAX_ATTEMPTS` | int | ✓ | ✓ | Default ceiling |
| `LOG_LEVEL` | enum | ✓ | ✓ | |
| `CORS_ORIGINS` | csv | ✓ | — | |

**The two processes deliberately do not share a config surface.** The worker holding JWT secrets
it never uses is needless blast radius. One schema, two required-sets.

---

## 12. Observability and health

### 12.1 Logging

`nestjs-pino`, structured JSON, silent in tests.

**The correlation id must cross the process boundary.** A request id that stops at the API makes
submit and processing unjoinable in logs — which is precisely the moment you need them joined.
The path: request id → `Job.correlationId` → queue message (§8.3) → the worker's child logger for
that job.

Standard fields on every worker log line: `correlationId`, `jobId`, `jobType`, `attempt`,
`status`.

### 12.2 Health

| Endpoint | Semantics | On failure |
|---|---|---|
| `/health` | Liveness — the process is up. No dependency checks | Restart the container |
| `/ready` | Readiness — Postgres and Redis reachable *now* | Stop routing traffic; do **not** restart |

Conflating them means a database blip pointlessly restarts every instance instead of pulling them
out of rotation.

`@nestjs/terminus` ships a `PrismaHealthIndicator`. It ships **no first-party Redis indicator** —
either `MicroserviceHealthIndicator` with `Transport.REDIS` (which pulls in
`@nestjs/microservices`) or a small custom indicator running `PING`. **v1: a custom indicator** —
it is ~15 lines and avoids a dependency added purely for a health check.

---

## 13. Tooling and versions

Verified 2026-09-01 against the official NestJS, BullMQ, and Prisma documentation.

### 13.1 Runtime

| | Choice | Note |
|---|---|---|
| Runtime | **Node 24 LTS** in Docker and CI | The host has Node 26.4.0, which Nest 12 supports — but 26 is not LTS until Oct 2026 and native deps (`argon2`) lag a major. Pin 24 in the image so container and CI never drift from each other. |
| Package manager | npm | |
| Module format | **ESM** | Nest 12 core packages are ESM-only. Set `"type": "module"` and matching tsconfig from day one — retrofitting this later is genuinely painful. |

### 13.2 Dependencies — current, verified

| Package | Version | Note |
|---|---|---|
| `@nestjs/core`, `@nestjs/common` | 12.x | ESM-only |
| `@nestjs/cli` | 12.x | Not installed globally on this machine — use `npx` |
| `@nestjs/config` | 12.x | Accepts Standard Schema (Zod) validators |
| `@nestjs/bullmq` + `bullmq` | 12.x / 6.x | **Not** `@nestjs/bull` — Bull is in maintenance |
| `@nestjs/websockets` + `@nestjs/platform-socket.io` | 12.x | Bundles socket.io 4.8.x |
| `@nestjs/terminus` | 12.x | |
| `@nestjs/schedule` | 12.x | Candidate host for the outbox relay tick |
| `prisma` / `@prisma/client` | 7.x | |
| `@prisma/adapter-pg` | 7.x | Driver adapter |
| `zod` | 4.x | |
| `nestjs-pino` + `pino` + `pino-http` | 5.x / 10.x / 11.x | pino 10 is required by nestjs-pino 5 |
| `argon2` | latest | `Bun.password` does not exist on Node |
| `ioredis` | latest | Now an **optional** peer of BullMQ v6, so declare it explicitly |
| `vitest` | latest | **Not Jest** — see below |

### 13.3 Four things that changed recently

Recent releases changed the following. Documentation predating them is misleading:

1. **Vitest, not Jest.** Newly generated Nest projects use Vitest by default. `@nestjs/testing`
   is unchanged (`Test.createTestingModule`, `.overrideProvider`, `.createNestApplication()`,
   Supertest for e2e) — only the runner differs.
2. **Zod validation is first-party.** Nest 12 ships `StandardSchemaValidationPipe` in
   `@nestjs/common`. `nestjs-zod@5.5.0` declares peers of `@nestjs/common` ^10||^11 — **no Nest 12
   range** — so it is now the higher-friction path and would need peer overrides. Use the
   first-party pipe.
3. **BullMQ v6 breaking changes** vs v5: high-level classes no longer
   expose Redis internals (`Queue#client` etc. removed); ioredis is an optional peer; the legacy
   repeatable-jobs API is replaced by **Job Schedulers**; the `paused` job state was removed;
   `Job#discard()` is replaced by `UnrecoverableError`; `Worker#resume()` is now async.
4. **Prisma's generator changed.** `prisma-client-js` is deprecated in favour of the
   `prisma-client` generator, `output` is now **required**, and there is no more magic generation
   into `node_modules`. `provider = "prisma-client-js"` + `import from '@prisma/client'` is stale.

### 13.4 Local stack

`docker compose`: `postgres:17`, `redis:7`, with healthchecks so `depends_on` waits for actual
readiness rather than container start. App and worker are the same image with different commands.

---

## 14. Verification plan

Each assertion names the query that decides pass/fail. **An assertion without a deciding query is
a wish.**

These are the system-level invariants. They are distinct from ordinary unit, integration and e2e
coverage, which is written alongside the code it covers in every phase — not deferred to phase 9.
Phase 9 builds the shared harness and CI and turns A1–A7 from manual procedures into automated
cases.

| # | Assertion | Deciding check | Phase |
|---|---|---|---|
| **A1** | **Duplicate submit creates one job.** Fire M concurrent `POST /jobs` with the same key | `SELECT count(*) FROM "Job" WHERE "userId"=$1 AND "idempotencyKey"=$2` **= 1**; every response is `202` with the same `id`; `SELECT count(*) FROM "SideEffect"` **= 1** | 6 |
| **A2** | **No lost work.** Submit N jobs, N distinct keys | After drain: terminal jobs **= N**, and `SELECT count(*) FROM "Job" WHERE status IN ('QUEUED','RUNNING')` **= 0** | 5 |
| **A3** | **Crash mid-job — the headline test.** Submit N; `SIGKILL` the worker while jobs are `RUNNING`; restart | Terminal jobs **= N** *and* `SELECT count(*) FROM "SideEffect"` **= N** — not N + in-flight. **Fails if §7.1's effect guard was skipped** | 6 |
| **A4** | **Redelivery of a succeeded job is a no-op.** Force redelivery of a `SUCCEEDED` job | `SUCCEEDED → RUNNING` never occurs; `SideEffect` count unchanged; the guarded update returns count `0` | 6 |
| **A5** | **A poison job dead-letters exactly once.** Submit a job that always fails | `attempts = maxAttempts`; exactly one `DEAD_LETTERED` row; `error` populated; it never returns to `QUEUED` without an explicit re-drive | 6 |
| **A6** | **The enqueue gap is real.** With a fault injected between commit and enqueue | A `QUEUED` job exists with no queue entry — i.e. **prove the hole exists in the v1 design**. After the outbox lands, the same test must show the job eventually runs | 6 |
| **A7** | **Realtime reconciles.** Disconnect a client mid-processing, reconnect after completion | The client's state from `GET /jobs/:id` equals the terminal state — a missed WS event never leaves a client permanently wrong | 7 |
| **A8** | **No status disagreement.** Only applicable if D4 chose "both" | After drain, no job's Redis-side state contradicts its Postgres state. **If this test cannot be written, D4 must be "Postgres only"** | 5 |
| **A9** | **Holds under load.** V virtual users for T minutes, one worker killed mid-run | A2 and A3 still hold. Record p95 submit latency, throughput, max queue depth, drain time — **name the numeric targets before running**, or the result is unfalsifiable | 10 |
| **A10** | **No side effect inside a transaction.** Enforced by review, not code | Grep every `$transaction` block: it may write the ledger row, never perform the effect | ongoing |

**A6 is written to fail against the phase-5 design.** The commit-then-enqueue gap is a knowingly
accepted risk; A6 quantifies it rather than leaving it undocumented.

---

## 15. Phases 8–11 — objectives fixed, detail deferred

In scope for v1. Their objectives and exit criteria are fixed below; the detailed design is
written at the start of each phase, because each depends on measurements that do not exist yet.
Specifying them now would produce prose that is wrong by the time it is used.

| Phase | Objective | Exit criterion | Detail written |
|---|---|---|---|
| **8 · Observability & hardening** | Prometheus `/metrics` from both processes: queue depth, duration histogram, failure rate, dead-letter count. Rate limiting, `trust proxy`, helmet, CORS allowlist, body limits. Dead-letter inspection and re-drive | Queue depth observably rises and drains under load; one job's full story is retrievable from logs by `correlationId` alone | Start of phase 8 |
| **9 · Test harness & CI** | The shared harness, fixtures and CI — **not** the tests themselves, which are written with the code throughout (§14). A1–A7 become automated cases including process kill/restart | `npm test` reproduces every reliability assertion with no manual steps; CI green from a clean checkout | Start of phase 9 |
| **10 · Load** | k6 scenarios and A9 under sustained load with ≥2 workers. Numeric targets fixed **before** the run | Targets met or the gap documented; D6a and D10 closed with measurements attached | Start of phase 10 |
| **11 · Deploy** | One VPS: Docker running API + worker, Caddy for auto-HTTPS, `ufw`, managed Postgres, restart policies, migrations as a release step. Multi-instance socket.io (D13) becomes real here | HTTPS on a real domain; a reboot restores both processes unattended; a restore from backup has been rehearsed | Start of phase 11 |

**Note for phase 8:** `@nestjs/throttler` 6.5.0 declares peers stopping at Nest 11. Re-verify its
support at that point rather than pinning the assumption now.

---

## 16. Open decisions register

Every decision in this document is either **DECIDE NOW** or **DEFERRED with a named trigger**.
A decision with a trigger is deferred on purpose; a decision with a blank line and no trigger is
merely missing. The distinction is the point of this register.

**A decision made before its consequences are observable is a guess recorded as a fact.** These
are deferred because the phase that forces each one is also the phase that supplies the evidence
to settle it.

### Decide now — before phase 4 code · **all resolved**

| # | Question | Why it cannot wait | Section |
|---|---|---|---|
| D1 | ~~Idempotency key: who mints it, what scope~~ **DECIDED** — client header, per-user, no expiry | — | §7.1 |
| D4 | ~~Status in Postgres, Redis, or both~~ **DECIDED** — Postgres only | — | §4 |
| D5 | ~~Persist/enqueue ordering~~ **DECIDED** — commit-then-enqueue in ph5, outbox in ph6 | — | §7.7 |

### Deferred — each waits for its trigger

| # | Question | Trigger that forces the call | Phase |
|---|---|---|---|
| D7 | Claim guard; crash reconciliation; authoritative attempt counter | Your first killed worker leaves a row stuck in `RUNNING` | 6 |
| D6b | What a dead letter physically is | The first job that actually dies | 6 |
| D8 | Who emits the WS event; how it crosses the process boundary | The worker emits and no browser receives it | 7 |
| D6a | One queue, or one per job type | The load test shows one job type starving another | 10 |
| D3b | Add an explicit `RETRYING` state? | The status stream proves unreadable without distinguishing "never run" from "waiting after failure #2" | 7 |
| D10 | Worker concurrency tuning; sandboxed processors | Measured event-loop blocking in the worker | 10 |
| D11 | A dead-letter re-drive API beyond `POST /jobs/:id/retry` | The first real dead letter that needs bulk handling | 8 |
| D12 | Status cache in Redis | A **measured** slow `GET /jobs/:id`. Never before | — |
| D13 | socket.io Redis adapter + sticky sessions | A second API instance | 11 |
| D14 | Cursor pagination | A list endpoint where offset pagination measurably hurts | — |
| D15 | Job types beyond `MOCK` / `CHARGE` | A real use case | v2 |
| D16 | Do replays bypass the rate limiter? | A client retrying with the same key gets `429` for a job already accepted | 8 |

**Rule this register enforces:** write in detail only what a test in the next two phases could
falsify. Everything else is a trigger, not a design.

---

## 17. Phase map

All eleven phases are v1. Each closes on a demonstrable, runnable state. Broken into tasks in
[`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md).

| # | Phase | This spec's sections | Done when |
|---|---|---|---|
| 1 | Nest setup on Node | §3, §11, §13 | App boots; config fails fast on a bad env; Postgres + Redis up via compose |
| 2 | Auth as Nest primitives | §4.1–4.2, §6.2 | Register/login/refresh work; `JwtAuthGuard` + `RolesGuard` via `APP_GUARD` |
| 3 | The cross-cutting trio | §6.1, §6.4, §10.2, §12.1 | Every response is enveloped; every error mapped; every log carries a request id |
| 4 | Jobs API, synchronous stub | §4.3, §5, §6.3 | `POST /jobs` persists and marks `SUCCEEDED` inline. No queue yet. State machine guarded |
| 5 | Queue + worker | §3, §8, §10.1 | Worker is a separate process; `QUEUED → RUNNING → SUCCEEDED` flows. **A2, A8 pass** |
| 6 | Reliability | §7, §4.4, §4.5 | Idempotency both layers, backoff + jitter, dead letter, outbox. **A1, A3, A4, A5, A6 pass** |
| 7 | Realtime | §9 | Client sees live status; auth on connect; **A7 passes** |
| 8 | Observability & hardening | §12, §15 | Metrics from both processes; rate limiting; logs join across the process boundary |
| 9 | Test harness & CI | §14, §15 | A1–A7 automated; CI green from a clean checkout |
| 10 | Load | §14, §15 | **A9 passes**; D6a and D10 closed with measurements |
| 11 | Deploy | §3, §11, §15 | HTTPS on a real domain; reboot-safe; restore rehearsed |

Phase 5 is the largest structural change; phase 6 carries the system's core risk. Both are
scheduled with proportionally more time than the phases around them. Phase 9 precedes phase 10
because an unautomated assertion cannot be checked under load, and phase 10 precedes phase 11 so
the deployment is sized against measured numbers.

---

## 18. Changelog

A spec line that survives contact with code should be **edited, not defended**.

| Date | Change |
|---|---|
| 2026-09-01 | v0.2 — phases 8–11 brought into v1 scope (§15, §17). Testing stated as a standing practice across all phases, not a phase-9 activity (§14). |
| 2026-10-16 | Queue renamed `relay:jobs` → `relay-jobs`: BullMQ v6 rejects `:` in queue names (§8.1). |
| 2026-09-01 | v0.1 — initial specification. D1, D4, D5 resolved; D6a, D6b, D7, D8 deferred with triggers (§16). |
