# Relay — Implementation Plan

Companion to [TECH_SPEC.md](./TECH_SPEC.md). The spec defines _what_ the system does and _why_;
this defines the order of work.

Eleven milestones, M1–M11, matching the spec's phases 1–11. All are in scope for v1. Each ends
in a runnable, demonstrable state.

---

## Progress

- [x] **M1** · Service skeleton
- [ ] **M2** · Authentication
- [ ] **M3** · Cross-cutting concerns
- [ ] **M4** · Jobs API
- [ ] **M5** · Queue and worker
- [ ] **M6** · Reliability
- [ ] **M7** · Realtime
- [ ] **M8** · Observability and hardening
- [ ] **M9** · Test harness and CI
- [ ] **M10** · Load testing
- [ ] **M11** · Deployment

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
- [ ] **2.2 · Register + login**, argon2id hashing.
  ```
  _Memory-hard hashing defeats GPU parallelism._
  ```
- [ ] **2.3 ·** `JwtAuthGuard` via `APP_GUARD`, `@Public()` to opt out.
  ```
  _Token-form registration goes through DI;_ `new Guard()` _cannot inject._
  ```
- [ ] **2.4 · Refresh-token rotation + logout.**
  ```
  _Access tokens cannot be revoked; refresh tokens can, because they are stored._
  ```
- [ ] **2.5 ·** `RolesGuard` **+** `@Roles()`**.**
  ```
  _Coarse-grained RBAC at the guard layer._
  ```

**Design note:** guards run before pipes in the request lifecycle, so a guard cannot read a
validated body. Ownership checks requiring a DB read belong in the service layer.

### Done when

- [ ] The full register → login → refresh → logout flow works over curl
- [ ] A protected route returns 401 without a token
- [ ] A replayed refresh token is rejected

---

# M3 · Cross-cutting concerns

**Goal:** uniform response shape, uniform error mapping, traceable logs.
**Spec:** §6.1, §6.4, §10.2, §12.1

### Tasks

- [ ] **3.1 · Global** `StandardSchemaValidationPipe` + Zod schemas, `.strict()` throughout.
  ```
  `.strict()` _is mass-assignment protection at the edge._
  ```
- [ ] **3.2 · Domain error classes +** `DomainExceptionFilter` → the envelope.
  ```
  _Operational errors surface their message; unexpected ones never leak internals._
  ```
- [ ] **3.3 ·** `ResponseEnvelopeInterceptor`**.**
  ```
  _Interceptors wrap both sides of the handler._
  ```
- [ ] **3.4 ·** `nestjs-pino`, request id, `X-Request-Id` header.
  ```
  _Structured JSON is queryable by field; a correlation id makes one request traceable._
  ```

### Done when

- [ ] Every success and every error share one envelope shape
- [ ] Every log line carries the same `requestId` as its response header

---

# M4 · Jobs API

**Goal:** submit, read, and list jobs. The handler completes work inline; no queue yet.
**Spec:** §4.3, §5, §6.3

### Tasks

- [ ] **4.1 ·** `Job` **model**, enums, indexes; raw-SQL migration for the `CHECK` constraints.
  ```
  _Prisma's schema language cannot express CHECK — use the_ `--create-only` _flow._
  ```
- [ ] **4.2 ·** `UNIQUE (userId, idempotencyKey)`**.**
  ```
  _The index is the guarantee; application code is only the coordinator._
  ```
- [ ] **4.3 ·** `POST /jobs` — insert, catch `P2002`, return the existing job with `replayed: true`.
  ```
  _SELECT-then-INSERT races; the insert is the check._
  ```
- [ ] **4.4 · The guarded-transition helper** (`updateMany` + row count).
  ```
  _The affected row count is the source of truth, never a previously read value._
  ```
- [ ] **4.5 ·** `GET /jobs/:id`**,** `GET /jobs`, 404-before-403 on ownership.
  ```
  _The API does not reveal a resource exists to a caller with no right to it._
  ```

**Design note:** `202`, not `201` — the work is accepted, not done. A replay returns `202` with
the same job id rather than `409`, so retry logic stays out of the client.

### Done when

- [ ] Submitting twice with the same `Idempotency-Key` returns the same job id
- [ ] Another user's job id returns 404

---

# M5 · Queue and worker

**Goal:** work leaves the request lifecycle. Two processes, one queue.
**Spec:** §3, §8, §10.1 · _Largest structural change in the project._

### Tasks

- [ ] **5.1 ·** `BullModule.forRoot` **+** `registerQueue` in `JobsModule` — producer only.
  ```
  _Producer and consumer registration are the same call; the distinction is deliberate._
  ```
- [ ] **5.2 ·** `worker.ts` — second bootstrap via `createApplicationContext()`.
  ```
  _A Nest context with no HTTP server; two disjoint root modules._
  ```
- [ ] **5.3 ·** `JobsProcessor extends WorkerHost`**.**
  ```
  _The_ `@nestjs/bullmq` _v12 shape; the legacy_ `@Process()` _API does not apply._
  ```
- [ ] **5.4 · Handler registry** — `MOCK` (awaited sleep) and `CHARGE`.
  ```
  _A CPU-blocking processor fails to renew its lock and stalls itself._
  ```
- [ ] **5.5 · Worker-side transitions** `QUEUED → RUNNING → SUCCEEDED`.
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

- [ ] **A2 passes** — N jobs submitted, N terminal, none stuck
- [ ] The worker keeps draining with the API stopped
- [ ] `AppModule` provably does not import `ProcessingModule`

---

# M6 · Reliability

**Goal:** the §1 invariant holds under induced failure.
**Spec:** §7, §4.4, §4.5 · _Carries the system's core risk._

Each step is motivated by the failure of the one before it.

### Tasks

- [ ] **6.1 · Write A3 and confirm it fails** — submit jobs, `SIGKILL` the worker mid-charge, count ledger rows.
  ```
  _Establishes the baseline defect the effect guard must eliminate._
  ```
- [ ] **6.2 ·** `SideEffect` **table** + `effectKey = ${jobId}:${kind}`.
  ```
  _Deterministic derivation — never a clock, a random source, or an attempt number._
  ```
- [ ] **6.3 ·** `CHARGE` **writes the ledger row** in the same transaction as the status.
  ```
  _The effect guard. A3 now passes._
  ```
- [ ] **6.4 · Retries** — attempts, exponential backoff with full jitter.
  ```
  _Without jitter a batch that fails together retries in lockstep at every doubling._
  ```
- [ ] **6.5 · Error taxonomy** — plain `Error` vs `UnrecoverableError`.
  ```
  _A terminal error should not consume the full retry budget._
  ```
- [ ] **6.6 ·** `DEAD_LETTERED` **+** `POST /jobs/:id/retry` → resolve **D6b**.
  ```
  _Anything that must survive a Redis flush is a Postgres row._
  ```
- [ ] **6.7 · Induce a stalled worker**, observe the stuck `RUNNING` row → resolve **D7**.
  ```
  _The claim guard is decided against observed behaviour, not assumption._
  ```
- [ ] **6.8 · Write A6** to demonstrate the commit-then-enqueue gap.
  ```
  _A test written to fail documents an accepted risk precisely._
  ```
- [ ] **6.9 ·** `Outbox` **+** `@nestjs/schedule` **relay tick** → A6 passes.
  ```
  _The transactional outbox closes the dual-write hole._
  ```

### Done when

- [ ] **A1, A3, A4, A5, A6 all pass**
- [ ] Killing the worker at any point during a run leaves ledger rows equal to job count

---

# M7 · Realtime

**Goal:** clients observe job status live.
**Spec:** §9

### Tasks

- [ ] **7.1 ·** `EventsGateway` — auth on connect, room `user:<userId>` from the verified token.
  ```
  _A socket cannot carry an auth header per frame; the room is assigned server-side._
  ```
- [ ] **7.2 · Resolve D8** — Redis pub/sub bridge from worker to API.
  ```
  _Transitions occur in the worker; sockets live in the API._
  ```
- [ ] **7.3 ·** `job.updated` **emitted after commit**, never inside the transaction.
  ```
  _Emitting pre-commit can broadcast a state the DB rolls back._
  ```
- [ ] **7.4 · A static HTML page** that opens the socket.
  ```
  _Sufficient to demonstrate realtime; the frontend is out of scope._
  ```

### Done when

- [ ] **A7 passes** — a client disconnected mid-processing reconciles to the correct terminal
  ```
  state via `GET /jobs/:id` on reconnect
  ```

---

# M8 · Observability and hardening

**Goal:** the system is measurable and safe to expose.
**Spec:** §12, §15

### Tasks

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

- [ ] **9.1 · Vitest config**, shared test module builder, DI-swap conventions.
  ```
  `Test.createTestingModule().overrideProvider()` _is the payoff of DI._
  ```
- [ ] **9.2 · e2e harness** — boot the real app, real Postgres and Redis, Supertest.
  ```
  _Mocked infrastructure cannot exercise a transaction or a queue._
  ```
- [ ] **9.3 · Deterministic fixtures** + isolated DB state per test.
  ```
  _A shared dirty database makes failures unreproducible._
  ```
- [ ] **9.4 · Automate A1–A7** — including process kill/restart — as suite cases.
  ```
  _Manual reliability checks decay the moment they stop being run._
  ```
- [ ] **9.5 · GitHub Actions** — Postgres + Redis service containers, `migrate deploy`, lint → typecheck → test.
  ```
  _An unbiased "does it work from scratch" gate on every push._
  ```
- [ ] **9.6 · Coverage reporting**, with the reliability paths held to a higher bar.
  ```
  _Not all uncovered lines cost the same._
  ```

### Done when

- [ ] `npm test` reproduces every reliability assertion without manual steps
- [ ] CI is green from a clean checkout
- [ ] A deliberately reintroduced double-charge bug fails CI

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
