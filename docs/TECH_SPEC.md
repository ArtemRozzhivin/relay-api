# Relay — Technical Specification

**Version:** 0.1 · **Started:** 2026-09-01 · **Status:** in implementation — progress in
`docs/IMPLEMENTATION_PLAN.md`, changes in §18

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

Two deliberately fake types exercise the *machinery*, which is the subject; the product phases
add real ones on top of it:

| Type | Behaviour | Why it exists |
|---|---|---|
| `MOCK` | Sleeps `durationMs` spread over `steps` intervals, reporting progress after each. With probability `failureRate` it throws just past the halfway step, so a failed attempt leaves progress behind | Drives the queue, retries, backoff, the dead-letter path and progress deterministically |
| `CHARGE` | Writes one row to the side-effect ledger, logs "charged". No gateway, no network | The job whose double-execution is observably wrong — the subject of A1/A3 |
| `import.csv` | Reads a seller's uploaded CSV from S3 and upserts it as products, a checkpointed batch at a time; invalid rows go to an error report (§6.3b) | The first real job: long, resumable, partly failing (PB) |
| `image.process` | Downloads the named products' images through the guarded downloader and stores three WebP sizes in S3 (§6.3c) | Untrusted URLs, and per-item failure inside one job (PC) |

`MOCK` must `await`, never spin. A CPU-blocking processor starves the event loop, fails to renew
its BullMQ lock, and stalls itself — a self-inflicted redelivery that invalidates every
reliability measurement (§7.6).

### Explicit non-goals (v2)

Real payment or email side effects · real heavy processing (transcode, LLM calls) · job DAGs
and workflow orchestration · scheduled/repeating jobs (BullMQ Job Schedulers) · multi-tenant
billing · Kubernetes or autoscaling · distributed tracing across services · any frontend
(the realtime contract is verified by a scripted socket client; a dashboard is a separate
deliverable and is not what §9 is specified against) · GraphQL · read replicas.

---

## 3. Process topology

Four processes, two of them ours, and one service outside them: the S3 bucket (D29).

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
| **API** | `NestFactory.create()` (HTTP + WS) | Auth, job submission, job reads, the socket server, signing S3 upload and download links | Instantiate a BullMQ `Worker`. Execute job side effects. Carry a file's bytes. |
| **WORKER** | `NestFactory.createApplicationContext()` (no HTTP server) | The `@Processor`, the stranded-job sweep, all side effects, all status transitions after `QUEUED`, every read and write of a file in S3 | Serve HTTP. Hold client sockets. |

**S3** holds files, never state a job's correctness depends on: a client uploads a CSV straight to
the bucket with a presigned POST, and downloads error reports and product images through signed
links; the worker reads uploads and writes reports and image sizes.

**The single most important structural rule in this document:** the module that declares the
`@Processor` must **not** be reachable from the API's root module. `BullModule.registerQueue()`
plus a `WorkerHost` class in the same module makes that process a *consumer*. If `AppModule`
transitively imports it, the API silently becomes a second worker — real concurrency is double
what this spec claims, and "kill the worker" (assertion A3) tests nothing because the API is
still processing. §10 defines two disjoint root modules to make this structurally impossible
rather than merely discouraged.

Both processes connect to the same Postgres, the same Redis and the same bucket. They share code
through importable modules, never through a shared root.

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
| `type` | `text` | A value from the `JOB_TYPES` tuple (`MOCK` \| `CHARGE` \| `import.csv` \| `image.process` today). Not a DB enum — the submit schema and the handler registry are the authority (D21) |
| `payload` | `jsonb` | Validated per-type at the edge (§6.4) |
| `status` | `JobStatus` enum | See §5 |
| `attempts` | `int` | Default `0`. Incremented by the worker when it *claims* the job. The retry budget, reset by a re-drive — so **not** the ownership token |
| `lease` | `int` | Default `0`. The ownership token: every claim increments it and nothing resets it, so no two deliveries — in one life or across a re-drive — ever share one (D7). Every write a worker makes on a job it claimed carries `lease = <claimed>`. A counter, not a time: it fences a stale writer, it does not expire. Internal — never in a response |
| `maxAttempts` | `int` | Default `5`. **DB** `CHECK (maxAttempts BETWEEN 1 AND 20)` |
| `idempotencyKey` | `text` | See D1 |
| `requestHash` | `text?` | SHA-256 of the canonical submit body, so a reused key with a different body is refused (D28). Internal — never in a response. `NULL` on rows from before it was stored, which can only be replayed |
| `result` | `jsonb?` | Set on `SUCCEEDED` |
| `error` | `jsonb?` | `{ code, reason?, message, attempt? }` — set on every failed attempt, last one wins; cleared when the job succeeds or is re-driven. `code` is `ATTEMPT_FAILED` while the job waits for a retry (a job cancelled meanwhile keeps it), otherwise how the job died, one of `DEAD_LETTER_CODES`. `reason` is a handler's own name for a terminal failure, such as `IMPORT_MOSTLY_INVALID`, so a client can tell one from another without reading `message`. `message` is written for the job's owner (§7.7). `attempt` is absent on `DELIVERY_ABANDONED`: the queue gave the job up outside any attempt |
| `progress` | `jsonb?` | `{ processed, total?, message? }` (D25). Written outside any status transition, under the ownership token (`lease`) **and** a `processed <=` predicate, so it can never move backwards. Cleared by a re-drive |
| `checkpoint` | `jsonb?` | How far the job's committed work reaches, in a shape its handler owns (D26). Written in the **same transaction** as the batch it describes, under `lease`, so it never claims work that did not commit; an attempt that lost the job has its batch rolled back with it. **Kept** by a re-drive, cleared by `?from=start`. Internal — never in a response |
| `cancelRequested` | `boolean` | Default `false`. The owner's request; `CANCELLED` is the worker's answer (D22). Set only while the job is unfinished, so a cancel of a finished job leaves no trace. Cleared by a re-drive |
| `effectCommitted` | `boolean` | Default `false`. Set in the transaction that commits the job's one irreversible effect — a charge's ledger row — under the lease (`context.commitEffect`). From then on only the job's handler may finish it: a cancel that runs no handler is refused (§5.2). Never reset, a re-drive included: the effect is still real. **DB** `CHECK (NOT (effectCommitted AND status = 'CANCELLED'))` |
| `correlationId` | `text` | The submitting request's id. Carried onto the queue so worker logs join API logs (§12.1) |
| `createdAt` | `timestamptz(3)` | Milliseconds, not microseconds: the list's cursor carries it through a JS `Date`, which holds no finer, and a rounded cursor would skip a job created microseconds after the one a page ended on (D14) |
| `updatedAt` | `timestamptz(6)` | |
| `startedAt` | `timestamptz(6)?` | The latest claim. Cleared by a re-drive |
| `finishedAt` | `timestamptz(6)?` | Terminal transition |

**Indexes**

- **DB** `UNIQUE (userId, idempotencyKey)` — *the* guarantee behind assertion A1. Scoped per user
  so one tenant's key can never collide with another's (see D1).
- `(userId, createdAt DESC, id DESC)` and `(userId, status, createdAt DESC, id DESC)` — the job
  list's order without and with a status filter, so a page is a range of an index rather than a
  sort of every job the caller has (D14).
- `(status)` partial `WHERE status IN ('QUEUED','RUNNING')` — operational "what is in flight".

**DB** `CHECK (attempts >= 0)`.

> `attempts <= maxAttempts` was specified and had to be dropped — it is unsatisfiable. The two
> counters count different things: `Job.attempts` is incremented by `claim()` on **every
> delivery**, while BullMQ's retry budget (`attemptsMade`) is incremented only on an **actual
> failure**. A stalled redelivery therefore consumes one of ours and none of BullMQ's, so
> `attempts` can legitimately exceed `maxAttempts` by the number of stalls. The dead-letter
> boundary is a policy decision in the worker; the database only enforces that the counter is
> sane. (The migration's own comment states the mechanism imprecisely — it says BullMQ redelivers
> "in addition to its configured retries", which is true of our counter, not of `attemptsMade`.)

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
| `id` | `bigserial` | PK. Serial, not uuid — the relay publishes in insertion order, skipping a row it cannot publish rather than stopping at it, so one bad row never holds back the rest |
| `jobId` | `uuid` | **DB** FK → `Job` |
| `queue` / `jobName` | `text` | Destination |
| `payload` | `jsonb` | The queue message (§8.3) |
| `createdAt` | `timestamptz(6)` | |
| `publishedAt` | `timestamptz(6)?` | `NULL` = pending |
| `attempts` | `int` | Publishes by the relay. The direct path marks a row published without touching it, so `0` on a published row means the fast path delivered it, and A6 relies on that |

**DB** partial index `(createdAt) WHERE publishedAt IS NULL` — the relay's only query, and it
stays small because published rows fall out of the index.

### 4.6 What is *not* a table

- **Dead letters.** Not a separate table in v1 — a terminal `Job.status` plus the populated
  `error` column (see D6b). BullMQ's own `failed` set is trimmed by `removeOnFail` and lives in
  Redis, which this spec treats as disposable. Anything that must survive a Redis flush is a
  Postgres row.
- **Attempt history.** `attempts` is a counter, not a log, in v1. Per-attempt rows are v2.

### 4.7 `Product` — phase B

What `import.csv` writes. A store knows a product by its own **SKU** (stock keeping unit — the
code it gives each item it sells), never by our `id`, so the SKU is the key an import matches on.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK. Generated by the database, because the import writes through raw SQL |
| `userId` | `uuid` | **DB** FK → `User`, `ON DELETE CASCADE` |
| `sku` | `text` | **DB** `CHECK` not blank |
| `name` | `text` | **DB** `CHECK` not blank |
| `description` | `text?` | |
| `priceCents` | `int` | Whole minor units, never a float. **DB** `CHECK (priceCents >= 0)` |
| `currency` | `text` | ISO 4217. **DB** `CHECK (currency ~ '^[A-Z]{3}$')` |
| `imageUrl` | `text?` | As written in the file — untrusted until phase C's outbound guard has checked it |
| `imageStatus` | `text?` | `READY` or `FAILED`: what `image.process` concluded about `imageSourceUrl` (§6.3c). **DB** `CHECK` |
| `imageSourceUrl` | `text?` | The `imageUrl` that conclusion is about. Set exactly when `imageStatus` is (**DB** `CHECK`). Once an import replaces `imageUrl`, the two differ and the image reads as not processed yet — nothing has to clear the old conclusion |
| `imageError` | `text?` | Why the image at `imageSourceUrl` could not be used. **DB** `CHECK`: only when `FAILED` |
| `createdAt` / `updatedAt` | `timestamptz(6)` | |

**DB** `UNIQUE (userId, sku)` — per store, because two stores' `A-1` are unrelated. This is what
makes a replayed batch harmless (A14): the import writes each batch with **one**
`INSERT … ON CONFLICT ("userId", sku) DO UPDATE`, so a batch written twice leaves the table as one
write did, and the import never needs to know whether it ran before. The rows go in `sku` order:
each is locked as it is written, so two imports into one store writing the same skus in different
orders would otherwise each hold a row the other waits for (`40P01`); in one order the second
simply waits. The CHECKs are the floor under
the import's own row validation, not a substitute for it. Later phases add their own columns —
image variants (C), enrichment (D) — in their own migrations.

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
| `CANCELLED` | **yes** | Its owner asked it to stop, and it stopped without leaving a step half done. Reached from `QUEUED` by the API, or from `RUNNING` only by the worker (§5.2). |

Five states, one of which is the dead letter and one the acknowledged cancellation. `RETRYING` is deliberately absent — a job waiting
for its next attempt is `QUEUED` with `attempts > 0`, which is the same fact with one less state
to guard. Revisit if the status stream turns out to be unreadable without it (§16, D3b).

### 5.2 Legal transitions — everything not listed is illegal

| From | To | Actor | Guard (the `WHERE` clause is the truth) |
|---|---|---|---|
| — | `QUEUED` | API | `INSERT`; unique violation on `(userId, idempotencyKey)` = replay |
| `QUEUED`, `RUNNING` | `RUNNING` | Worker (`claim`) | `WHERE id = ? AND status IN ('QUEUED','RUNNING')`, sets `attempts = attempts + 1`, `lease = lease + 1`, `startedAt`. From `RUNNING` it is a redelivery after a stall or a crash: the new lease outranks the attempt that lost the job (D7) |
| `RUNNING` | `SUCCEEDED` | Worker | `WHERE id = ? AND status = 'RUNNING' AND lease = ?` |
| `RUNNING` | `QUEUED` | Worker, attempt failed | `WHERE id = ? AND status = 'RUNNING' AND lease = ?`. Whether to retry — `attempt < maxAttempts` and not terminal — is the processor's decision; no SQL checks the budget |
| `RUNNING` | `QUEUED` | Worker, shutting down (`release`) | `WHERE id = ? AND status = 'RUNNING' AND lease = ?`, sets `attempts = attempts - 1` — the handler stopped at a safe point because the worker is going away (§7.6a) |
| `RUNNING` | `DEAD_LETTERED` | Worker | `WHERE id = ? AND status = 'RUNNING' AND lease = ?` — a terminal error or the budget spent |
| `QUEUED`, `RUNNING` | `DEAD_LETTERED` | Worker, the queue gave up (`abandon`) | `WHERE id = ? AND status IN ('QUEUED','RUNNING') AND attempts > 0` — no lease: the queue failed the job outside any attempt (§7.6). `attempts > 0` keeps it off a job re-driven since |
| `QUEUED`, `RUNNING` | `DEAD_LETTERED` | Worker, the sweep (`abandonStranded`) | `WHERE id = ? AND status = ? AND lease = ? AND NOT EXISTS (a newer outbox row)` — the status, lease and delivery the sweep read, so a job claimed or re-driven since is left alone (§7.6) |
| `DEAD_LETTERED` | `QUEUED` | API (re-drive) | `WHERE id = ? AND status = 'DEAD_LETTERED'`, resets `attempts = 0`, `cancelRequested = false`, `progress`, `result`, `error` — never `lease`, never `effectCommitted`; `checkpoint` only with `?from=start` (D26) |
| `QUEUED` | `CANCELLED` | API (cancel) | `WHERE id = ? AND status = 'QUEUED' AND cancelRequested AND NOT effectCommitted` — nobody is running it, so the API may finish it |
| `QUEUED`, `RUNNING` | `CANCELLED` | Worker, **before** claiming | `WHERE id = ? AND status IN ('QUEUED','RUNNING') AND cancelRequested AND NOT effectCommitted` — a retry or a redelivery that arrives after the request runs no handler |
| `RUNNING` | `CANCELLED` | Worker, after the handler stopped | `WHERE id = ? AND status = 'RUNNING' AND lease = ? AND cancelRequested` — the handler threw `JobCancelledError` at a boundary |

**Every write a worker makes on a claimed job carries `lease = <the lease it claimed>`** — each
transition above, a progress report, a checkpoint and an effect alike — so an attempt that lost the
job, to a redelivery or to a re-drive, writes nothing over whoever holds it now.

**A job whose effect has committed is finished only by its handler.** The two cancels that run no
handler cannot see whether a charge went through, so they refuse a job marked `effectCommitted`;
the delivery claims it instead, the handler's ledger insert proves the charge, and the job ends
`SUCCEEDED`, deduplicated. The mark is a column of the job row, written in the effect's own
transaction, rather than "a ledger row exists": a cancel waiting on the row's lock re-checks only
that row, and would not see a ledger row committed meanwhile. Postgres refuses the combination
outright as a floor.

**There is no edge from `RUNNING` to `CANCELLED` for the API.** A running handler may be mid-effect, and a row that said `CANCELLED` about a charge that went through anyway would be a lie. The API sets `cancelRequested` and the worker decides.

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

Routes sit at the root — there is no global prefix or version segment. Every route requires a
valid access token except `/auth/register`, `/auth/login`, `/auth/refresh`, `/health` and `/ready`.

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
| `POST` | `/jobs` | access | **`202`** / `422` | Persist + enqueue. `422 IDEMPOTENCY_KEY_REUSED` when the key was first used with a different body; `422 UPLOAD_NOT_FOUND` when an `import.csv` names a key that is not the caller's or was never uploaded. See §6.3 |
| `GET` | `/jobs/:id` | access | `200` | 404 for a job you don't own — never 403 |
| `GET` | `/jobs/:id/error-report` | access | `200` / `404` | `{ url, expiresAt }`: a link, signed on each call and valid for 5 minutes, that downloads a succeeded import's error report. `404 JOB_NOT_FOUND` for a job you don't own; `404 ERROR_REPORT_NOT_FOUND` when it has not succeeded, every row was valid, or the report has expired. See §6.3b |
| `GET` | `/jobs` | access | `200` | Newest first. Filter `?status=`, `?type=`; `?limit=` (1–100, default 20) and `?cursor=` from the previous page. Returns `{ items, nextCursor }`, `nextCursor` `null` on the last page. No `total`, no `offset` (D14) |
| `GET` | `/products` | access | `200` | The caller's catalog in `sku` order, paged like `/jobs`: `?limit=`, `?cursor=` → `{ items, nextCursor }` (D14). Each product carries `image` (§6.3c) |
| `POST` | `/jobs/:id/retry` | access | `202` | Re-drive a `DEAD_LETTERED` job. It resumes from its checkpoint; `?from=start` discards it and does the work again from the beginning. Phase 6. See D6b, D26 |
| `POST` | `/jobs/retry` | access | `202` | Re-drive the caller's dead letters matching `{ type?, errorCode?, deadLetteredFrom?, deadLetteredTo? }` — at least one required — a bounded batch (`limit`, default 500, max 1000) per call. Returns `{ redriven, remaining }`; call again until `remaining` is 0, with `deadLetteredTo` set so jobs that die again meanwhile are not picked up again. `dryRun: true` counts and changes nothing. Every job resumes from its checkpoint — there is no bulk `from=start`; restart one with `POST /jobs/:id/retry?from=start`. An `import.csv` whose upload has expired (7 days, §13.4) dead-letters again at once, `TERMINAL_FAILURE`. See D11 |
| `POST` | `/jobs/:id/cancel` | access | `202` / `409` | `202`: `CANCELLED` if it had not started; still `RUNNING` with `cancelRequested` if a handler has it; still `QUEUED` with `cancelRequested` if its effect has already committed — it will end `SUCCEEDED`, since a charge that went through cannot be undone by saying so (§5.2); or **already** `CANCELLED`, so a retried cancel gets the first answer again. `409 JOB_ALREADY_FINISHED` if it had succeeded or been dead-lettered — the cancel changed nothing, the same way a re-drive of a job that is not dead-lettered is a `409` |
| `POST` | `/uploads` | access | `200` | A signed upload slip for one CSV, sent straight to S3 — the API never sees the file. See §6.3a |
| `GET` | `/health` | — | `200` | Liveness — process is up. No dependency checks |
| `GET` | `/ready` | — | `200`/`503` | Readiness — Postgres and Redis reachable *now* |

`404`-before-`403` on ownership: a job belonging to another user is *not found*. The API does not
reveal that a resource exists to someone with no right to it.

### 6.3 `POST /jobs` — the submit contract

**Request**

```
POST /jobs
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

**A replay has to be the same request.** The body is fingerprinted — SHA-256 of its canonical
JSON, after defaults are applied and with object keys sorted — and the fingerprint is stored on
the row. A later request with the same key and a different fingerprint is
`422 IDEMPOTENCY_KEY_REUSED` and changes nothing: a client that reused a key for a *different*
charge must not be told its new charge was accepted when the old one is what exists (D28).

Because the response body is derivable entirely from the existing `Job` row, **no separate
idempotency-record table is needed** for the submit boundary. If the response ever grows a field
that is not on the row, that stops being true and a stored-response table becomes necessary.

`202`, not `200` or `201`: the work has been *accepted*, not *done*. The client polls
`GET /jobs/:id` or listens on the socket.

**Payload per type.** The union in §6.4 is the authority; unknown keys are a `400`.

| Type | Field | Range | Default |
|---|---|---|---|
| `MOCK` | `durationMs` | `0`–`60000` | `10` |
| | `failureRate` | `0`–`1` | `0` |
| | `steps` | `1`–`100` | `1` |
| `CHARGE` | `amountCents` | positive int | required |
| | `reference` | 1–200 chars | required |
| | `delayMs` | `0`–`60000` | `0` |
| `import.csv` | `key` | a key from `POST /uploads` (§6.3a), the caller's own, uploaded | required |
| `image.process` | `skus` | 1–50 skus, each 1–100 chars; any the caller has no product for are reported, not refused | required |

`maxAttempts` is on the body itself, not the payload: `1`–`20`, default `5`.

### 6.3a `POST /uploads` — the upload contract (D29)

A file never passes through the API. The client asks for a **signed upload slip**, sends the file
**straight to S3** with it, and only then names the uploaded key in the job it submits.

```
POST /uploads                      (no body)
→ 200 { "key": "uploads/<userId>/<uuid>.csv",
        "url": "https://<bucket>.s3.<region>.amazonaws.com/",
        "fields": { "key": "…", "Policy": "…", "X-Amz-Signature": "…", … },
        "maxBytes": 52428800, "expiresAt": "…" }
```

- **The server mints the key**, under the caller's own prefix, so a client can neither overwrite
  another tenant's file nor name a path an import would trust.
- **Send it as a form:** `multipart/form-data` to `url`, every entry of `fields` first, then the
  file as `file`, **last** — S3 ignores anything after the file. Success is S3's `204`.
- **S3 enforces the signed policy itself**: that key, a size of 1 byte to `maxBytes` (50 MB), and
  the 5-minute expiry. Breaking any of them is S3's answer, not ours: `403` for a changed key or
  an expired slip, `400 EntityTooLarge` / `EntityTooSmall` for the size.
- `200`, not `201`: nothing exists yet, and nothing on the API side records the request. An upload
  the client never follows with a job is an orphan; the bucket's lifecycle rule removes it.

### 6.3b `import.csv` — the file and what comes back

The job's payload is `{ key }`, the key `POST /uploads` minted. At submit the API refuses — as
`422 UPLOAD_NOT_FOUND`, the same answer for both, so a probe learns nothing — a key outside the
caller's own prefix and a key with no file behind it, so a client that submits before S3 has
answered its upload learns so then and not from a dead letter. A **replay** of an import already
accepted is still answered as one after its file has expired from the bucket (D1). The worker
checks the prefix again: what it runs is the stored row, not the request the API checked.

**The file.** A header row is required, matched case-insensitively, after an optional byte-order
mark; any other column is ignored, because a store export carries dozens.

| Column | Required | Rule |
|---|---|---|
| `sku` | ✓ | 1–100 characters |
| `name` | ✓ | 1–500 characters |
| `price` | ✓ | A decimal such as `19.99`: up to 7 whole digits and 2 decimals, read into cents from the text, never through a float. Two decimals is right for EUR and USD and wrong for a currency such as JPY |
| `currency` | ✓ | Three letters, any case, stored upper-case |
| `description` | | Up to 5000 characters |
| `imageUrl` | | `http` or `https` only — it is fetched in phase C |

**What happens to it.** The file is read as a stream and written 500 valid rows per statement
(§4.7, D30), so memory holds one batch however long the file is: while a batch is being written
the parser asks for no more, the download pauses, and S3 waits. A **bad row** — a missing cell, a
price that does not parse, a NUL character Postgres cannot store (§6.4) — is counted and skipped;
it never fails the import. A **bad file**
fails it at once as a terminal error, because no retry can fix it: a header without a required
column, CSV that does not parse, a key that is another account's, a file that no longer exists. A
row is capped at 64 KB of content and at 1 000 fields, both while it is still being read, so
neither an unclosed quote nor a line of bare commas — empty fields have no content to count — can
pull the file into memory. The fields are counted by the parser's per-field hook, which is why
the header names the columns after parsing rather than through the parser's own `columns`
option: that option skips the hook for every field past the header's last.
Rows written before a bad file is discovered stay written.

**Progress and cancellation.** After each batch the job reports `processed` — rows read so far,
bad ones included — with no `total`, because a stream does not know its length. The batch
boundary is also where a cancellation is honoured: a cancelled import has committed whole batches
and started none it did not finish, and keeps its `progress`, so the client sees how far it got
(A11).

```jsonc
// result, on success
{ "rows": 1201, "imported": 1200, "invalid": 1,
  "invalidSamples": [ { "line": 1202, "reason": "name: Too small: expected string to have >=1 characters" } ] }
```

`line` is the line in the file the row ends on, counting the header as line 1. Only the first ten
bad rows are sampled — a wrong file can have thousands, and the result is a row in Postgres; the
full list is the error report.

**The error report.** When any row was bad, the import ends by writing every bad row to
`reports/<userId>/<jobId>.csv` — its line, the reason, and the values it held — and
`GET /jobs/:id/error-report` answers with a link to it, signed on each call rather than stored in
`result`, where it would have expired before anyone clicked it. The report comes from a second
read of the file, not from rows collected during the import, because a resumed import never
looked at the rows before its checkpoint; reading is cheap next to writing a batch. It is streamed
to S3 as it is produced, so memory stays flat however many rows are bad, and written for a
spreadsheet: a byte-order mark so Excel reads it as UTF-8, and any cell starting `=`, `+`, `-` or
`@` prefixed with `'`, so a formula in the seller's own file is shown rather than run. One per job,
so a re-run overwrites it; the bucket's 7-day lifecycle rule removes it.

```
line,reason,sku,name,price,currency,description,imageUrl
3,"name: Too small: expected string to have >=1 characters",B-2,,5,EUR,,
```

**A wrong file fails fast.** When more than half of the first 100 rows — or of the whole file, if
it is shorter — are bad, the import is not data with problems but the wrong file: an export whose
prices have decimal commas, another shop's columns under the right headers. It fails as a
terminal error with `error.reason: 'IMPORT_MOSTLY_INVALID'` before anything is written, since 100
rows is less than a batch, and leaves no report. Bad rows after the first 100 never fail an
import; they go in the report.

**Resuming.** Each batch commits together with a checkpoint — the records it reaches, the running
counts, and the file's S3 `ETag` — so an import that crashes, fails an attempt, or is re-driven
continues after its last committed batch instead of at row 1 (D26, A14). It reads the file from
the top again, because only parsing finds where a CSV record ends, but skips the records the
checkpoint covers without validating or writing them; the counts it reports are the whole file's.
The file is reopened only if its `ETag` still matches: the upload slip is reusable until it
expires, and a resume over different bytes under the same key would skip rows nobody imported, so
a replaced file is a terminal error and `POST /jobs/:id/retry?from=start` imports it from the top.
A resumed import reports its checkpoint as its first `processed`.

### 6.3c `image.process` — a batch of product images

The payload names up to 50 of the caller's skus: a batch, because one job per product makes a
20 000-product catalog 20 000 jobs, and one job for the catalog lets a single slow image hold up
the rest. For each product whose current `imageUrl` has no `READY` result yet, the worker
downloads it through the guard (§7.9) — `jpeg`, `png`, `webp`, `gif` or `avif`, at most 10 MB, 15 s
— and makes three WebP sizes with `sharp`: `thumb` 200, `medium` 600 and `large` 1200 pixels wide,
upright by their EXIF orientation, never enlarged, without the source's metadata, which can carry
where a photo was taken. A source over 40 megapixels is refused before it is decoded: a small file
can declare enormous dimensions and take gigabytes to open.

The sizes go to `products/<userId>/<productId>/<hash of the source URL>/<size>.webp`. The source
URL is in the key so that a slow job still making a URL the seller has since replaced writes beside
the new image rather than over it; the key is otherwise fixed, so a re-run overwrites its own
files with the same bytes and needs no ledger. The files are written first and the product
recorded `READY` second, and only while `imageUrl` still equals the URL that was processed — a
crash between the two leaves files nothing points at yet, never a row pointing at missing files,
and an import that replaced the URL meanwhile wins. A replaced URL's old files stay in the bucket
for now. Deleting them when the new image is recorded is not safe: if the seller switches back to
the old URL while a slow job is still finishing, that job's late delete removes the files the row
points at again. A sweep that deletes a folder only when it is not the current URL's **and** has
not been written for a day is planned instead (M8.8): a re-render rewrites the folder, so its age
says no job is using it.

Between products the job reports `processed` out of `total` and honours a cancellation, so a
stopped batch has recorded whole images only. A product already `READY` for its current URL is
skipped, which is what lets a retry redo only the rest.

An image that cannot be made marks its product, not the job (D31). A failure another try cannot
change — a 404 or another 4xx, a host that does not exist, a refused address, a type that is not
an image, bytes that do not decode, a source over the pixel limit — records the product `FAILED`
with the reason, and the batch goes on. One that might pass later — a timeout, a 5xx, a 408 or a
429 — leaves the product `PENDING` and the batch goes on as well; once every product has been
tried, the attempt fails, so the job is retried and the retry skips what is `READY` (A17). On the
job's last attempt no retry is coming, so such a product is recorded `FAILED` too, as `Gave up
after 5 attempts: <reason>`, and the job succeeds; left `PENDING`, nothing would ever finish it. A bad
URL costs its own product one download, never the rest of the batch their images. A `FAILED`
product is tried again by any later run that names it, a retry included: the seller may have
fixed the file behind the same URL, and naming the sku again is how they ask.

```jsonc
// result
{ "requested": 3, "processed": 1, "failed": 0, "superseded": 0, "alreadyReady": 1,
  "withoutImage": 0, "notFound": ["X-9"] }
```

`superseded` counts products whose URL changed while the job worked on the old one. In
`GET /products`, each product's `image` is `null` without an `imageUrl`, `{ "status": "PENDING" }`
until its current URL is processed, `{ "status": "READY", "thumb", "medium", "large" }` with links
signed for an hour on each read, or `{ "status": "FAILED", "error" }`.

### 6.4 Validation

Nest 12's first-party `StandardSchemaValidationPipe` with Zod schemas, registered globally.
`nestjs-zod` is **not** used (§13.2).

- Body, params, and query validated at the edge; services assume clean input.
- `.strict()` on every object schema **at the edge** — mass-assignment protection. A client
  cannot smuggle `status`, `attempts`, or `userId` into a submit body, and a mistyped payload
  field is a `400` instead of a silently applied default.
- `payload` is validated by a **discriminated union on `type`**, so a `CHARGE` payload missing
  `amountCents` is a `400` at the edge, not a terminal failure discovered in a worker four
  seconds later.
- Path `:id` is validated as a UUID — a malformed id is a clean `400`, not a `500` from a
  Postgres cast error.
- **Text bound for Postgres refuses U+0000** (`storableText`), the one character `text` and
  `jsonb` cannot store. Let through, it fails the whole write it is part of: a submit answers
  `500`, an import batch fails on every attempt until the job dead-letters. Refused at the edge it
  is a `400`, or one bad row with its reason. The worker's re-parse can carry the same check,
  since no stored value holds the character.
- **The worker re-parses the stored payload** before running it, against the same per-type
  schema but **without `.strict()`**. The row it reads may have been written by a newer deploy,
  so an unknown field is dropped and ignored. Rejecting it would dead-letter every job in
  flight during a rollout — and because that failure is terminal, BullMQ would never hand those
  jobs to the new worker that does understand the field. Unknown-key strictness is part of the
  client contract, not of execution.

Three checks, three homes: shape → pipe (`400`); business rules → service
(`404`/`403`/`409`); integrity → database. The worker's re-parse is a fourth, answering a
different threat: not a bad client, but a schema that moved underneath a row already queued.

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
either: since §7.5a that is `${jobId}.${outboxId}`, new for every re-drive, so a key built on it
would let a re-driven job repeat an effect that already landed.

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

BullMQ implements the backoff: `backoff: { type: 'exponential', delay: 1000, jitter: 1 }`, where
`jitter: 1` is full jitter — a delay drawn between 0 and the computed one. `jobOptions()` in
`job-queue.ts` builds it for the direct path and the relay alike. Which counter is *policy* is D7.

### 7.5a One queue entry per outbox row

The BullMQ job id is `${jobId}.${outboxId}`, not `jobId`. This is forced by two facts that
only show up together:

- `add()` is **silently ignored** when a job with that id already exists in any set, including
  the `completed`/`failed` sets that `removeOnComplete`/`removeOnFail` retain. It returns the
  existing job, so the caller cannot tell the difference from the return value.
- `remove()` **refuses a locked job** and returns `0` rather than throwing.

With a job-scoped id, a re-drive issued while an earlier delivery still holds the lock therefore
removed nothing, enqueued nothing, and reported success — and `markPublished()` then stamped the
outbox row, disarming the one guard that would have recovered it. A re-drive is a **new message**,
so it gets a new row and a new entry, and `add()` can only ever collide with a redelivery of the
same message, where deduplication is the correct behaviour. Duplicate *delivery* is still handled
where it always was: `claim()` and `effectKey`, not the queue id.

(`.` as the separator because BullMQ rejects `:` in a custom job id unless it splits into exactly
three parts — the same restriction that renamed the queue in §8.1.)

### 7.6 Stalled jobs — what BullMQ actually does

Worth stating precisely, because the mental model most people have is wrong:

- **There is no `stalled` state.** There is a *stalled event*, fired when an active job's lock is
  not renewed within the check window (~30 s default).
- A stalled job is moved **back to wait** and redelivered. Once `maxStalledCount` (default **1**)
  is exceeded it is *still* moved back to wait, but with a deferred failure recorded
  (*"job stalled more than allowable limit"*); the next worker to pick it up short-circuits to
  its failure path instead of running it. The queue never fails it in place.
- **A job can stall itself.** Blocking the event loop prevents lock renewal, so a CPU-bound
  processor is redelivered even though nothing crashed. This is why `MOCK` must `await sleep()`
  and never spin — otherwise reliability measurements reflect the fixture, not the system.
  Filling libuv's threadpool does not (D10): a renewal is a command on an open socket, and only
  DNS lookups, file access and `sharp`'s own work wait for a pool thread.
- A stall-induced redelivery is **not** an error retry. It interacts with whichever attempt
  counter D7 makes authoritative, and the two counters will diverge the first time it happens.
- **When `maxStalledCount` is exceeded, `process()` is never called.** The worker reads the
  deferred failure the stalled-checker wrote and goes straight to `handleFailed`, so no code in
  this repo observes the job — it would stay `RUNNING` for ever, below its own retry budget, and
  `POST /jobs/:id/retry` would refuse it because the row is not `DEAD_LETTERED`. The worker must
  therefore finalise from the `failed` **event**, gated on `job.finishedOn`: `failed` fires on
  every failed attempt, but `finishedOn` is set only once the queue has stopped redelivering.
- **That event is heard once — the one at-most-once step in the system.** It fires in memory, in
  one worker; if that worker dies before `abandon()` lands, or Postgres refuses the write, nothing
  ever fires it again, and the row stays `RUNNING` past both a re-drive and a cancel. So every
  worker also runs a **sweep** (`RELAY_SWEEP_INTERVAL_MS`, default 60 s): a `RUNNING` row whose
  latest queue entry is missing, or finished more than 30 s ago, is dead-lettered
  `DELIVERY_ABANDONED`. It asks the queue, not a clock — a long job is legitimately `RUNNING` for
  hours — and leaves waiting, delayed and active entries alone. The 30 s keeps the event the normal
  path and the sweep its backstop rather than a racer. The write is pinned to the status, the
  `lease` and the delivery (no newer outbox row) the sweep read, so a job claimed or re-driven in
  between is never finished on stale evidence. It also finishes a processor that returned without
  finishing its row, whose entry ends `completed`.
- **A job no attempt ever claimed is the sweep's too.** With Postgres unreachable, the check
  before the claim throws on every delivery, and the queue fails the entry with the row still
  `QUEUED` at `attempts = 0`. `abandon()` refuses that row: it stands `attempts > 0` in for the
  ownership token it does not have. So the sweep reads `QUEUED` rows as well, once their latest
  outbox row is published — before that they wait for the relay, not the queue. They are
  dead-lettered rather than re-enqueued: an enqueue would hide what went wrong (a Redis that lost
  its data would be refilled silently) and could loop on a cause that persists, while a dead letter
  is visible and one re-drive by `errorCode` brings them all back. The sweep costs one Redis read
  per unfinished job per tick, and pages by `id > last` rather than an offset, since the last row
  of a page is often the one it has just finished.

### 7.6a Shutdown — a deploy hands running work back

`SIGTERM` is a deploy, not a failure, and must cost a running job neither its work nor an attempt.

- **The worker drains before anything it uses is closed.** Nest runs every module's
  `onModuleDestroy` before any `onApplicationShutdown`, and `@nestjs/bullmq` closes its workers
  in the second; the S3 client and Redis close in the first. So `JobsProcessor` closes the BullMQ
  worker in its own `onModuleDestroy`, which runs first because its module is the root — Nest
  destroys modules in the reverse of their init order. Draining any later, a job mid-upload loses
  its S3 client and a retry is spent on a deploy.
- **A running handler is told to stop at its next safe point.** From the signal on,
  `shouldStop()` is true (D22), so an import stops after its committed batch and an image batch
  after the product in hand. A drain that waited for whole jobs could outlast the orchestrator's
  grace period — Docker's is 10 s — and end in `SIGKILL` and a stall.
- **The stopped job goes back to the queue unspent.** The row moves `RUNNING → QUEUED` with
  the attempt given back (`release`, §5.2), and the queue entry moves to delayed rather than
  failing, which would spend one of the queue's attempts and wait out a backoff. The next worker
  claims it and resumes from what was committed. A cancel requested meanwhile wins: the job ends
  `CANCELLED`, not queued.
- **A handler with no safe point runs to the end of its drain.** `CHARGE` has one effect and
  calls no `shouldStop()`; if it outlasts the grace period it is killed and redelivered like any
  crash, and the ledger dedupes the effect (§7.1).

Measured by A5e: the drain takes under a second mid-batch, the product in hand reaches S3 after
the signal, and the job finishes on the next worker at `attempts = 1`.

### 7.7 Error taxonomy

The worker classifies every failure into exactly one of three:

| Class | Example | Worker behaviour |
|---|---|---|
| **Transient** | DB connection blip, mock random failure, an image host that is down | Throw a plain `Error`, or a `RetryableJobError` when its message is written for the job's owner → BullMQ retries with backoff |
| **Terminal** | Payload fails a business rule, user deleted, unknown job type | Throw `TerminalJobError`; the processor dead-letters the job and throws **`UnrecoverableError`** → no further retries |
| **Poison** | Repeated transient failures that exhaust `maxAttempts` | Falls through to `DEAD_LETTERED` on the last attempt |

Without this taxonomy, a validation bug burns all five attempts over 31 seconds and lands in the
dead letter with a useless error message. (`UnrecoverableError` replaces the removed
`Job#discard()` from BullMQ v5.)

**What a job's owner reads.** `error.message` reaches the owner through `GET /jobs/:id` and the
socket, so it follows the HTTP filter's rule: only an `AppError`'s message — words written for the
owner, as `TerminalJobError`'s and `RetryableJobError`'s are — is stored as it is. Anything else
(Prisma naming a table, S3 naming the principal it refused, a socket naming an internal address) is
stored as `Internal error; the worker's log has it under correlationId <id>`, and the worker logs
the text. The correlation id is the submit's request id, which the owner already holds. A `failed`
event's message is stored only when it is an `UnrecoverableError`: BullMQ's own (a stall past the
limit) or the processor's, already made safe.

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

### 7.9 Requests to a URL a user supplied

A product's `imageUrl` is the seller's, and the worker fetches it from inside our network. Left
unguarded that is server-side request forgery: `http://169.254.169.254/latest/meta-data/` hands
the attacker the cloud credentials of whatever host the worker runs on. Every such request goes
through `GuardedDownloader` (`src/outbound/`), which allows only what the seller could reach
themselves:

- **`http` or `https`, port 80 or 443, no credentials in the URL.** A port is a choice of
  service; allowing any would let a URL probe whatever else a public host runs.
- **Public unicast addresses only — an allow-list.** Every other range has a name in `ipaddr.js`
  (loopback, private, link-local, carrier-grade NAT, multicast, and the IPv6 forms that carry an
  IPv4 address inside: mapped, NAT64, 6to4, Teredo), so none has to be remembered to be refused.
- **The address is checked inside the connection's own DNS lookup**, on the addresses it will
  connect to — every one of them, since a name answering one public and one private address
  leaves the choice to the connection. Checking the name first and connecting after would resolve
  it twice, and a name can answer public to the check and private to the connect (DNS rebinding).
  For the same reason no socket is pooled: a reused one would skip the lookup.
- **An address written as the host is checked separately.** Node does not run the lookup for an
  IP literal, so without this check `http://10.0.0.1/` would connect. The URL parser has already
  normalised `2130706433` and `0x7f.1` to `127.0.0.1`.
- **Redirects are followed by hand, at most 3, and each is checked like the first URL** — a
  redirect to the metadata service is the classic way past a guard that looks only at the URL it
  was given.
- **One timeout for the whole download, a byte cap counted as the bytes arrive** — a declared
  length can be absent or a lie — and a content-type the caller names.

Every failure says whether asking again could change it: a refused address, a 404, a 4xx other
than 408 and 429, a host that does not exist or a certificate that does not verify are permanent;
a timeout, a 5xx, a 408 or a 429 are not (§7.7). A message names what was refused, never what a
host name resolved to: it reaches the URL's owner as the product's `image.error` (§6.3c), and a
resolved internal address would map the network for whoever asks. For the same reason a name that
does not exist is answered exactly as one that resolves privately: told apart, the two would let a
seller list which internal names exist, one URL at a time.

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
// jobOptions(jobId, outboxId, maxAttempts) in job-queue.ts — the direct path and the relay both use it
{
  jobId: messageId(jobId, outboxId),  // `${jobId}.${outboxId}`: one entry per outbox row (§7.5a)
  attempts: maxAttempts,
  backoff: { type: 'exponential', delay: 1000, jitter: 1 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86_400 },
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
> **Status: RESOLVED in phase 6.** Trigger was: a killed worker leaves a row stuck in `RUNNING`.
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
> **DECIDED (phase 6) — claim (b), BullMQ redelivery, and `Job.attempts`.** `claim()` matches
> `status IN ('QUEUED','RUNNING')`: an allow-list refused `CANCELLED` the day it was added, where
> (c)'s deny-list would have let a worker claim and run a cancelled job. A dead worker's row is
> reconciled by BullMQ's stalled redelivery, whose `claim()` takes the `RUNNING` row over; a job
> past `maxStalledCount` is finalised from the `failed` event, and a sweep finishes the one that
> event loses (§7.6). `Job.attempts` is authoritative for policy; `attemptsMade` counts only
> failures, so it never reaches the budget first, and is observability. The ownership token is a
> second counter, `Job.lease`, which every claim increments and nothing resets. Until 2026-11-04 the
> token was `attempts` itself — and a re-drive's reset made it repeat, so a worker frozen in a
> job's previous life matched the first claim of its next one and its writes landed (A3c). Two
> counters, two jobs.

> **DECISION — D6b · What is the dead-letter path, physically?**
>
> **Status: RESOLVED in phase 6.** Trigger was: the first job that actually dies. The spec leaned
> (a), and the code confirmed it.
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
> **DECIDED (phase 6) — (a).** `status = 'DEAD_LETTERED'` with `error = { code, reason?, message, attempt? }`
> (no `attempt` when the queue abandoned it, since no attempt owned it), `code` one of `DEAD_LETTER_CODES` (`TERMINAL_FAILURE`, `ATTEMPTS_EXHAUSTED`, `DELIVERY_ABANDONED`). A
> re-drive reuses the row, its `id` and so its `effectKey`: a re-driven job whose effect already
> landed dedupes rather than repeating it.

---

## 9. Realtime contract

### 9.1 Connection and auth

- Socket.io via `@nestjs/websockets` + `@nestjs/platform-socket.io`, namespace `/events`.
- **Authenticated on connect**, not per message — a socket cannot carry an `Authorization` header
  per frame. The access token is passed in the handshake `auth` payload; an invalid or expired
  token means the connection is refused, not degraded.
- Authentication is **socket.io middleware**, not `handleConnection`. Middleware rejects during the
  handshake, so the client gets a `connect_error` and never holds a connected socket; refusing in
  `handleConnection` accepts the connection and then drops it, which is "degraded", not "refused".
- On successful connect the socket joins the room `user:<userId>`. **The server assigns the room
  from the verified token — never from anything the client sends.** Identity from the token,
  ownership from the DB; the moment either comes from client input the check collapses.

### 9.2a Crossing the process boundary — D8

Transitions happen in the worker; sockets live in the API. The worker publishes a **domain fact**
to a Redis pub/sub channel and the API decides who should see it:

```
worker  --PUBLISH relay:job-updated-->  redis  --SUBSCRIBE-->  api  --to(user:<id>)-->  client
```

Not the socket.io Redis adapter: that exists so several *socket.io servers* can share rooms. The
worker is not one and should not become one to emit — it would couple the worker to the transport.

**Pub/sub is at-most-once and that is deliberate.** An event published while the API is restarting
or a client is between reconnects is gone; nothing retries it. This is sound only because of A7:
Postgres is the source of truth (D4) and the client's recovery is to re-read `GET /jobs/:id`.

Events therefore **do not go through the outbox**, and the reason is the cost of losing one:

| | lost enqueue | lost socket event |
|---|---|---|
| consequence | the work never happens | a UI is stale for a moment |
| client can recover it? | no — nothing to re-read | yes — `GET /jobs/:id` |
| mechanism it earns | durable outbox row inside the transaction | fire-and-forget publish |

A row per status change would double write volume for data whose only consumer can re-read the
truth. Matching the mechanism to the cost of losing the message is the point; the heavyweight one
everywhere is as wrong as the cheap one everywhere.

Two mechanics that are easy to get wrong:

- **Publish after commit, never inside the transaction.** An event cannot be un-sent, so a publish
  inside a transaction that then rolls back has broadcast a state that never existed. `redrive()`
  runs its transition inside `$transaction`, so publishing lives at the call sites rather than
  inside `JobTransitionService`, where "after commit" would be invisible.
- **A subscribed ioredis connection refuses every other command.** The gateway subscribes on
  `redis.duplicate()` and leaves the shared client alone.

### 9.2 Events

| Event | Payload |
|---|---|
| `job.updated` | `{ id, status, attempts, result?, error?, progress?, cancelRequested?, updatedAt }` |

One event, fired on every status transition **and on a progress report**. Separate
`job.succeeded` / `job.failed` events are not worth the client-side branching when `status`
already carries it, and the same argument covers progress: a client's handler replaces its copy of
the job either way, so a second event type would only add a branch.

**Progress emits are throttled to one per job per 500 ms, and the last one always sends.** A
handler chooses how often it reports, and reporting per row would otherwise mean one publish, one
socket frame and one repaint per row — for a bar that repaints 60 times a second at best. Reports
arriving inside a window replace each other rather than queueing, because nobody wants a bar to
replay a backlog. The same window governs the **database write**, since the two are one decision
and splitting them would give a client two different staleness windows to reason about. Only one
write is ever in flight, and the window opens when it **settles**, not when it is sent: a database
slower than the window then slows the writes down, instead of having one queued behind the slow
write every window and replayed as a burst of stale values once it recovers.

The event is built from the row the guarded write returned, never from what the handler reported,
so a progress event cannot describe a state the database does not hold (§9.2a). A refused write
emits nothing.

### 9.3 Delivery guarantee — stated bluntly

**Best-effort. Not guaranteed.** A client that is disconnected during a transition misses that
event permanently; there is no replay buffer in v1.

Therefore: **`GET /jobs/:id` is the reconciliation path**, and the client contract is *on
connect and on reconnect, re-fetch the jobs you care about.* Assertion A7 tests exactly this. A
realtime channel that clients are allowed to treat as authoritative is a correctness bug wearing
a feature's clothes.

**Events can arrive out of order.** Two processes write a job's row — the API on a cancel, the
worker on everything else — and each publishes after its own commit, so a later state's event can
overtake an earlier one. Every event carries `updatedAt`: a client keeps whichever copy is newer
and drops an event older than the one it holds. `updatedAt` is stamped by the writing process's
clock, so between two machines it orders events only as well as their clocks agree, and
`GET /jobs/:id` settles any doubt.

**Emit after commit, never inside the transaction** (§7.8, rule 3).

> **DECISION — D8 · Who emits, and how does the event cross the process boundary?**
>
> **Status: RESOLVED in phase 7.** Trigger was: the first cross-process emission attempt. The
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
> **DECIDED 2026-10-26 — (a), a Redis pub/sub bridge,** at-most-once by design (§9.2a, §9.3).

---

## 10. Nest composition

### 10.1 Two root modules

```
AppModule  (bootstrap: NestFactory.create)
├── ConfigModule.forRoot({ isGlobal: true, validationSchema: apiEnvSchema })
├── LoggerModule.forRootAsync        (nestjs-pino)
├── BullModule.forRootAsync          (connection only — no queue registered at the root)
├── PrismaModule            (global; exports PrismaService)
├── RedisModule             (global; exports the ioredis client)
├── AuthModule              → AuthController, AuthService, TokenService, PasswordService,
│                             APP_GUARD: JwtAuthGuard
├── JobsModule              → JobsController, JobsService, OutboxRelayService
│    ├── imports JobCoreModule, StorageModule
│    ├── imports ScheduleModule.forRoot()                            // the relay's tick
│    └── imports BullModule.registerQueue({ name: 'relay-jobs' })   // PRODUCER ONLY
├── EventsModule            → EventsGateway (+ the bridge subscriber, D8)
├── HealthModule            → Terminus: Postgres + Redis
├── UploadsModule           → UploadsController, UploadsService (signs upload slips)
└── ProductsModule          → ProductsController, ProductsService

WorkerModule  (bootstrap: NestFactory.createApplicationContext)
├── ConfigModule / LoggerModule / PrismaModule   (same modules, worker env schema)
├── JobCoreModule
├── BullModule.registerQueue({ name: 'relay-jobs' })                 // CONSUMER
├── JobsProcessor           (WorkerHost)
└── StrandedJobSweeper      (finishes jobs the queue stopped delivering, §7.6)

JobCoreModule  (imported by BOTH roots: the domain, with no queue and no transport)
├── imports RedisModule, StorageModule, ProductsModule, OutboundModule
├── JobTransitionService    (every guarded status transition, §7.3)
├── JobHandlerRegistry      (resolves Job.type → handler; refuses to construct if a
│                            submittable type has none, so a gap fails at boot)
├── JobContextFactory       (the context a handler runs with: progress, checkpoints, stop)
├── JobEventsPublisher      (publishes to the D8 bridge)
└── one handler provider per `JOB_TYPES` entry

Leaf modules both roots reach: StorageModule (StorageService, the one S3 client), OutboundModule
(GuardedDownloader, §7.9).
```

`ProductsModule` reaches the worker through `JobCoreModule` with its controller; in an application
context nothing mounts it, so the worker still serves no HTTP.

**`AppModule` must never transitively import `WorkerModule`.** Shared code (Prisma, Redis,
config, the domain services the processor calls) lives in `JobCoreModule`, which both roots
import and which declares no processor and registers no queue. This is §3's rule made
structural.

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
| `RELAY_SWEEP_INTERVAL_MS` | int ≥1000 | — | ✓ | Default 60000. The stranded-job sweep (§7.6) |
| `RELAY_FAULT_AFTER_COMMIT` | bool | ✓ | — | Tests only (A6). Default `false` |
| `RELAY_FAULT_SKIP_ABANDON` | bool | — | ✓ | Tests only (A5d). Default `false` |
| `JOB_MAX_ATTEMPTS` | int | ✓ | ✓ | Default ceiling |
| `LOG_LEVEL` | enum | ✓ | ✓ | |
| `CORS_ORIGINS` | csv | ✓ | — | |
| `ARGONID_TIME_COST` / `ARGONID_MEMORY_COST` | int | ✓ | — | Defaults `2` and `19456` (KiB): OWASP's minimum for Argon2id. Every registration and login pays it, so raise them as far as the host's latency allows, never lower |
| `AWS_REGION` | str | ✓ | ✓ | The bucket's region (D29) |
| `S3_BUCKET` | str | ✓ | ✓ | The dev bucket locally and in CI, the prod bucket when deployed |
| `S3_ENDPOINT` | url? | ✓ | ✓ | Only for an S3-compatible emulator; unset for AWS |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | str | ✓ | ✓ | Read by the AWS SDK itself, not by the config schema, so a host with a role needs neither. Resolved at boot, so a missing key fails startup |

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
| `@nestjs/schedule` | 12.x | Hosts the outbox relay's tick. The stranded-job sweep keeps a plain timer: the registry stops its timers only after Prisma has disconnected (§7.6) |
| `prisma` / `@prisma/client` | 7.x | |
| `@prisma/adapter-pg` | 7.x | Driver adapter |
| `@aws-sdk/client-s3`, `@aws-sdk/s3-presigned-post`, `@aws-sdk/s3-request-presigner` | 3.x | S3 client, the presigned POST for uploads, the presigned GET for downloads (D29) |
| `@aws-sdk/lib-storage` | 3.x | `Upload`: streams a body of unknown length to S3 in parts — the error report, the image sizes |
| `csv-parse` / `csv-stringify` | 7.x / 6.x | The import's streaming reader and its error report's writer (§6.3b) |
| `sharp` | 0.35.x | Renders the image sizes (§6.3c) |
| `ipaddr.js` | 2.x | Classifies a resolved address as public or not, for the guarded downloader (§7.9) |
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

**Object storage is not in compose — it is a real S3 bucket (D29).** Once per developer, as an IAM
admin user (never the root user):

1. A bucket in the chosen region: ACLs disabled, Block Public Access on, SSE-S3, versioning off,
   and lifecycle rules **scoped by prefix**, because `products/` holds product images that must
   not expire: `uploads/` and `reports/` expire after 7 days, `fixtures/` (written by the tests)
   after 1, and incomplete multipart uploads are aborted after 1 day across the bucket. The tests
   that make product images delete their own account's `products/` folder when they finish
   (`test/support/product-images.ts`), since no rule ever will.

   A **CORS rule** too, once a browser uploads (the dashboard, PG): S3 answers a presigned POST
   from another origin only if the bucket allows it. Scripts and the tests need none, which is why
   nothing has failed without it.

   ```json
   [{ "AllowedOrigins": ["<the dashboard's origin>"], "AllowedMethods": ["POST"],
      "AllowedHeaders": ["*"], "MaxAgeSeconds": 3000 }]
   ```

   Downloads need no rule: a report link is navigated to, and an `<img>` loads cross-origin as it
   is.
2. An IAM user for the app — no console access, no group — with one inline policy:

   ```json
   { "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow",
         "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
         "Resource": "arn:aws:s3:::<bucket>/*" },
       { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::<bucket>" } ] }
   ```

   Objects and the bucket are separate resources: `/*` is every object, the bare ARN is the bucket
   itself, which `ListBucket` acts on — and without which a missing object reads as `403`, not `404`.
3. An access key for that user into `.env` (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`), with
   `AWS_REGION` and `S3_BUCKET`. CI reads the bucket and the key pair from repository secrets,
   and only on the two test steps that reach S3 — every step runs code from `node_modules`, and
   `npm ci` runs install scripts. The region is not a secret; `ci.yml` sets it.

**After pulling a change that touches `prisma/`:**

```
npm run db:migrate          # prisma migrate deploy — applies committed migrations
npm run db:generate:client  # src/generated/ is gitignored, so the client is rebuilt locally
```

Neither is optional and neither is automatic. Skipping the first fails at runtime with
`column "…" does not exist`; skipping the second fails to typecheck, because the generated client
has no such field. `db:migrate:dev` is the authoring command — it writes a new migration from a
schema edit — and is never what you want for someone else's change.

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
| **A3b** | **A stale worker must not write over the live one.** Freeze a worker mid-handler, let the stalled checker hand its jobs to a second worker, then thaw the first | Every job terminal and `SELECT count(*) FROM "Job" WHERE status NOT IN ('SUCCEEDED','DEAD_LETTERED')` **= 0**. **Inconclusive unless the log shows refused stale writes** — otherwise the interleaving never happened | 6 |
| **A3c** | **A worker from a job's previous life must not write over its next.** Freeze a worker holding a job's first claim; let the job be abandoned, re-driven and claimed again — as attempt 1, since a re-drive resets the budget — then thaw the first | The frozen worker's finish is **refused** (its log says it no longer owns the job) while the new life is still `RUNNING`; the job ends `SUCCEEDED` with `attempts = 1` and `lease = 3`. Fails if the token is a counter a re-drive resets | 6 |
| **A3d** | **A charge whose money moved never ends `CANCELLED`.** The owner cancels after the ledger row is in, the worker is killed, and the redelivery finds the request | `status = 'SUCCEEDED'`, `result.deduplicated = true`, one ledger row. With the mark removed it ends `CANCELLED` beside its ledger row; with the guard removed Postgres refuses the write (§5.2) | PA |
| **A5b** | **A job the queue abandons still terminates.** Stall a job past `maxStalledCount` so `process()` is never called again | `status = 'DEAD_LETTERED'` with `error->>'code' = 'DELIVERY_ABANDONED'`, exactly 2 deliveries against a budget of 5, and a re-drive that is *observed to be delivered* — a `202` alone is not evidence (§7.5a) | 6 |
| **A5c** | **A filtered bulk re-drive revives exactly the matching dead letters.** Dead-letter jobs under two error codes; re-drive one code with `limit` below the match count | Calls return `{ redriven, remaining }` until `remaining = 0`; every match ends `SUCCEEDED` with `attempts = 1`, its outbox row published **by the relay** (`Outbox.attempts = 1`); every non-match is untouched and has no outbox row | PA |
| **A5e** | **A deploy hands a running job back.** `SIGTERM` to a worker mid-way through an image batch, then a second worker | The worker exits in about a second; the product in hand when the signal came reaches `READY`; the job is `QUEUED` at `attempts = 0`, then `SUCCEEDED` at `attempts = 1` on the second worker; the first worker's log holds no retry and no closed connection (§7.6a) | PC |
| **A5d** | **An abandonment the `failed` event loses is still finalised.** A5b's two stalls, with the worker that hears the `failed` event dropping it | `status = 'DEAD_LETTERED'`, `error->>'code' = 'DELIVERY_ABANDONED'`, and the worker's log shows the sweep finished it **and not the event** — otherwise the event path passing would look the same | 6 |
| **A4** | **Redelivery of a succeeded job is a no-op.** Force redelivery of a `SUCCEEDED` job | `SUCCEEDED → RUNNING` never occurs; `SideEffect` count unchanged; the guarded update returns count `0` | 6 |
| **A5** | **A poison job dead-letters exactly once.** Submit a job that always fails; separately, queue one whose payload can never parse | `attempts = maxAttempts`; exactly one `DEAD_LETTERED` row; `error` populated; it never returns to `QUEUED` without an explicit re-drive. The unparseable one dead-letters on attempt 1 with `TERMINAL_FAILURE`, its budget unspent | 6 |
| **A6** | **The enqueue gap is real.** With a fault injected between commit and enqueue | A `QUEUED` job exists with no queue entry — i.e. **prove the hole exists in the v1 design**. After the outbox lands, the same test must show the job eventually runs | 6 |
| **A7** | **Realtime reconciles.** Disconnect a client mid-processing, reconnect after completion | The client's state from `GET /jobs/:id` equals the terminal state — a missed WS event never leaves a client permanently wrong | 7 |
| **A8** | **No status disagreement.** Only applicable if D4 chose "both" | After drain, no job's Redis-side state contradicts its Postgres state. **If this test cannot be written, D4 must be "Postgres only"** | 5 |
| **A9** | **Holds under load.** V virtual users for T minutes, one worker killed mid-run | A2 and A3 still hold. Record p95 submit latency, throughput, max queue depth, drain time — **name the numeric targets before running**, or the result is unfalsifiable | 10 |
| **A10** | **No side effect inside a transaction.** Enforced by review, not code — the `relay-reviewer` agent's checklist | Grep every `$transaction` block: it may write the ledger row, never perform the effect | ongoing |
| **A11** | **A cancelled job stops at a safe point.** Cancel a job mid-batch | `status = 'CANCELLED'`; effects committed **= batches completed before the flag was seen**, never a partial batch; cancelling an already-finished job is a no-op, not a status change. *In PA the per-step effect is the progress report; the ledger-count form needs batched effects and is asserted with the CSV import (PB)* | PA |
| **A12** | **Progress cannot go backwards or be forged.** Report progress from a stale attempt | The stale write matches 0 rows; `progress.processed` is monotonic for the life of one submission. An operator re-drive clears it and the count starts again (D25) | PA |
| **A12b** | **Progress is rate-limited, and the last value still lands.** Report 60 times across 3s, and 100 times as fast as the handler can (about 200 ms, inside one 500 ms window) | Events carrying `progress` are **> 1 and < 20**, not ~60; and the stored value equals the final report in both cases. The second case lands entirely inside one window, so only the processor's flush gets it out; a run slower than the window is reported skipped (inconclusive), since the window's timer may then have sent the last value | PA |
| **A13** | **A large import does not grow with the file.** In one worker, after a full-size warm-up, import 2 000 and then 20 000 rows of about 2 KB each (4 MB and 39 MB) | The worker's **live memory** — heap and buffers after a forced full collection, read by a probe loaded into it — peaks **less than 18 MB** higher for the large file: half the files' difference, so a worker holding even half of it fails. Measured +2.3 and +2.7 MB; a worker that buffers the file reads +62 MB | PB |
| **A14** | **An interrupted import resumes.** `SIGKILL` mid-import, restart | `SELECT count(*) FROM "Product" WHERE "userId"=$1` **= valid rows in the file**, with no duplicate `sku`; the resumed run starts from the checkpoint, not from row 0 | PB |
| **A15** | **The same file twice is one import.** Submit the same file with the same key | One `Job` row; the second response is the first job; product count unchanged | PB |
| **A16** | **A hostile image URL reaches nothing private.** `http://localhost`, `http://169.254.169.254`, and a public DNS name resolving to a private address | All three rejected **after resolution, before connect**; the product fails, the batch does not | PC |
| **A17** | **A permanent error does not burn the budget.** One batch: an image, a 404, a page, undecodable bytes, the metadata address | `attempts = 1` at `SUCCEEDED`; the four products `FAILED`, each with its reason; no backoff was waited (D31) | PC |
| **A18** | **Image batches do not self-stall.** Five batches of 20 of the heaviest image the limits allow, at the worker's concurrency of 5, timed by a probe inside the real worker | Zero `stalled` events and every product `READY`; event-loop delay and Redis round trip under 1 s, against the 15 s a renewal may be late. A single 40 s main-thread freeze fails it with 5 stalls (D10) | PC |
| **A19** | **LLM output is untrusted input.** Fake provider returns malformed JSON and an out-of-enum category | Nothing is written for those items; `enrichmentStatus = 'failed'` with a reason; the DB holds no value outside the taxonomy | PD |
| **A20** | **Rate limits slow the queue, not the jobs.** Fake provider returns 429 with `Retry-After` | No job reaches `DEAD_LETTERED` because of a 429; the queue's throughput drops and recovers | PD |
| **A21** | **Re-enrichment of unchanged products is free.** Run enrichment twice | Provider call count on the second run **= 0**; `estimatedCostUsd` unchanged | PD |
| **A22** | **A failed child does not fail the pipeline.** Force one enrichment batch to fail | `Pipeline.status = 'completed_with_errors'`; sibling batches completed; the failed batch is re-drivable; no `Job` row carries `completed_with_errors` | PE |
| **A23** | **The fan-out is idempotent.** Replay the fan-out for a pipeline | One `Job` row per `(stage, batch)`; the duplicate attempt is refused by `UNIQUE (userId, idempotencyKey)` | PE |
| **A24** | **The parent cannot be lost.** Crash between the last child committing and the parent being enqueued | The relay publishes the parent's outbox row; the pipeline finalizes exactly once | PE |
| **A25** | **Revocation is immediate.** Revoke a key, then use it | `401`, with no process restart | PF |
| **A26** | **A key's plaintext exists nowhere.** Create a key, then grep | The secret appears in no row and no log line; only `prefix` and the SHA-256 `hash` are stored | PF |

**A6 is written to fail against the phase-5 design.** The commit-then-enqueue gap is a knowingly
accepted risk; A6 quantifies it rather than leaving it undocumented.

---

## 15. Phases 8–11 — objectives fixed, detail deferred

In scope for v1. Their objectives and exit criteria are fixed below; the detailed design is
written at the start of each phase, because each depends on measurements that do not exist yet.
Specifying them now would produce prose that is wrong by the time it is used.

| Phase | Objective | Exit criterion | Detail written |
|---|---|---|---|
| **8 · Observability & hardening** | Prometheus `/metrics` from both processes: queue depth, duration histogram, failure rate, dead-letter count. Rate limiting, per-account caps on S3-backed work (D32), `trust proxy`, helmet, CORS allowlist, body limits. Dead-letter inspection and re-drive | Queue depth observably rises and drains under load; one job's full story is retrievable from logs by `correlationId` alone | Start of phase 8 |
| **9 · Test harness & CI** | The shared harness, fixtures and CI — **not** the tests themselves, which are written with the code throughout (§14). A1–A7 become automated cases including process kill/restart | `npm run test:all` reproduces every reliability assertion with no manual steps; CI green from a clean checkout | **§15.1** |
| **10 · Load** | k6 scenarios and A9 under sustained load with ≥2 workers. Numeric targets fixed **before** the run | Targets met or the gap documented; D6a closed with measurements attached, D10's repeated on the target host | Start of phase 10 |
| **11 · Deploy** | One VPS: Docker running API + worker, Caddy for auto-HTTPS, `ufw`, managed Postgres, restart policies, migrations as a release step. Multi-instance socket.io (D13) becomes real here | HTTPS on a real domain; a reboot restores both processes unattended; a restore from backup has been rehearsed | Start of phase 11 |

**Note for phase 8:** `@nestjs/throttler` 6.5.0 declares peers stopping at Nest 11. Re-verify its
support at that point rather than pinning the assumption now.

### 15.1 Test tiers — written 2026-10-26

Three tiers, separated by what infrastructure each one needs:

| tier | command | infrastructure | covers |
|---|---|---|---|
| unit | `npm test` | none | schemas, pure logic, services with DI swaps |
| integration | `npm run test:integration` | Postgres, Redis, the S3 dev bucket, app in-process | the request contract: validation, auth, tenant scoping — and the database-level guards a Prisma filter can silently get wrong |
| assertions | `npm run test:assertions` | Postgres, Redis, the S3 dev bucket; API and worker as **OS processes** | A1–A7, A12, and the later assertions as their phases land |

The third tier exists because A3, A3b and A5b `SIGKILL` and `SIGSTOP` a worker. The point of those
assertions is that the process dies *without running any cleanup*, which nothing in-process can
simulate. `test/harness/relay-harness.ts` owns the children; Postgres is reached through Prisma and
Redis through ioredis, so assertions read typed rows instead of parsing `docker exec psql` output.

**Tests wait for conditions, never for durations.** `waitUntil` replaced every `sleep`. A3 used to
sleep and then report `INCONCLUSIVE` when no job happened to be mid-charge; it now waits until all
six provably are, so the vacuous case is a precondition rather than an outcome to detect. Where
a run cannot be made to prove its claim, the case is **skipped as inconclusive**, never passed:
A12b's flush case proves the flush only when the job ran inside one progress window, which it
reads from the job's own `startedAt` and `finishedAt`.

**Integration specs share their setup.** `test/support/db.ts` builds the Nest module — always under
the worker's env schema — and writes throwaway users and job rows; `test/support/http.ts` starts the
app and registers an account over HTTP. Every spec deletes the users it made.

Four traps found while building it, each of which had made a test lie:

- **Processes must be reaped, not merely signalled.** `child.killed` records that *a* signal was
  sent, not that the process died, so testing it suppressed the `SIGKILL` following a `SIGCONT`.
  Survivors kept consuming jobs from the shared queue and the resulting failures looked like queue
  bugs. Cleanup awaits the real `exit`, each harness binds its own port, and a `globalSetup`
  **reports** strays rather than killing processes it did not start.
- **`NODE_ENV=test` silences the logger** (§9.1 logging). Vitest sets it, spawned children inherit
  it, so any assertion reading a worker's log saw nothing. The harness spawns with
  `NODE_ENV=development`.
- **Log output lags the database.** The pretty-print transport is a separate thread, so a count
  read the instant a row changes can be short. Log assertions must be waited for — and where the
  database already proves the claim, the log assertion was removed instead: `attempts = 3` *is*
  the evidence of three deliveries.
- **RSS measures garbage, not what a process holds.** A13 was first written against peak RSS, as
  §14 had it, and failed its band: two runs of the same streaming import read +82 and +45 MB,
  because V8 collects lazily and lets more garbage pile up over a longer run. What was still alive
  after each full collection was flat. A13 now forces a collection before every reading, through a
  probe the harness loads into the worker, so nothing in `src/` measures itself — and warms the
  worker up at full size first, since its live memory climbs over the first several thousand rows
  it ever processes before levelling off.

**Coverage carries no threshold, by design.** The reliability paths execute in child processes
where V8 coverage cannot observe them, so a percentage gate could only be satisfied by unit tests
that mock Prisma and BullMQ — and every bug these paths actually had (the stale `succeed()`
predicate, the silent `queue.remove()`, the stall black hole) needs two real processes and a real
database to reproduce. The gate for reliability is the named assertions of §14; coverage is
reported for information.

**The suite's teeth were verified, not assumed.** Re-scoping the ledger key to the attempt number —
`${job.id}:charge:${job.attempts}`, the plausible "fix" for a key thought to be colliding — makes
A3 fail with 12 ledger rows for 6 jobs. A4 still passes, correctly: it redelivers an already
terminal job, so `claim()` refuses and the handler never runs. The two gate different layers.

**Node version:** `engines` declares `>=24 <25` and CI runs 24, but local development is on 26.
Only logging reads `NODE_ENV` and nothing reads the Node version, so this is latent rather than
broken — but CI is the stricter of the two and the field should be widened or the local runtime
aligned.

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
| D28 | ~~A reused key with a different body~~ **DECIDED 2026-11-03** — `422 IDEMPOTENCY_KEY_REUSED`; a body hash as a check, not as the key | — | §6.3 |
| D4 | ~~Status in Postgres, Redis, or both~~ **DECIDED** — Postgres only | — | §4 |
| D5 | ~~Persist/enqueue ordering~~ **DECIDED** — commit-then-enqueue in ph5, outbox in ph6 | — | §7.7 |

### Deferred — each waits for its trigger

| # | Question | Trigger that forces the call | Phase |
|---|---|---|---|
| D7 | ~~Claim guard; crash reconciliation; authoritative attempt counter~~ | — | **DECIDED (phase 6)** — claim `QUEUED`/`RUNNING`; BullMQ redelivery reconciles; `Job.attempts` is authoritative. §7.6 |
| D6b | ~~What a dead letter physically is~~ | — | **DECIDED (phase 6)** — `DEAD_LETTERED` + `error` on the `Job` row. §4.6 |
| D8 | ~~Who emits the WS event; how it crosses the process boundary~~ | — | **DECIDED 2026-10-26** — the worker `PUBLISH`es a domain event to `relay:job-updated`; the API subscribes on a duplicated connection and fans out to `user:<userId>`. §9.3 |
| D6a | One queue, or one per job type | The load test shows one job type starving another | 10 |
| D3b | Add an explicit `RETRYING` state? | The status stream proves unreadable without distinguishing "never run" from "waiting after failure #2" | 7 |
| D10 | ~~Worker concurrency tuning; sandboxed processors~~ | Measured event-loop blocking in the worker | **DECIDED 2026-11-09** — concurrency 5, renders in-process; image work leaves the event loop alone, measured below. Re-measured on the target host in phase 10 |
| D11 | ~~A dead-letter re-drive API beyond `POST /jobs/:id/retry`~~ | The first real dead letter that needs bulk handling | **DECIDED** — filtered, bounded per call, published through the outbox |
| D12 | Status cache in Redis | A **measured** slow `GET /jobs/:id`. Never before | — |
| D13 | socket.io Redis adapter + sticky sessions | A second API instance | 11 |
| D14 | ~~Cursor pagination~~ | A list endpoint where offset pagination measurably hurts | **DECIDED 2026-11-09** — keyset cursors on `/jobs` and `/products`, measured below |
| D15 | ~~Job types beyond `MOCK` / `CHARGE`~~ | A real use case | **DECIDED 2026-10-26** — the real-job proposal is that use case: `import.csv`, `image.process`, then PD–PE (below) |
| D16 | Do replays bypass the rate limiter? | A client retrying with the same key gets `429` for a job already accepted | 8 |
| D32 | ~~Limits on the work an account can put on S3~~ | Registration is public and `POST /uploads` signs without limit | **DECIDED 2026-11-11** — planned now, built in phase 8 (M8.3). Below |

### Forced earlier than planned by the real-job proposal

Three decisions above were deferred to later phases. The proposal supplies their triggers sooner,
so they move:

| # | Was | Now | Why the trigger arrives early |
|---|---|---|---|
| D6a | phase 10 | **Phase D** | `ai.enrich` needs a BullMQ `limiter` and low concurrency of its own. A limiter is per-queue, so an LLM queue separate from `relay-jobs` is forced by the rate limit, not by a starvation measurement |
| D10 | phase 10 | **Phase C** | `sharp` runs on the libuv threadpool (4 threads by default), so image batches are the first work that could starve the worker of something other than its event loop — measured in Phase C, below |
| D11 | phase 8 | **Phase A** | §3.4 asks for bulk retry by filter in the same phase as the handler registry |
| D14 | — | **Phase B** | §5.3 asks for cursor pagination on `/jobs` and `/products`; a 20 000-product catalog is the list where offset paging starts to hurt |
| D15 | v2 | **now** | "job types beyond `MOCK`/`CHARGE`" was deferred until a real use case appeared. This proposal *is* that use case, and D21–D27 below are what it turns out to require |

### Decide now — before Phase B code · the real-job proposal · **all resolved 2026-10-26**

| # | Question | Why it cannot wait | Decision |
|---|---|---|---|
| D21 | ~~Is `Job.type` a Postgres enum or a string owned by the handler registry?~~ | Phase A's registry is the thing that decides it, and either answer is a migration | **DECIDED** — string + registry; closed set kept in one `JOB_TYPES` tuple |
| D22 | ~~What statuses does the proposal add, and where does `completed_with_errors` live?~~ | It changes the state machine M6 hardened | **DECIDED** — `CANCELLED` + `cancelRequested` on `Job`; `DEAD_LETTERED` keeps its name; `completed_with_errors` on `Pipeline` only |
| D23 | ~~Who owns a job no HTTP request created?~~ | `Job.userId` is `NOT NULL` and `(userId, idempotencyKey)` is what A1 rests on | **DECIDED** — `userId` stays `NOT NULL`; children get server-minted deterministic keys; webhooks are not `Job` rows |
| D24 | ~~Fan-out via BullMQ `FlowProducer`, or our own rows through the outbox?~~ | Phase B's import triggers the fan-out; the schema differs per answer | **DECIDED** — our own rows through the outbox; `pendingChildren` counter |
| D25 | ~~Where does progress live and how often is it written?~~ | Phase A writes it; `GET /jobs/:id` has to answer it after a reconnect | **DECIDED** — `progress Json?` on `Job`, ownership-guarded |
| D26 | ~~Does a re-drive resume from a checkpoint or restart from zero?~~ | `redrive()` currently clears `result` and resets `attempts` | **DECIDED** — resume from the checkpoint; `?from=start` to restart |
| D27 | ~~A second ledger for quota, or reuse `SideEffect`?~~ | Phase B's checkpoint and Phase I's quota would otherwise invent two | **DECIDED** — reuse `SideEffect`, `effectKey = '<jobId>:quota:<batchIndex>' |
| D29 | ~~Object storage: an emulator or real S3, and a presigned PUT or POST?~~ | B.1 needs a bucket, and MinIO's community images are gone | **DECIDED 2026-11-04** — real S3 in every environment, a bucket and a least-privilege IAM user each; presigned **POST** |
| D30 | ~~What does an import do to products already there, or missing from the file?~~ | B.2's upsert encodes the answer | **DECIDED 2026-11-04** — the newer file wins, nothing is deleted, currency is a required column |
| D31 | ~~Does an image that cannot be made fail the job?~~ | C.3's handler and A17 encode the answer | **DECIDED 2026-11-09** — no: the product is `FAILED` and the job succeeds; a transient failure fails the attempt only after the rest are done, and on the last attempt is recorded `FAILED` too |

**D21 — `Job.type` becomes a string, with the registry as the authority.**
An enum makes every new job type a migration, which defeats §3.1's whole point that adding a type
is adding a provider. `type` never decides authorization or correctness, and the registry lookup
fails closed: an unknown type is a `400` at submit and a refusal in the worker. The contract stays
closed at the edge by deriving the Zod union from a single `JOB_TYPES` tuple, so TypeScript still
sees a literal union and a typo in a handler is still a compile error.

**D22 — add `CANCELLED`; keep `DEAD_LETTERED`; `completed_with_errors` is not a job status.**
Cancellation is two-phase, so it is *two* fields: `cancelRequested Boolean` while the job is still
`RUNNING` and winding down, and `CANCELLED` as the terminal status it exits to. `CANCELLED` joins
`TERMINAL`, and `claim()` refuses it with no change to `claim()` itself — strictly because `claim()`
matches `status IN ('QUEUED','RUNNING')`, so any status outside that set is refused.
`DEAD_LETTERED` is not renamed to `failed`: "failed" is ambiguous between *this attempt failed* and
*we gave up*, and that ambiguity is exactly what the M6 machinery is written to distinguish. The
dashboard may label it anything it likes.
A job that imported 19 800 of 20 000 rows **succeeded** — the bad rows are data in `result`, not a
status. `completed_with_errors` is an aggregate over children and belongs on `Pipeline`; putting it
on `Job` would force every consumer of job status to handle a value the engine never produces.

What the implementation settled:

- **The API sets the flag with one statement covering `QUEUED` and `RUNNING`.** Checking "queued?"
  then "running?" as two statements loses requests: a retry moves the job from `RUNNING` back to
  `QUEUED` between them, and both checks miss. With one flag as the single source of truth, the API
  then finishes a `QUEUED` job itself, and every other path respects the flag.
- **A cancel never strands a job.** The worker checks the flag *before* claiming, so a retry
  scheduled after the request, or a redelivery after a crash, becomes `CANCELLED` without running
  the handler again.
- **The handler acknowledges by throwing `JobCancelledError`**, never by returning — an early
  return would be recorded as `SUCCEEDED` with half the work done. A handler with a single atomic
  effect (CHARGE) never checks and simply runs to completion, which is the honest answer to a
  cancellation it has no safe point to honour.
- **A cancel that came too late is a `409`, not a `202`.** The replay analogy (§6.3) holds only
  for a job already `CANCELLED`: there the earlier request really did succeed, and a client
  retrying it must not see an error. A job that *succeeded* or was *dead-lettered* finished in
  spite of the request, and a `202` would make the caller read the body to learn its cancel had
  no effect — for a charge, that the money moved.
- **The capability is `shouldStop()`, not `isCancelRequested()`.** It is also true when the
  attempt has lost the job, and while the worker shuts down (§7.6a), so a handler has one question
  to ask at a boundary rather than three.

**D23 — `userId` stays `NOT NULL`. Two different problems were being conflated.**
Fan-out children (`ai.enrich`, `image.process`, `pipeline.finalize`) *do* have an owner: the user
whose import created them. They keep `userId` and get a **server-minted deterministic** idempotency
key — `pipeline:<pipelineId>:enrich:<batchIndex>` — which means the `(userId, idempotencyKey)`
constraint that protects A1 now also makes the fan-out itself idempotent, for free. Re-running a
fan-out cannot duplicate a batch.
`stripe.event` is the genuinely ownerless case, and the answer is that it is **not a `Job`**. It has
its own table with its own dedupe (`StripeEvent.eventId`), and the queue job carries that row's id.
Making `userId` nullable to accommodate one caller would weaken the constraint for every other job.

**D24 — the fan-out is our own rows, enqueued through the outbox.**
`FlowProducer` writes parent and children in one Redis call and tracks the dependency itself. That
is a second source of truth for pipeline structure, which contradicts D4; those children bypass the
outbox, so the commit-then-enqueue guarantee A6 exists to prove would not cover them; and their
BullMQ ids would not follow the `${jobId}.${outboxId}` scheme §7.5a just established.
Doing it ourselves is less code than it sounds: `Pipeline.pendingChildren` is decremented in the
**same transaction** as each child's terminal transition, and when it reaches zero that transaction
also writes the parent's outbox row. Parent-runs-when-children-finish becomes a conditional UPDATE
on a counter — the idiom the whole project already uses — and the child-failure policy §3.5 asks
about becomes ours to state rather than a BullMQ flag to look up.

**D25 — `progress Json?` on `Job`, one write in flight and 500 ms between them, guarded by the ownership token.**
Not Redis-only: D4 makes Postgres authoritative, and `GET /jobs/:id` has to answer "how far along"
on reconnect, which is A7's shape. Not a separate table: progress is one current value, not a
history, and a row per update is write amplification nobody reads back.
A progress write is **not** a status transition and must not go through a status set, but it does
carry the same `lease = <claimed lease>` predicate, so a stale worker cannot overwrite the
live one's progress. Note for any future time-based reaper: progress writes bump `updatedAt`, so
its clock must be `startedAt`, never `updatedAt` — the §7.6 sweep asks the queue instead.

The ownership token alone does not make the count monotonic, which A12 also requires: a **retry** is
the live attempt and counts from one again, so without a second predicate it would walk a client's
bar backwards from wherever the failed attempt left it. The write therefore also requires
`progress -> 'processed'` to be at or below the incoming count (at, so a handler can revise its
`message` without advancing), and the status to be `RUNNING` so a write
cannot land on a finished job. The worker keeps an in-memory high-water mark too, seeded from the
claimed row, but only to avoid issuing writes the database would refuse — the predicate is the
guarantee.

A refused write is logged and otherwise ignored. It never fails a job: progress is presentational,
and a handler may report without awaiting, where a rejection would become an unhandled rejection
and take the worker down with it. Because a handler may not await, the processor **flushes** the
context's queued writes before it transitions the job — otherwise the last report of a
fire-and-forget handler lands on a row that is no longer `RUNNING` and the job finishes showing
its second-to-last batch.

Three details the implementation settled:

- **The predicate is `<=`, not `<`.** An equal count is not backwards, and a handler needs to
  revise `message` at a count it has already reached ("validating", "connecting") without
  inventing a fake advance.
- **The write replaces the column, so the worker carries `total` and `message` forward.**
  `JobProgress.total` invites reporting the total once, up front; with a replacing write the next
  batch that omits it would erase the denominator. The context remembers both, seeded from the
  claimed row, so a retry neither re-reports nor erases what an earlier attempt published.
- **A stored value this version cannot read has to be reclaimable.** For a row holding, say,
  `{"phase":"extract"}`, `progress -> 'processed' <= n` is NULL rather than false, so it matches
  no rows and the column would stay frozen for the job's whole life. There is no Prisma filter for
  "this jsonb path is SQL NULL", so the worker — which has already read the value — tells its
  writes to drop the monotonic clause until one lands; a write that failed left the value in
  place. The ownership clause is never dropped.

**D14 — lists page with an opaque cursor, never an offset.**
A page starts strictly after the last item the previous one held — `(createdAt, id)` for jobs,
newest first; `sku` for products — and the response carries that position as `nextCursor`. Three
things an offset gets wrong: a deep page reads and discards every row before it; a row inserted
mid-scroll shifts the rest, so the next page repeats one already shown; and `total` is a
`count(*)` over every matching row on every page. Measured on the last page of 20 000 rows,
locally: products **6.3 ms** by offset, a sequential scan and a sort of all 20 000, against
**0.019 ms** by cursor, an index range of 20; jobs **1.9 ms plus a 1.9 ms count** against
**0.029 ms**. Both grow with depth by offset and stay flat by cursor.

The cursor carries the **values**, not a reference to a row. Prisma's own cursor names a row and
skips it with `OFFSET 1`, so once that row leaves the filter — paging `?status=QUEUED` past a job
that has since started — it skips a real row instead. Carrying the values through JavaScript is
why `Job.createdAt` holds milliseconds (§4.3), and why `id` breaks ties, which a millisecond
clock makes common. A cursor's length limit is computed from the longest values its position
holds, with JSON's six-character escape of a control character as the worst case, so a list
never refuses a cursor it issued. It is base64url JSON and deliberately unsigned: every list is filtered to the
caller's rows on the server, so an edited cursor moves the caller only through their own data,
and one that does not decode is a `400`. A page reads `limit + 1` rows; the extra one proves a
next page without counting the rest. There is no `total`: a client that needs one asks for it
when it does, not on every page.

**D26 — a re-drive resumes from the checkpoint; restarting is opt-in.**
The checkpoint is neither `result` (which `redrive()` clears) nor `progress` (which is
presentational), so it gets its own column, `Job.checkpoint`, and `redrive()` does not clear it.
It is written in the transaction that commits the batch it describes, under the lease, so it can
neither run ahead of the work nor be written by an attempt that lost the job. Its shape belongs
to the handler, which parses it and starts over from the top if it cannot.
Resuming is safe because the row-level upsert on `(userId, sku)` makes a replayed batch harmless,
and restarting a 20 000-row import from zero is expensive. `POST /jobs/:id/retry?from=start` forces
a restart. This is the same semantic already settled for `effectKey`: a re-drive asks *did this
happen?*, not *do it again*.

**D27 — quota consumption reuses `SideEffect`.**
§10.5 independently arrived at "keyed by `jobId` + `batchIndex`", which is `effectKey`. One
mechanism: `effectKey = '<jobId>:quota:<batchIndex>'`, amount in `detail`, and the `UsageCounter`
aggregate updated in the same transaction as the ledger row. The only work is documenting the
`effectKey` naming convention, which is currently an undocumented `'<jobId>:charge'`.

**D11 — a bulk re-drive is a filter, a bounded transaction, and the outbox.**
`POST /jobs/retry` takes a filter — type, error code, and a window over **when the job was
dead-lettered** (`finishedAt`, half-open, timezone required) — and re-drives one batch of the
caller's matching dead letters per call. Each batch is one transaction that moves the rows to
`QUEUED` **and writes their outbox rows**; the relay publishes them. It does not enqueue
directly, as the single re-drive does: a request enqueueing thousands of jobs would take
seconds, and a crash halfway would leave the rest for the relay anyway. Using the relay from
the start makes the whole operation crash-safe from the moment it commits, and its steady pace
(100 per second, §7.5) turns thousands of re-driven jobs into a ramp instead of one burst
against a downstream that has only just recovered.
Bounded per call (`limit`, max 1000) so no transaction holds thousands of row locks until it
commits; the response's `remaining` tells the caller to call again. A repeated call continues
with the next batch rather than repeating the first, and can never re-drive the same dead letter
twice: the update re-checks `status = 'DEAD_LETTERED'` instead of trusting the ids it selected. A
re-driven job that dies *again* is a new dead letter with a new `finishedAt`, so with no
`deadLetteredTo` it matches again, and a loop run while the downstream is still failing may never
reach `remaining = 0`. Pass `deadLetteredTo` — the time the loop started — to work through a
fixed set.
At least one filter is required — an empty body is what a client bug sends — and `dryRun`
counts without writing. A filter matching nothing answers `202 { redriven: 0, remaining: 0 }`:
the caller asked for a set, and an empty set is a complete answer, unlike a cancel naming one
job that had already finished.

**D28 — a reused key with a different body is a `422`, decided by a fingerprint.**
D1 settled who mints the key, its scope and its lifetime, and never what a replay must match: a
client that reused a key for a different request was answered `202 replayed` with the first job —
told a charge of 5000 was accepted while the 1000 one is what exists. The submit now stores the
SHA-256 of the canonical body (defaults applied, keys sorted) and, on losing the insert, compares:
equal is a replay, different is `422 IDEMPOTENCY_KEY_REUSED` with nothing changed. `422` and not
`409`: nothing is in the request's way; it is unprocessable as what it claims to be, a retry — the
status the IETF `Idempotency-Key` draft assigns to this case. A hash *as a check* is not D1(b)'s
hash *as the key*, which would merge two genuinely identical charges; here the client's key still
decides identity. The comparison runs only after the unique index has picked the winner, so a race
between two bodies is decided by A1's mechanism and the check never reads before it writes. Rows
from before the column are `NULL` and can only be replayed: backfilling would mean reproducing
the application's canonical JSON in SQL byte for byte.

**D29 — object storage is AWS S3 everywhere, and uploads are presigned POSTs.**
The plan named MinIO in compose as the local stand-in; its community edition was archived in 2026
and its images are gone from Docker Hub, and LocalStack now requires an account token. So every
environment uses real S3: a **dev bucket** (laptops and CI) and, at deployment, a **prod bucket**,
each reachable only by its own IAM user whose policy names that bucket alone — a leaked dev key
cannot reach prod. The dev bucket expires uploads, reports and test fixtures by prefix, so tests
never clean those up by hand; product images never expire, so the tests that make them delete
them (§13.4). What this costs is tests that need the network and credentials, accepted because what the
upload tests prove is S3 enforcing a signed policy, which no stand-in proves; `S3_ENDPOINT` keeps
an emulator possible by configuration alone. **POST, not PUT:** a presigned PUT carries no size
limit, so a client could store 5 GB on a link meant for 5 MB and the API would learn only
afterwards, having already paid for it; a presigned POST's policy carries `content-length-range`,
which S3 enforces at the door. The cost is a `multipart/form-data` upload instead of a raw body,
which a browser's `FormData` makes no harder. Credentials come from the SDK's default chain, so a
host with an IAM role needs no key; they are resolved at boot so a missing one fails the deploy.

**D30 — an import adds and updates; it never deletes, and the newer file wins.**
A SKU already in the catalog takes the newer row's values: the store's file is the source of truth,
and a replayed batch writes identical values, so a replay is harmless either way. A SKU the newer
file leaves out is **left alone** — an import is an upsert, not a sync, because a sync turns a
truncated or wrong file into a deleted catalog; deleting products is a separate, explicit act. A
SKU twice in one batch is written once with its last values, the same answer it would get across
two batches. `currency` is a required column of the file rather than a per-account default: a
price without a currency is ambiguous, and a default is a guess the file never made.

**D31 — an image that cannot be made is the product's state; the job still succeeds.**
The plan's first reading had a 404 throw `TerminalJobError` and dead-letter the job. In a batch of
50 that costs 49 products their images for one seller's typo, and a re-drive fails the same way.
So a permanent failure is recorded on the product — `imageStatus = 'FAILED'` and `imageError` —
and the job succeeds with `failed` counted in its result: the split D22 makes for an import, where
bad rows are data in `result`, not a status. A transient failure is passed over rather than
thrown, and the attempt fails only once every product was tried: thrown at once, a host that never
answers would stop the batch at the same product on every attempt and dead-letter the rest
untouched. On the job's last attempt it is recorded `FAILED` like a permanent one: no retry is
coming, and a product left `PENDING` would wait for ever.

**D32 — caps on the work an account can put on S3: planned now, built in phase 8.**
Registration is public, and an upload slip is signed locally, so nothing bounds how many 50 MB
slips one account holds. One upload can also be submitted under any number of `Idempotency-Key`s,
and every such job downloads the whole file — again for its error report, and on every retry. Rate
limits on auth and submit alone bound requests, not bytes. Phase 8 adds a rate limit on
`POST /uploads`; per-account caps on outstanding slips and on unfinished `import.csv` and
`image.process` jobs; an AWS Budgets alarm; and weighs a 1-day `uploads/` lifecycle, which would
also shorten how long a dead import can be re-driven (§6.2). Nothing is deployed, so until phase
11 the risk is latent.

**D10 — image work does not stall the worker: concurrency stays 5, renders stay in-process.**
First written as: `sharp` fills the 4-thread libuv pool, which delays all async I/O, BullMQ's lock
renewal included. Measured, half of that holds. The pool does fill: five loops rendering the
heaviest image the limits allow — a 35 MP PNG under a megabyte — make a lookup of `localhost` wait
127–144 ms instead of about 1. But a renewal is one Redis command on an open socket, and sockets
are polled by the event loop, never served by the pool: the Redis round trip stayed at 3–5 ms and
the event loop's worst delay at 12–18 ms, against the 15 s a renewal may be late before the lock
lapses. What a full pool does delay is the guard's lookup before each download, by a fraction of
a second out of its 15 s. End to end (A18) — five batches of 20 such images through the real
worker and real S3 — no run had a stall, the event loop's worst delay was 33 ms and Redis's
14 ms. The pool's worst wait there ranged from 31 ms to 2.2 s across runs: over a slow
connection a lookup waiting on the network holds a pool thread too, and the few downloads that
reached their 15 s timeout were retried — the C.3 path, not a stall. What does
stall the worker is its main thread blocked — a synchronous decoder, a CPU loop in JavaScript —
and A18 fails on exactly that: one 40 s freeze gave 5 stalled jobs. So `WORKER_CONCURRENCY` stays
5, no sandboxed processor, `UV_THREADPOOL_SIZE` at its default. Measured on a 12-core machine; a
1–2 vCPU host shares its cores between libvips and the event loop, which this does not
reproduce, so phase 10's load test repeats it on the target host.

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
| 10 | Load | §14, §15 | **A9 passes**; D6a closed with measurements; D10 re-measured on the target host |
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
| 2026-10-19 | `CHECK (attempts <= maxAttempts)` dropped as unsatisfiable (§4.3). Corrected 2026-10-24: the cause is that our counter counts deliveries and BullMQ's counts failures, not that stalls enlarge BullMQ's budget. |
| 2026-10-19 | No custom backoff strategy needed: `backoff.jitter` is built into BullMQ's `exponential` strategy (§7.4). Verified in `backoffs.js` — `jitter: 1` gives a delay uniform in `[0, 2^(n-1) · delay)`. |
| 2026-10-24 | §7.6 — a job past `maxStalledCount` is failed **without `process()` running**. The worker now finalises such jobs from the `failed` event gated on `finishedOn`; `deadLetter()` accepts `QUEUED` as well as `RUNNING` so an abandoned row can still reach a terminal state. |
| 2026-10-24 | §7.2 — `redrive()` now writes its own `Outbox` row inside the transition transaction. The commit-then-enqueue gap A6 exists to prove was closed for `submit()` only. |
| 2026-10-26 | §7.5a — the queue entry is now keyed by the outbox row, not the job. A job-scoped id let a re-drive silently deduplicate against a still-locked earlier delivery, enqueue nothing, and be marked published. |
| 2026-10-26 | §15.1 — the phase 9 test design: three tiers, condition-based waiting, no coverage threshold and why, plus the three harness defects that had made assertions pass without proving anything. |
| 2026-10-26 | §14 — A11–A26 registered for phases PA–PF, each with its deciding query. `IMPLEMENTATION_PLAN.md` gains the PA–PI product track. |
| 2026-10-26 | §9.1, §9.2a, D8 — **decided**: Redis pub/sub bridges worker → API; delivery is at-most-once and events bypass the outbox because a lost event is recoverable by re-reading the job. Socket auth moved to handshake middleware. A7 extended to assert the loss *and* the recovery. |
| 2026-10-26 | §16 — D21–D27 **decided** for the real-job proposal. D15 ("job types beyond `MOCK`/`CHARGE`") is the decision it fires; D6a, D10, D11 and D14 move earlier because the proposal supplies their triggers sooner. |
| 2026-10-26 | §1 scope, §9 — no frontend of any kind is in scope, including the static demo page. A7 is verified by a scripted socket client so it can run in CI; the dashboard is a separate deliverable. |
| 2026-10-26 | §7.3 — the attempt number is the worker's **ownership token**. `succeed`, `requeueForRetry` and `deadLetter` all require `attempts = <the attempt that claimed>`, so a worker that lost a job while still running it cannot write over whoever holds it now. `succeed` also accepts `QUEUED`, because a refused `succeed` is unrecoverable: the work is done and no later delivery exists. |
| 2026-10-27 | §4.3, §6.4, §10.1 — brought in line with the code: `Job.type` is `text` (D21, its migration drops the enum); validation is strict at the edge and lenient in the worker's re-parse, because an additive payload change must not dead-letter queued jobs; the module tree names the modules that exist, with `JobCoreModule` as the shared domain both roots import. |
| 2026-10-27 | §4.3, D25 — `Job.progress` added, written under two predicates rather than one: the attempt token stops a stale worker, and a `processed <` comparison on the jsonb path stops a retry from counting from one over a higher stored value. A progress write never fails a job. |
| 2026-10-28 | §2, §6.3 — the `MOCK` row described a handler that no longer exists, and `steps` was an undocumented field on the submit body; payload ranges and defaults are now listed per type. §13.4 gains the two commands a schema change requires, since `src/generated/` is gitignored. §14's A12 row said "across the job's life" while a re-drive clears progress. D25 records three things the implementation settled: `<=` not `<`, the worker carrying `total`/`message` forward over a replacing write, and how a stored value this version cannot read is reclaimed. |
| 2026-10-28 | §9.2 — `job.updated` carries `progress`, and progress emits are throttled to one per job per 500 ms with the last one always sent. The window governs the database write too: one clock, one staleness window, and it also bounds the write amplification a client could ask for with `steps: 100`. A12b registered for both halves. |
| 2026-10-28 | §5, §6.2, §9.2, D22 — `CANCELLED` and `cancelRequested` added, with `POST /jobs/:id/cancel`. The API may finish only a `QUEUED` job; a `RUNNING` one is finished by the worker when its handler stops at a boundary. The worker checks the flag before claiming, so a cancel never strands a job and a retry never re-runs a cancelled handler. A cancel of a job that already succeeded or was dead-lettered is `409 JOB_ALREADY_FINISHED`; only an already-cancelled job answers `202`. §4.3's `progress` row corrected to `<=`. |
| 2026-10-28 | §6.2, §14, D11 — **decided**: `POST /jobs/retry` re-drives dead letters by type, error code and dead-letter window, one bounded batch per call, writing outbox rows in the same transaction so the relay publishes them. A5c registered. The dead-letter error codes are one list the worker's writes are checked against at compile time. |
| 2026-11-11 | §14, §15.1 — A13 automated. Its criterion moved from peak RSS to live memory: RSS counted garbage V8 had not yet collected and swung between +45 and +82 MB on identical runs, failing the band named for it. Live memory after a forced collection, with a full-size warm-up, reads +2–3 MB for 18 000 more rows against a band of 18 MB, and +62 MB for a worker that buffers the file. |
| 2026-11-11 | Header, §2, §3, §4.3, §6, §6.2, §7.5, §8.2, §10.1, §11, §13.2, §13.4, §15, §15.1, §16, D6b, D15, D32 — an alignment pass. `Job.error` is `{ code, reason?, message, attempt? }` with `ATTEMPT_FAILED` while a retry is coming; nothing ever wrote `retryable`. `startedAt` is the latest claim. Routes have no `/api/v1` prefix. The queue options and backoff are the ones `jobOptions()` builds. §3, §10.1 and §13.2 gain S3, the upload and product modules, the sweeper and PB–PC's packages; §2 lists the real job types and D15 is closed by them. The Argon2id settings are documented as OWASP's minimum, not test-speed values. A bulk re-drive always resumes, and an import whose upload expired dies again. The bucket needs a CORS rule once a browser uploads (M11.8). **D32 decided:** caps on the work an account can put on S3 are planned now and built in phase 8 (M8.3). |
| 2026-11-11 | §13.4, §14, §15.1 — CI hands the AWS keys only to the two test steps that reach S3, not to every step: `npm ci` runs every dependency's install script. §13.4 had said CI reads the region from secrets; `ci.yml` sets it. A12b's flush case reports itself inconclusive when the job ran longer than one progress window, where it had passed without proving the flush. Integration specs share their setup (`test/support/db.ts`, `test/support/http.ts`); copies had drifted, and only some validated their env or deleted their users. |
| 2026-11-11 | D25 — the worker keeps reclaiming a progress value it cannot read until a write lands. It stopped once the first write was sent, so a database error on that one write froze the column for the rest of the attempt. |
| 2026-11-11 | §6.3c, §13.4, D29, D31 — on an `image.process` job's last attempt, an image that might pass later is recorded `FAILED` (`Gave up after N attempts: <reason>`) and the job succeeds: it had been left `PENDING` with nothing to ever finish it once the job dead-lettered. The processor decides "last attempt" once and hands it to the handler as `context.lastAttempt`. The tests that make product images now delete them: `products/` never expires, and D29 had said the dev bucket expires everything. A replaced URL's old files are still kept; deleting them when the new image is recorded can delete a live image, so an age-guarded sweep is planned (M8.8). |
| 2026-11-10 | §4.7, §7.7, §7.9 — a job's `error.message` holds only words written for its owner: an `AppError`'s message as it is, anything else as an internal error with the correlation id, its text in the worker's log. Prisma's and S3's messages had reached clients, and S3's AccessDenied names the IAM principal. `RetryableJobError` keeps a retry's own message where it was written for the owner — an image batch's "N of M images could not be downloaded". A host name that does not exist gets the same answer as one that resolves privately, so `image.error` no longer tells which internal names exist. The product upsert writes in `sku` order: two imports into one store had deadlocked on each other. |
| 2026-11-10 | §7.6 — the sweep also finishes a `QUEUED` job the queue has stopped delivering. A job whose every delivery failed before the claim, with Postgres unreachable, was left `QUEUED` for ever: `abandon()` refuses a row no attempt claimed, and the sweep read `RUNNING` rows only. Such a row is now dead-lettered `DELIVERY_ABANDONED` once its outbox row is published and its entry is gone or long finished, under a write pinned to the delivery the sweep read, so a job re-driven in between is never finished. The sweep pages by `id > last`: Prisma's cursor skipped the row after any page whose last row the sweep had just finished. §7.6 said the write was pinned to `startedAt`; it is the lease. |
| 2026-11-10 | §4.3, §5.2, §6.2, §14 — a charge whose money moved can no longer end `CANCELLED`. The two cancels that run no handler checked only `cancelRequested`, so a cancel after the charge, followed by a redelivery or a retry, finished the job `CANCELLED` beside its ledger row. The charge now commits through `context.commitEffect`, under the lease, marking `Job.effectCommitted` in the same transaction; both cancels refuse a marked job, and a `CHECK` refuses the combination. `succeed` and `deadLetter` accept only `RUNNING`: a stale worker could finish a job re-driven since. §5.2's table rewritten from the code, with every worker write under the lease. A3d automated. |
| 2026-11-10 | §5.2, §7.6a, §14 — `SIGTERM` no longer breaks running jobs. The worker drained in `@nestjs/bullmq`'s `onApplicationShutdown`, after every `onModuleDestroy` had closed S3 and Redis, so every deploy cost a running import or image batch an attempt. It now drains first, tells handlers to stop at their next safe point, and hands the job back to the queue with its attempt given back. A5e automated. |
| 2026-11-10 | §6.3b — an import row is capped at 1 000 fields as well as 64 KB of content. The content cap alone counted no empty field, so a line of bare commas grew one record without bound and could take the worker's memory with it. A cap per physical line was rejected: quoted line breaks split one row into short lines, and a file ending lines in `\r` alone has no `\n`. |
| 2026-11-10 | §6.3b, §6.4, D14 — text bound for Postgres refuses U+0000 at the edge: a NUL in an import cell is one bad row with its reason instead of a batch failing on every attempt, and a NUL in a payload is a `400` instead of a `500` at the insert. A cursor's length limit is derived from its position's longest values, so a sku of control characters no longer yields a `nextCursor` the list refuses. One `SKU_MAX_LENGTH`; a header column named after an `Object` property is skipped rather than failing the file. |
| 2026-11-09 | §7.6, §14, §16 — D10 **decided** from measurements: a full libuv threadpool delays DNS lookups by about 130 ms, not BullMQ's lock renewal, which stayed at 3–5 ms, because a renewal is a socket command the pool never serves. The reasoning that moved D10 into Phase C said otherwise and is corrected. Concurrency stays 5 with renders in-process. A18 automated with a probe loaded into the real worker, and shown to fail on a 40 s freeze. |
| 2026-11-09 | §6.3c, §7.9, §14, D31 — an image that can never be made marks its product `FAILED` with the reason and the batch goes on; one that might pass later is passed over and retried after the rest. A17 restated to match — `attempts = 1` at `SUCCEEDED`, not at `DEAD_LETTERED` — and automated against the real guard and real S3. The guard's refusal no longer names the address a host resolved to, since the message now reaches the seller. |
| 2026-11-09 | §4.7, §6.2, §6.3, §6.3c, §13.4 — `image.process`: a batch of up to 50 skus made into three WebP sizes under the source URL's hash, recorded `READY` only while that URL is still the product's. `Product` gains `imageStatus`, `imageSourceUrl` and `imageError`; `GET /products` shows each product's `image` with links signed per read. The bucket's lifecycle rules are scoped by prefix so product images do not expire. |
| 2026-11-09 | §7.9 — requests to a user's URL go through a guard: public unicast addresses only, checked inside the connection's own lookup and again on every redirect, ports 80 and 443, a whole-download timeout and a counted byte cap. A16 automated, in the integration tier: the guard needs no process to attack. |
| 2026-11-09 | §4.3, §6.2, D14 — **decided**: `/jobs` and the new `/products` page with an opaque keyset cursor; `offset` and `total` removed from `/jobs`. `Job.createdAt` narrowed to milliseconds so a cursor survives a JS `Date`, and the job list's indexes gain `id`. Measured: 6.3 ms by offset against 0.019 ms by cursor on the last page of 20 000 products. |
| 2026-11-06 | §4.3, §6.2, §6.3b — the error report: every bad row to `reports/<userId>/<jobId>.csv` from a second read of the file, and `GET /jobs/:id/error-report` signing a link on each call. A file whose first 100 rows are mostly bad fails before anything is written, as `error.reason: 'IMPORT_MOSTLY_INVALID'` — `reason` added beside the engine's `code`. |
| 2026-11-05 | §4.3, §6.2, §6.3b, D26 — `Job.checkpoint` added, written in the batch's own transaction under the lease; a handler commits through `JobContext.commit()` and reads `JobContext.checkpoint`. `import.csv` resumes after its last committed batch, refusing a file whose `ETag` changed. `POST /jobs/:id/retry?from=start` restarts instead. A14 automated. |
| 2026-11-05 | §6.2, §6.3, §6.3b — the `import.csv` job: a streamed file, 500 rows per statement, bad rows counted by line and never fatal, a bad file terminal, the batch the cancellation boundary. `422 UPLOAD_NOT_FOUND` at submit; the worker re-checks the key's owner. Handlers now see the job's `userId`. A15 automated. |
| 2026-11-04 | §4.7, D30 — `Product` added: `UNIQUE (userId, sku)`, money in whole cents with an ISO 4217 currency, CHECKs as the floor under row validation; one `INSERT … ON CONFLICT` per batch. **Decided**: the newer file wins, an import never deletes. |
| 2026-11-04 | §6.2 — `GET /auth/me` removed: it was listed from the start and never built. Login already returns the user, and nothing has needed the route since. |
| 2026-11-04 | §6.2, §6.3a, §11, §13.2, §13.4, D29 — **decided**: object storage is real AWS S3 in every environment, a bucket and a bucket-only IAM user each, and uploads are presigned POSTs so S3 enforces the size. `POST /uploads` added. MinIO, which the plan named, is archived. |
| 2026-11-04 | §4.3, §5.2, D7, D25, §14 — the ownership token is `lease`, a counter every claim increments and nothing resets; `attempts` is only the retry budget. The token was `attempts`, which a re-drive resets, so it repeated across a job's lives. A3c registered. |
| 2026-11-04 | §4.5 — the relay publishes row by row and skips one it cannot publish, retrying it every tick. It stopped at the first failure, and since every tick starts from the oldest unpublished row, a row that always failed would have blocked the outbox for good. Failures are logged once per tick, not once per row. |
| 2026-11-04 | §9.2, D25 — the progress throttle keeps one write in flight and opens its window when that write settles. It opened the window on *send*, so a database slower than 500 ms had a write queued behind it every window, replayed in a burst on recovery, with `flush()` waiting for all of it. |
| 2026-11-04 | §7.6, D7, §11, §14 — a sweep in every worker finishes a `RUNNING` job whose queue entry is gone or long finished: the backstop for the `failed` event, the one at-most-once step. A5d registered; `RELAY_SWEEP_INTERVAL_MS` and `RELAY_FAULT_SKIP_ABANDON` added, and `RELAY_FAULT_AFTER_COMMIT` listed. |
| 2026-11-03 | §4.3, §6.2, §6.3, D28 — **decided**: a reused `Idempotency-Key` with a different body is `422 IDEMPOTENCY_KEY_REUSED`, checked against a stored SHA-256 of the canonical body; `requestHash` added to `Job` and kept out of responses. §16's D14–D16 rows moved back into the deferred table they had drifted out of. |
| 2026-11-03 | D6b, D7, D8 marked decided, as the code already had them. Corrected to match the code: §7.4 (the BullMQ id is per outbox row), §9.3 (events can arrive out of order; keep the newer `updatedAt`), D11 and §6.2 (a looping bulk re-drive needs `deadLetteredTo`), D25 (`<=`, not `<`; one write per window), A12b (the fast case takes about 200 ms, not one), §4.5 (`Outbox.attempts` counts the relay's publishes only). |
| 2026-09-01 | v0.1 — initial specification. D1, D4, D5 resolved; D6a, D6b, D7, D8 deferred with triggers (§16). |
