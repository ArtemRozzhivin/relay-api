# Relay — Implementation Plan

Companion to [TECH_SPEC.md](./TECH_SPEC.md). The spec defines _what_ the system does and _why_;
this defines the order of work.

Eleven milestones, M1–M11, matching the spec's phases 1–11. All are in scope for v1. Each ends
in a runnable, demonstrable state.

---

## Progress

- [x] **M1** · Service skeleton
- [x] **M2** · Authentication
- [x] **M3** · Cross-cutting concerns
- [x] **M4** · Jobs API
- [x] **M5** · Queue and worker
- [x] **M6** · Reliability
- [x] **M7** · Realtime
- [ ] **M8** · Observability and hardening
- [ ] **M9** · Test harness and CI
- [ ] **M10** · Load testing
- [ ] **M11** · Deployment

### Product phases — the real-job proposal (2026-10-24)

- [x] **PA** · Handler registry, progress, cancellation
- [ ] **PB** · Object storage, `Product` domain, `import.csv`
- [ ] **PC** · `image.process`
- [ ] **PD** · `ai.enrich`
- [ ] **PE** · Pipeline fan-out
- [ ] **PF** · API keys and public docs
- [ ] **PH** · Presentation — README, diagram, demo
- [ ] **PI** · Billing

- **PG** · Dashboard — owner's track, not planned here

M1–M11 are the engine; PA–PI are the product built on it. They are lettered, not numbered,
because **they do not run in numeric order**:

```
M7 ✓ → M9 → PA → PB → PC → M8 → PD → PE → PF → M10 → M11 → PH → PI
```

M9 comes before PA because PA–PE add roughly twenty acceptance criteria and the suite already
takes ~15 minutes of booting processes by hand. M8 lands before PD because rate limiting and cost
tracking are the first things you cannot tune without metrics.

A milestone is complete when every task **and** every _Done when_ item under it is checked.

---

## Testing policy

**Tests are written with the code they cover, in every milestone.** They are not deferred to M9
and are not itemised per task below — the expectation is standing:

| Scope                                                         | Written when                              | Runner                                        |
| ------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------- |
| Unit — services, guards, pipes, filters, pure helpers         | Alongside the unit                        | Vitest, providers swapped in the DI container |
| Integration — repositories, transactions, guarded transitions | Alongside the query                       | Vitest against a real Postgres                |
| e2e — HTTP contract, auth flows, the job lifecycle            | When the endpoint lands                   | `@nestjs/testing` + Supertest                 |
| Reliability assertions **A1–A10** (spec §14)                  | In the milestone that makes each provable | See the phase column in §14                   |

A milestone is not done until its tests pass. **M9 does not introduce testing** — it builds the
shared harness, the fixtures, and CI, and consolidates the reliability assertions into an
automated suite that until then were run by hand.

---

# M1 · Service skeleton

**Goal:** a Nest application that starts, refuses to start on invalid configuration, and can
reach Postgres and Redis.
**Spec:** §3, §11, §13

### Tasks

- [x] **1.1 · Repository setup** — `.nvmrc` (Node 24), `.gitignore`, `.env.example`, `git init`.
  ```
  _Local Node matches the Docker image, so native modules behave identically in both._
  ```
- [x] **1.2 ·** `docker-compose.yml` — postgres 17 + redis 7, healthchecks, named volumes.
  ```
  `pg_isready`_, not a port check: the port opens before the server accepts queries._
  ```
- [x] **1.3 · Scaffold Nest 12** — ESM (`"type": "module"`), tsconfig, npm scripts.
  ```
  _The CLI now emits ESM by default (_`nodenext`_,_ `.js` _import extensions) — no conversion needed.
  Vitest and oxlint are the generated defaults;_ `@nestjs/mau` _removed, as M11 deploys by hand._
  ```
- [x] **1.4 ·** `ConfigModule` **+ Zod env schema**, validated at boot.
  ```
  _Invalid configuration fails startup, not a request in production. Nest 12 accepts Zod
  directly as a Standard Schema validator — no Joi, one definition of the contract._
  ```
- [x] **1.5 · Prisma** — `prisma-client` generator with `output`, `PrismaService`, driver adapter.
  ```
  _Single injectable client;_ `prisma-client-js` _is deprecated._
  ```
- [x] **1.6 ·** `RedisModule` exporting an ioredis client.
  ```
  _One connection, injected where needed._
  ```
- [x] **1.7 ·** `/health` **+** `/ready` — Terminus + a custom Redis indicator.
  ```
  _Terminus ships no first-party Redis indicator._
  ```

### Done when

- [x] `docker compose up -d` brings postgres and redis to `healthy`
- [x] `npm run start:dev` boots the API
- [x] Removing a required env var crashes at startup with a readable message
- [x] `GET /ready` returns 200, and 503 when the Postgres container is stopped

---

# M2 · Authentication

**Goal:** register, login, refresh, logout, expressed as Nest guards.
**Spec:** §4.1–4.2, §6.2

### Tasks

- [x] **2.1 ·** `User` **+** `RefreshToken` **models**, first migration.
  ```
  `ON DELETE CASCADE` _is a schema-level policy decision._
  ```
- [x] **2.2 · Register + login**, argon2id hashing.
  ```
  _Memory-hard hashing defeats GPU parallelism._
  ```
- [x] **2.3 ·** `JwtAuthGuard` via `APP_GUARD`, `@Public()` to opt out.
  ```
  _Token-form registration goes through DI;_ `new Guard()` _cannot inject._
  ```
- [x] **2.4 · Refresh-token rotation + logout.**
  ```
  _Access tokens cannot be revoked; refresh tokens can, because they are stored._
  ```
- [x] **2.5 ·** `RolesGuard` **+** `@Roles()`**.**
  ```
  _Coarse-grained RBAC at the guard layer._
  ```

**Design note:** guards run before pipes in the request lifecycle, so a guard cannot read a
validated body. Ownership checks requiring a DB read belong in the service layer.

### Done when

- [x] The full register → login → refresh → logout flow works over curl
- [x] A protected route returns 401 without a token
- [x] A replayed refresh token is rejected

---

# M3 · Cross-cutting concerns

**Goal:** uniform response shape, uniform error mapping, traceable logs.
**Spec:** §6.1, §6.4, §10.2, §12.1

### Tasks

- [x] **3.1 · Global** `StandardSchemaValidationPipe` + Zod schemas, `.strict()` throughout.
  ```
  `.strict()` _is mass-assignment protection at the edge._
  ```
- [x] **3.2 · Domain error classes +** `DomainExceptionFilter` → the envelope.
  ```
  _Operational errors surface their message; unexpected ones never leak internals._
  ```
- [x] **3.3 ·** `ResponseEnvelopeInterceptor`**.**
  ```
  _Interceptors wrap both sides of the handler._
  ```
- [x] **3.4 ·** `nestjs-pino`, request id, `X-Request-Id` header.
  ```
  _Structured JSON is queryable by field; a correlation id makes one request traceable._
  ```

### Done when

- [x] Every success and every error share one envelope shape
- [x] Every log line carries the same `requestId` as its response header

---

# M4 · Jobs API

**Goal:** submit, read, and list jobs. The handler completes work inline; no queue yet.
**Spec:** §4.3, §5, §6.3

### Tasks

- [x] **4.1 ·** `Job` **model**, enums, indexes; raw-SQL migration for the `CHECK` constraints.
  ```
  _Prisma's schema language cannot express CHECK — use the_ `--create-only` _flow._
  ```
- [x] **4.2 ·** `UNIQUE (userId, idempotencyKey)`**.**
  ```
  _The index is the guarantee; application code is only the coordinator._
  ```
- [x] **4.3 ·** `POST /jobs` — insert, catch `P2002`, return the existing job with `replayed: true`.
  ```
  _SELECT-then-INSERT races; the insert is the check._
  ```
- [x] **4.4 · The guarded-transition helper** (`updateMany` + row count).
  ```
  _The affected row count is the source of truth, never a previously read value._
  ```
- [x] **4.5 ·** `GET /jobs/:id`**,** `GET /jobs`, 404-before-403 on ownership.
  ```
  _The API does not reveal a resource exists to a caller with no right to it._
  ```

**Design note:** `202`, not `201` — the work is accepted, not done. A replay returns `202` with
the same job id rather than `409`, so retry logic stays out of the client.

### Done when

- [x] Submitting twice with the same `Idempotency-Key` returns the same job id
- [x] Another user's job id returns 404

---

# M5 · Queue and worker

**Goal:** work leaves the request lifecycle. Two processes, one queue.
**Spec:** §3, §8, §10.1 · _Largest structural change in the project._

### Tasks

- [x] **5.1 ·** `BullModule.forRoot` **+** `registerQueue` in `JobsModule` — producer only.
  ```
  _Producer and consumer registration are the same call; the distinction is deliberate._
  ```
- [x] **5.2 ·** `worker.ts` — second bootstrap via `createApplicationContext()`.
  ```
  _A Nest context with no HTTP server; two disjoint root modules._
  ```
- [x] **5.3 ·** `JobsProcessor extends WorkerHost`**.**
  ```
  _The_ `@nestjs/bullmq` _v12 shape; the legacy_ `@Process()` _API does not apply._
  ```
- [x] **5.4 · Handler registry** — `MOCK` (awaited sleep) and `CHARGE`.
  ```
  _A CPU-blocking processor fails to renew its lock and stalls itself._
  ```
- [x] **5.5 · Worker-side transitions** `QUEUED → RUNNING → SUCCEEDED`.
  ```
  _Only the worker moves a job past_ `QUEUED`_._
  ```
- [ ] **5.6 · Compose** — two services, same image, different commands, `restart: unless-stopped`.
  ```
  _The worker's crash policy is a deployment decision, not an application one._
  ```

**Verification:** submit a job and watch a separate worker process consume it. Stop the API
entirely — the worker continues draining the queue, confirming the process boundary.

### Done when

- [x] **A2 passes** — N jobs submitted, N terminal, none stuck
- [x] The worker keeps draining with the API stopped
- [x] `AppModule` provably does not import `ProcessingModule`

---

# M6 · Reliability

**Goal:** the §1 invariant holds under induced failure.
**Spec:** §7, §4.4, §4.5 · _Carries the system's core risk._

Each step is motivated by the failure of the one before it.

### Tasks

- [x] **6.1 · Write A3 and confirm it fails** — submit jobs, `SIGKILL` the worker mid-charge, count ledger rows.
  ```
  _Establishes the baseline defect the effect guard must eliminate._
  ```
- [x] **6.2 ·** `SideEffect` **table** + `effectKey = ${jobId}:${kind}`.
  ```
  _Deterministic derivation — never a clock, a random source, or an attempt number._
  ```
- [x] **6.3 ·** `CHARGE` **writes the ledger row** in the same transaction as the status.
  ```
  _The effect guard. A3 now passes._
  ```
- [x] **6.4 · Retries** — attempts, exponential backoff with full jitter.
  ```
  _Without jitter a batch that fails together retries in lockstep at every doubling._
  ```
- [x] **6.5 · Error taxonomy** — plain `Error` vs `UnrecoverableError`.
  ```
  _A terminal error should not consume the full retry budget._
  ```
- [x] **6.6 ·** `DEAD_LETTERED` **+** `POST /jobs/:id/retry` → resolve **D6b**.
  ```
  _Anything that must survive a Redis flush is a Postgres row._
  ```
- [x] **6.7 · Induce a stalled worker**, observe the stuck `RUNNING` row → resolve **D7**.
  ```
  _The claim guard is decided against observed behaviour, not assumption._
  ```
- [x] **6.8 · Write A6** to demonstrate the commit-then-enqueue gap.
  ```
  _A test written to fail documents an accepted risk precisely._
  ```
- [x] **6.9 ·** `Outbox` **+** `@nestjs/schedule` **relay tick** → A6 passes.
  ```
  _The transactional outbox closes the dual-write hole._
  ```

### Done when

- [x] **A1, A3, A4, A5, A6 all pass**
- [x] Killing the worker at any point during a run leaves ledger rows equal to job count

---

# M7 · Realtime

**Goal:** clients observe job status live.
**Spec:** §9

### Tasks

- [x] **7.1 ·** `EventsGateway` — auth on connect, room `user:<userId>` from the verified token.
  ```
  _A socket cannot carry an auth header per frame; the room is assigned server-side._
  ```
- [x] **7.2 · Resolve D8** — Redis pub/sub bridge from worker to API.
  ```
  _Transitions occur in the worker; sockets live in the API._
  ```
- [x] **7.3 ·** `job.updated` **emitted after commit**, never inside the transaction.
  ```
  _Emitting pre-commit can broadcast a state the DB rolls back._
  ```
- [x] **7.4 · A socket client script** that asserts A7: connect, submit, drop the socket
  ```
  mid-processing, reconnect, reconcile against `GET /jobs/:id`.
  ```
  ```
  _No UI. A7 needs a client that can be scripted and run in CI, not one that needs a human
  with a browser; the dashboard is built separately and is not this assertion's vehicle._
  ```

### Done when

- [x] **A7 passes** — a client disconnected mid-processing reconciles to the correct terminal
  ```
  state via `GET /jobs/:id` on reconnect
  ```

---

# M8 · Observability and hardening

**Goal:** the system is measurable and safe to expose.
**Spec:** §12, §15

### Tasks

- [ ] **8.0 · A config-driven socket.io adapter** — the gateway's CORS is `{ origin: true }`,

  ```
  which reflects any origin. Tighten it to `CORS_ORIGINS` once a browser client exists.
  ```

  ```
  _Harmless while the only client is a scripted one; wrong the moment a dashboard is served from
  another origin._
  ```

- [ ] **8.1 · Prometheus** `/metrics` — queue depth, job duration histogram, failure rate, dead-letter count.
  ```
  _Logs say what happened; metrics say how much and how often._
  ```
- [ ] **8.2 · Metrics from both processes**, labelled by role.
  ```
  _Worker throughput is invisible from the API's registry._
  ```
- [ ] **8.3 · Rate limiting** on the abuse-prone surface (auth, submit) → resolve **D16**.
  ```
  _Re-verify_ `@nestjs/throttler`_'s Nest 12 support at this point rather than assuming it._
  ```
- [ ] **8.4 ·** `trust proxy` configured before rate limiting is believed.
  ```
  _Behind a proxy every client shares one IP unless the forwarded header is trusted._
  ```
- [ ] **8.5 · helmet, CORS allowlist, body-size limits.**
  ```
  _Cheap defence in depth;_ `*` _CORS is a dev convenience only._
  ```
- [ ] **8.6 · Dead-letter inspection and bulk re-drive** → resolve **D11**.
  ```
  _A dead letter nobody can act on is just a slow data leak._
  ```
- [ ] **8.7 · Verify** `correlationId` **joins API and worker logs** end to end.
  ```
  _A correlation id that stops at the process boundary is decorative._
  ```

### Done when

- [ ] A scrapeable `/metrics` exists on both processes
- [ ] Queue depth visibly rises and drains under load
- [ ] One job's full story is retrievable from logs by `correlationId` alone

---

# M9 · Test harness and CI

**Goal:** everything written ad hoc so far becomes an automated, repeatable suite.
**Spec:** §14, §15 · _Introduces no new tests — see the testing policy above._

### Tasks

- [x] **9.1 · Vitest config**, shared test module builder, DI-swap conventions.
  ```
  `Test.createTestingModule().overrideProvider()` _is the payoff of DI._
  ```
- [x] **9.2 · e2e harness** — boot the real app, real Postgres and Redis, Supertest.
  ```
  _Mocked infrastructure cannot exercise a transaction or a queue._
  ```
- [x] **9.3 · Deterministic fixtures** + isolated DB state per test.
  ```
  _A shared dirty database makes failures unreproducible._
  ```
- [x] **9.4 · Automate A1–A7** — including process kill/restart — as suite cases.
  ```
  _Manual reliability checks decay the moment they stop being run._
  ```
- [x] **9.5 · GitHub Actions** — Postgres + Redis service containers, `migrate deploy`, lint → typecheck → test.
  ```
  _An unbiased "does it work from scratch" gate on every push._
  ```
- [x] **9.6 · Coverage reporting — reported, not gated.** Reframed while implementing: the
  ```
  reliability paths run in child processes, where V8 coverage cannot see them, so a percentage
  threshold could only be met by unit tests that mock Prisma and BullMQ. The gate for reliability
  is the named assertions of §14; coverage runs with `all: true` so untested files read as 0%
  rather than vanishing from the average. See TECH_SPEC §15.1.
  ```
  ```
  _Not all uncovered lines cost the same — and a number that can be reached by mocking the thing
  under test is worse than no number._
  ```

### Done when

- [x] `npm run test:all` reproduces every reliability assertion without manual steps — the three
  ```
  scripts chain in one command. Counts are not recorded here: every phase adds tests, so a number
  in this line is stale by the next commit.
  ```
- [ ] CI is green from a clean checkout — the workflow is written and YAML-valid but **cannot be
  ```
  verified until it has run on a push**; this stays open deliberately
  ```
- [x] A deliberately reintroduced double-charge bug fails CI — verified by re-scoping the ledger
  ```
  key to the attempt number: A3 failed with 12 ledger rows for 6 jobs, and the source was restored
  by the harness script's trap
  ```

---

# M10 · Load testing

**Goal:** the invariant survives contention, and the ceiling is a number rather than a belief.
**Spec:** §14 (A9), §15

### Tasks

- [ ] **10.1 · Fix numeric targets first** — p95 submit latency, throughput, max queue depth, drain time.
  ```
  _A target chosen after seeing the result is not a target._
  ```
- [ ] **10.2 · k6 scenarios** — sustained submit, burst, and a mixed job-type profile.
  ```
  _Different shapes expose different bottlenecks._
  ```
- [ ] **10.3 · Run A9** — kill a worker mid-run under sustained load; A2 and A3 must still hold.
  ```
  _Correctness claims are unproven until they are contended._
  ```
- [ ] **10.4 · Scale to ≥2 worker instances**; confirm no job is processed twice.
  ```
  _Single-worker runs cannot detect a broken claim guard._
  ```
- [ ] **10.5 · Observe connection-pool behaviour** and queue backpressure.
  ```
  _Pool exhaustion is the usual first ceiling._
  ```
- [ ] **10.6 · Resolve D6a** (queue split) and **D10** (concurrency, sandboxed processors) from measurements.
  ```
  _Both triggers are defined as measurements, not opinions._
  ```

### Done when

- [ ] The targets from 10.1 are met, or the gap is documented
- [ ] **A9 passes**
- [ ] D6a and D10 are closed with numbers attached

---

# M11 · Deployment

**Goal:** running on a real box, on a real domain, over HTTPS.
**Spec:** §3, §11, §15

### Tasks

- [ ] **11.1 · Multi-stage Dockerfile**, non-root user, config from the environment only.
  ```
  _One image runs in any environment; nothing baked in._
  ```
- [ ] **11.2 · Provision the VPS** — Ubuntu, non-root user, SSH keys, `ufw`.
  ```
  _The firewall is the boundary the PaaS used to own._
  ```
- [ ] **11.3 · Caddy in front** — automatic HTTPS, a real domain.
  ```
  _A reverse proxy without the certificate ceremony._
  ```
- [ ] **11.4 · API + worker via compose** on the box; managed Postgres; restart policies.
  ```
  _Self-hosting the app keeps ops in scope; a managed DB owns durability and backups._
  ```
- [ ] **11.5 · Migrations as a release step**, never at image build.
  ```
  _A start command that exits is a crash loop; build has no database._
  ```
- [ ] **11.6 · Second API instance** → resolve **D13** and D8's multi-instance half.
  ```
  _socket.io needs the Redis adapter **plus** websocket-only transport or sticky routing._
  ```
- [ ] **11.7 · Backup and a rehearsed restore.**
  ```
  _An unrehearsed backup is a hypothesis._
  ```

### Done when

- [ ] The API answers over HTTPS on a real domain
- [ ] A reboot brings both processes back unattended
- [ ] A restore from backup has been performed at least once

---

# Dependency order

```
M1 ─▶ M2 ─▶ M3 ─▶ M4 ─▶ M5 ─▶ M6 ─▶ M7 ─▶ M8 ─▶ M9 ─▶ M10 ─▶ M11
                        │      ▲                     │
                        └──────┘                     └── D6a, D10 resolved here
                 M5 must be stable before M6 begins.
```

M1–M4 are conventional API work. **M5 and M6 carry the system's core risk** and take
proportionally more of the schedule. M9 must precede M10 — an unautomated assertion cannot be
checked under load. M10 must precede M11, so the box is sized against measured numbers.

---

# PA · Handler registry, progress, cancellation

**Goal:** job types are pluggable, long jobs report progress, and a running job can be stopped.
**Spec:** §9.2, D21, D22, D25, D11 · _Consumes: D21, D22, D25, D11._

### Tasks

- [x] **A.1 ·** `Job.type` **becomes a string** (D21) — `JOB_TYPES` is derived from the submit
  ```
  union, so the Zod enum and the TS literal union cannot drift; the migration drops the
  `JobType` enum.
  ```
  ```
  _An enum makes every new type a migration, and Postgres enum labels can never be removed._
  ```
- [x] **A.2 ·** `JobHandler` **abstract base class** — `type`, `payloadSchema`, `execute(ctx,

payload)`; the registry resolves by type via DI and the processor names no type. A base class rather than a bare interface because the payload re-parse belongs to every handler. No per-handler` queue`: one queue still carries every type (§8.1).

- [x] **A.3 ·** `JobContext` — `reportProgress` and `log`, on top of the job id and attempt it
  ```
  already carries. **Not** the idempotency key: it is unique per tenant while
  `SideEffect.effectKey` is unique globally, so a handler keying an effect on it would let one
  tenant suppress another's. `isCancelRequested` moves to A.6, with the column that backs it — a
  capability that always answers `false` is a lie written into a type handlers are told to trust.
  ```
  ```
  _Handlers get a capability object, not the Prisma client; what a handler may do is a
  deliberate list._
  ```
- [x] **A.4 ·** `progress Json?` **on** `Job`, written per batch with the `attempts` ownership
  ```
  predicate (D25) **and** a `processed <` predicate on the jsonb path, because a retry is the live
  attempt and counts from one again.
  ```
  ```
  _Progress is not a status transition, but a stale worker must still not overwrite it — and
  neither must the job's own second attempt._
  ```
- [x] **A.5 · Throttle the emits** — at most one per job per 500 ms, and always the final one.
  The window governs the **write** as well, since the two are one decision, and it is what bounds
  the write amplification a client can ask for with `steps: 100`. Leading-edge and trailing-edge:
  the first report goes at once so a bar starts moving, later ones replace each other, and
  `flush()` is exempt so the last value cannot be lost.
  ```
  _A 20k-row import at one event per row floods the socket and the client repaints uselessly._
  ```
- [ ] **A.6 ·** `CANCELLED` **+** `cancelRequested` (D22), `POST /jobs/:id/cancel` and
  ```
  `JobContext.isCancelRequested` — remove from the queue if it has not started, otherwise set the
  flag and let the handler exit at a batch boundary.
  ```
  ```
  _You cannot safely kill code mid-flight. Cancellation is a request plus an acknowledgement,
  which is why it is two fields and not one status._
  ```
- [ ] **A.7 · Bulk re-drive by filter** (D11) — type, error code, time range.
  ```
  _One dead letter is a row; four thousand is an operation._
  ```

### Done when

- [ ] **A11 passes** — a cancelled mid-flight job ends `CANCELLED` with no effect beyond its last
  ```
  committed batch, and `cancelRequested` never strands a job that had already finished
  ```
- [x] **A12 passes** — progress never goes backwards, and a stale attempt cannot write it
- [ ] Adding a job type touches no file in `src/worker/`

---

# PB · Object storage, `Product` domain, `import.csv`

**Goal:** a 20 000-row CSV imports without timing out, resumes after a crash, and reports its bad
rows.
**Spec:** D26, D14, §7.1 · _Consumes: D26, D14._

### Tasks

- [ ] **B.1 · MinIO in compose** + `@aws-sdk/client-s3` (`forcePathStyle`), presigned `PUT` for
  ```
  upload and short-expiry presigned `GET` for download.
  ```
  ```
  _The API never streams a file body. Moving to real S3 then changes config, not code._
  ```
- [ ] **B.2 ·** `Product` **model** — `UNIQUE (userId, sku)`.
  ```
  _This constraint is what makes a replayed batch harmless, so the import never needs to know
  whether it has run before._
  ```
- [ ] **B.3 · Stream and batch** — `csv-parse` in streaming mode, per-row Zod, upsert ~500 rows per
  ```
  transaction.
  ```
  ```
  _Never load the file into memory: the whole client problem is that the naive version dies on
  size._
  ```
- [ ] **B.4 · Checkpoint and resume** (D26) — its own storage, not `result` and not `progress`;
  ```
  `redrive()` leaves it alone; `?from=start` forces a restart.
  ```
  ```
  _A re-drive asks "did this happen?", not "do it again" — the same semantic already settled for_
  `effectKey`_._
  ```
- [ ] **B.5 · Error report** — invalid rows to `error-report.csv` in storage, presigned link in the
  ```
  job result; bad rows never fail the job, but `IMPORT_MOSTLY_INVALID` fails fast on a wrong file.
  ```
  ```
  _Distinguish "this data has problems" from "this is not the file you think it is"._
  ```
- [ ] **B.6 · Cursor pagination** on `/jobs` and `/products` (D14).
  ```
  _A 20k-product catalog is where offset paging starts to hurt._
  ```

### Done when

- [ ] **A13 passes** — 20 000 rows import with flat memory
- [ ] **A14 passes** — `SIGKILL` mid-import resumes from the checkpoint; the final product count is
  ```
  exact and contains no duplicates
  ```
- [ ] **A15 passes** — the same file submitted twice returns the first job
- [ ] The error report is downloadable and its row numbers match the source file

---

# PC · `image.process`

**Goal:** product images become WebP variants, and a hostile `imageUrl` cannot reach anything
private.
**Spec:** §7.6, §7.7, D10 · _Consumes: D10._

### Tasks

- [ ] **C.1 · Outbound request guard** — http/https only, **private and link-local ranges blocked
  ```
  after DNS resolution**, timeout, max body size, content-type check.
  ```
  ```
  _Blocking by hostname is not enough: a name that resolves to 169.254.169.254 is the attack.
  Resolve first, check the address, then connect._
  ```
- [ ] **C.2 ·** `sharp` **variants** at deterministic keys `products/{userId}/{sku}/{size}.webp`.
  ```
  _A deterministic key makes a re-run overwrite with identical bytes, so idempotency needs no
  ledger here._
  ```
- [ ] **C.3 · Transient vs permanent** — a timeout retries; a 404 or a non-image throws
  ```
  `TerminalJobError` and dead-letters immediately.
  ```
  ```
  _This is_ `TerminalJobError`_'s first real caller; until now the branch existed and nothing
  could reach it._
  ```
- [ ] **C.4 · Resolve D10** — measure BullMQ lock renewal while N image batches run.
  ```
  _`sharp` is async but runs on the libuv threadpool. Saturating 4 threads delays all async I/O
  in the process, lock renewal included, so a batch can self-stall without ever blocking the
  event loop. Measure before choosing concurrency or a sandboxed processor._
  ```

### Done when

- [ ] **A16 passes** — `http://localhost`, `http://169.254.169.254` and a DNS name resolving to a
  ```
  private address are all rejected
  ```
- [ ] **A17 passes** — a permanent error consumes one attempt, not the whole budget
- [ ] **A18 passes** — image batches at the chosen concurrency do not trigger stalled redeliveries

---

# PD · `ai.enrich`

**Goal:** LLM output is treated as untrusted input, and provider rate limits slow the queue instead
of failing jobs.
**Spec:** D6a · _Consumes: D6a._

### Tasks

- [ ] **D.1 ·** `LlmProvider` **interface** + `FakeLlmProvider` — deterministic, no API key, and
  ```
  able to simulate 429s and malformed JSON on demand.
  ```
  ```
  _The fake is not a stand-in for the real one; it is the only way to test the failure paths the
  real one produces rarely and expensively._
  ```
- [ ] **D.2 · A separate** `relay-ai` **queue with a** `limiter` **(resolves D6a)** and low
  ```
  concurrency.
  ```
  ```
  _A BullMQ limiter is per-queue, so the rate limit itself forces the split — not a starvation
  measurement, which is what D6a was waiting for._
  ```
- [ ] **D.3 · Zod-validate every item** — one corrective retry, then
  ```
  `enrichmentStatus = 'failed'`; a category outside the enum is rejected.
  ```
  ```
  _A hallucinated category is indistinguishable from a valid one until something checks. This is
  the lesson of the phase._
  ```
- [ ] **D.4 · Honour 429s** — `worker.rateLimit(ms)` + `RateLimitError`, using `Retry-After`.
  ```
  _Backpressure, not failure: the job has not failed, the provider is busy._
  ```
- [ ] **D.5 ·** `enrichmentInputHash` **skip** + conditional update on write.
  ```
  _Re-running must cost nothing for unchanged products, and must never overwrite newer data._
  ```
- [ ] **D.6 · Track** `tokensIn`, `tokensOut`, `estimatedCostUsd` per job.

### Done when

- [ ] **A19 passes** — malformed or out-of-schema output never reaches the database
- [ ] **A20 passes** — simulated 429s slow the queue; no job fails because of one
- [ ] **A21 passes** — re-running enrichment on unchanged products issues zero provider calls

---

# PE · Pipeline fan-out

**Goal:** one import fans out into enrichment and image batches and converges on a summary, with
partial failure as a first-class outcome.
**Spec:** D23, D24, D22 · _Consumes: D23, D24._

### Tasks

- [ ] **E.1 ·** `Pipeline` **model** with a `pendingChildren` counter and aggregate counts.
- [ ] **E.2 · Children are our own rows** (D24), each with a **server-minted deterministic**
  ```
  idempotency key `pipeline:<id>:<stage>:<batch>` (D23), enqueued through the outbox.
  ```
  ```
  _`FlowProducer` would make Redis a second source of truth for pipeline structure and its
  children would bypass the outbox. Minting the key server-side also means
  `UNIQUE (userId, idempotencyKey)` makes the fan-out itself idempotent, for free._
  ```
- [ ] **E.3 · The parent is enqueued by the transaction that takes** `pendingChildren` **to zero.**
  ```
  _Parent-runs-when-children-finish becomes a conditional UPDATE on a counter — the idiom the
  whole engine already uses — and the parent's outbox row is written in that same transaction._
  ```
- [ ] **E.4 · Child-failure policy** — a failed batch does not fail the pipeline; the pipeline ends
  ```
  `completed_with_errors` (on `Pipeline`, never on `Job` — D22) and the batch stays re-drivable.
  ```

### Done when

- [ ] **A22 passes** — a failed child leaves the pipeline `completed_with_errors`, not failed
- [ ] **A23 passes** — replaying the fan-out cannot create a second row for any batch
- [ ] **A24 passes** — a crash between the last child committing and the parent being enqueued is
  ```
  recovered by the outbox relay
  ```

---

# PF · API keys and public docs

**Goal:** another system can drive Relay without a browser session.
**Spec:** §6 · _Consumes: nothing new._

### Tasks

- [ ] **F.1 ·** `ApiKey` **model** — `prefix` shown in the UI, SHA-256 `hash`, `scopes`,
  ```
  `lastUsedAt`, `revokedAt`. The secret is displayed once and never stored.
  ```
  ```
  _Hash, not encrypt: nothing ever needs to read the key back, only to compare it._
  ```
- [ ] **F.2 ·** `ApiKeyGuard` **beside** `JwtAuthGuard` — either satisfies a job endpoint.
- [ ] **F.3 · Swagger** for the public surface, documenting api-key auth.

### Done when

- [ ] **A25 passes** — a revoked key is refused, and revocation takes effect without a restart
- [ ] **A26 passes** — the plaintext key appears in no row and no log line

---

# PH · Presentation

- [ ] README: problem → architecture diagram → the reliability guarantees and the assertion that
  ```
  proves each → screenshots → how to run
  ```
- [ ] `docker compose up` starts API, worker, Postgres, Redis, MinIO
- [ ] A 60-second demo script that includes killing a worker mid-run

### Done when

- [ ] A reader who knows nothing about the project can run it and reproduce A3 from the README

---

# PI · Billing

**Goal:** a real Stripe subscription integration with plan limits enforced by the API.
**Spec:** to be written as `docs/BILLING_SPEC.md` **at the start of this phase, not before** —
subscription fields move between Stripe API versions and a spec written now would be stale.
_Consumes: D27._

Shape only, so the earlier phases leave room for it:

- [ ] Webhook endpoint with signature verification over the **raw** body, `StripeEvent` dedupe by
  ```
  `eventId`, and the work done on Relay's own queue
  ```
- [ ] Local state rebuilt by **fetching the subscription from Stripe**, never from event payload
  ```
  order
  ```
- [ ] `EntitlementsService` as the single answer to "what plan, which limits, how much used"
- [ ] Quota consumed through `SideEffect` with `effectKey = '<jobId>:quota:<batchIndex>'` (D27), so
  ```
  a retried batch cannot consume twice
  ```
- [ ] Count limits checked inside a transaction; a downgrade **disables** surplus resources and
  ```
  never deletes them
  ```

### Done when

- [ ] The same webhook delivered twice changes state once; out-of-order events still converge
- [ ] Two parallel imports near the limit never exceed it in total
- [ ] Access is never granted without a verified webhook
