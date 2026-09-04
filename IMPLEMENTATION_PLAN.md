# Relay — Implementation Plan

Companion to [`TECH_SPEC.md`](./TECH_SPEC.md). The spec defines *what* the system does and *why*;
this defines the order of work.

Eleven milestones, M1–M11, matching the spec's phases 1–11. All are in scope for v1. Each ends
in a runnable, demonstrable state.

---

## Progress

- [ ] **M1** · Service skeleton
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

A milestone is complete when every task **and** every *Done when* item under it is checked.

---

## Testing policy

**Tests are written with the code they cover, in every milestone.** They are not deferred to M9
and are not itemised per task below — the expectation is standing:

| Scope | Written when | Runner |
|---|---|---|
| Unit — services, guards, pipes, filters, pure helpers | Alongside the unit | Vitest, providers swapped in the DI container |
| Integration — repositories, transactions, guarded transitions | Alongside the query | Vitest against a real Postgres |
| e2e — HTTP contract, auth flows, the job lifecycle | When the endpoint lands | `@nestjs/testing` + Supertest |
| Reliability assertions **A1–A10** (spec §14) | In the milestone that makes each provable | See the phase column in §14 |

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
  *Local Node matches the Docker image, so native modules behave identically in both.*
- [x] **1.2 · `docker-compose.yml`** — postgres 17 + redis 7, healthchecks, named volumes.
  *`pg_isready`, not a port check: the port opens before the server accepts queries.*
- [x] **1.3 · Scaffold Nest 12** — ESM (`"type": "module"`), tsconfig, npm scripts.
  *The CLI now emits ESM by default (`nodenext`, `.js` import extensions) — no conversion needed.
  Vitest and oxlint are the generated defaults; `@nestjs/mau` removed, as M11 deploys by hand.*
- [ ] **1.4 · `ConfigModule` + Zod env schema**, validated at boot.
  *Invalid configuration fails startup, not a request in production.*
- [ ] **1.5 · Prisma** — `prisma-client` generator with `output`, `PrismaService`, driver adapter.
  *Single injectable client; `prisma-client-js` is deprecated.*
- [ ] **1.6 · `RedisModule`** exporting an ioredis client.
  *One connection, injected where needed.*
- [ ] **1.7 · `/health` + `/ready`** — Terminus + a custom Redis indicator.
  *Terminus ships no first-party Redis indicator.*

### Done when

- [x] `docker compose up -d` brings postgres and redis to `healthy`
- [x] `npm run start:dev` boots the API
- [ ] Removing a required env var crashes at startup with a readable message
- [ ] `GET /ready` returns 200, and 503 when the Postgres container is stopped

---

# M2 · Authentication

**Goal:** register, login, refresh, logout, expressed as Nest guards.
**Spec:** §4.1–4.2, §6.2

### Tasks

- [ ] **2.1 · `User` + `RefreshToken` models**, first migration.
  *`ON DELETE CASCADE` is a schema-level policy decision.*
- [ ] **2.2 · Register + login**, argon2id hashing.
  *Memory-hard hashing defeats GPU parallelism.*
- [ ] **2.3 · `JwtAuthGuard`** via `APP_GUARD`, `@Public()` to opt out.
  *Token-form registration goes through DI; `new Guard()` cannot inject.*
- [ ] **2.4 · Refresh-token rotation + logout.**
  *Access tokens cannot be revoked; refresh tokens can, because they are stored.*
- [ ] **2.5 · `RolesGuard` + `@Roles()`.**
  *Coarse-grained RBAC at the guard layer.*

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

- [ ] **3.1 · Global `StandardSchemaValidationPipe`** + Zod schemas, `.strict()` throughout.
  *`.strict()` is mass-assignment protection at the edge.*
- [ ] **3.2 · Domain error classes + `DomainExceptionFilter`** → the envelope.
  *Operational errors surface their message; unexpected ones never leak internals.*
- [ ] **3.3 · `ResponseEnvelopeInterceptor`.**
  *Interceptors wrap both sides of the handler.*
- [ ] **3.4 · `nestjs-pino`**, request id, `X-Request-Id` header.
  *Structured JSON is queryable by field; a correlation id makes one request traceable.*

### Done when

- [ ] Every success and every error share one envelope shape
- [ ] Every log line carries the same `requestId` as its response header

---

# M4 · Jobs API

**Goal:** submit, read, and list jobs. The handler completes work inline; no queue yet.
**Spec:** §4.3, §5, §6.3

### Tasks

- [ ] **4.1 · `Job` model**, enums, indexes; raw-SQL migration for the `CHECK` constraints.
  *Prisma's schema language cannot express CHECK — use the `--create-only` flow.*
- [ ] **4.2 · `UNIQUE (userId, idempotencyKey)`.**
  *The index is the guarantee; application code is only the coordinator.*
- [ ] **4.3 · `POST /jobs`** — insert, catch `P2002`, return the existing job with `replayed: true`.
  *SELECT-then-INSERT races; the insert is the check.*
- [ ] **4.4 · The guarded-transition helper** (`updateMany` + row count).
  *The affected row count is the source of truth, never a previously read value.*
- [ ] **4.5 · `GET /jobs/:id`, `GET /jobs`**, 404-before-403 on ownership.
  *The API does not reveal a resource exists to a caller with no right to it.*

**Design note:** `202`, not `201` — the work is accepted, not done. A replay returns `202` with
the same job id rather than `409`, so retry logic stays out of the client.

### Done when

- [ ] Submitting twice with the same `Idempotency-Key` returns the same job id
- [ ] Another user's job id returns 404

---

# M5 · Queue and worker

**Goal:** work leaves the request lifecycle. Two processes, one queue.
**Spec:** §3, §8, §10.1 · *Largest structural change in the project.*

### Tasks

- [ ] **5.1 · `BullModule.forRoot` + `registerQueue`** in `JobsModule` — producer only.
  *Producer and consumer registration are the same call; the distinction is deliberate.*
- [ ] **5.2 · `worker.ts`** — second bootstrap via `createApplicationContext()`.
  *A Nest context with no HTTP server; two disjoint root modules.*
- [ ] **5.3 · `JobsProcessor extends WorkerHost`.**
  *The `@nestjs/bullmq` v12 shape; the legacy `@Process()` API does not apply.*
- [ ] **5.4 · Handler registry** — `MOCK` (awaited sleep) and `CHARGE`.
  *A CPU-blocking processor fails to renew its lock and stalls itself.*
- [ ] **5.5 · Worker-side transitions** `QUEUED → RUNNING → SUCCEEDED`.
  *Only the worker moves a job past `QUEUED`.*
- [ ] **5.6 · Compose** — two services, same image, different commands, `restart: unless-stopped`.
  *The worker's crash policy is a deployment decision, not an application one.*

**Verification:** submit a job and watch a separate worker process consume it. Stop the API
entirely — the worker continues draining the queue, confirming the process boundary.

### Done when

- [ ] **A2 passes** — N jobs submitted, N terminal, none stuck
- [ ] The worker keeps draining with the API stopped
- [ ] `AppModule` provably does not import `ProcessingModule`

---

# M6 · Reliability

**Goal:** the §1 invariant holds under induced failure.
**Spec:** §7, §4.4, §4.5 · *Carries the system's core risk.*

Each step is motivated by the failure of the one before it.

### Tasks

- [ ] **6.1 · Write A3 and confirm it fails** — submit jobs, `SIGKILL` the worker mid-charge, count ledger rows.
  *Establishes the baseline defect the effect guard must eliminate.*
- [ ] **6.2 · `SideEffect` table** + `effectKey = ${jobId}:${kind}`.
  *Deterministic derivation — never a clock, a random source, or an attempt number.*
- [ ] **6.3 · `CHARGE` writes the ledger row** in the same transaction as the status.
  *The effect guard. A3 now passes.*
- [ ] **6.4 · Retries** — attempts, exponential backoff with full jitter.
  *Without jitter a batch that fails together retries in lockstep at every doubling.*
- [ ] **6.5 · Error taxonomy** — plain `Error` vs `UnrecoverableError`.
  *A terminal error should not consume the full retry budget.*
- [ ] **6.6 · `DEAD_LETTERED` + `POST /jobs/:id/retry`** → resolve **D6b**.
  *Anything that must survive a Redis flush is a Postgres row.*
- [ ] **6.7 · Induce a stalled worker**, observe the stuck `RUNNING` row → resolve **D7**.
  *The claim guard is decided against observed behaviour, not assumption.*
- [ ] **6.8 · Write A6** to demonstrate the commit-then-enqueue gap.
  *A test written to fail documents an accepted risk precisely.*
- [ ] **6.9 · `Outbox` + `@nestjs/schedule` relay tick** → A6 passes.
  *The transactional outbox closes the dual-write hole.*

### Done when

- [ ] **A1, A3, A4, A5, A6 all pass**
- [ ] Killing the worker at any point during a run leaves ledger rows equal to job count

---

# M7 · Realtime

**Goal:** clients observe job status live.
**Spec:** §9

### Tasks

- [ ] **7.1 · `EventsGateway`** — auth on connect, room `user:<userId>` from the verified token.
  *A socket cannot carry an auth header per frame; the room is assigned server-side.*
- [ ] **7.2 · Resolve D8** — Redis pub/sub bridge from worker to API.
  *Transitions occur in the worker; sockets live in the API.*
- [ ] **7.3 · `job.updated` emitted after commit**, never inside the transaction.
  *Emitting pre-commit can broadcast a state the DB rolls back.*
- [ ] **7.4 · A static HTML page** that opens the socket.
  *Sufficient to demonstrate realtime; the frontend is out of scope.*

### Done when

- [ ] **A7 passes** — a client disconnected mid-processing reconciles to the correct terminal
      state via `GET /jobs/:id` on reconnect

---

# M8 · Observability and hardening

**Goal:** the system is measurable and safe to expose.
**Spec:** §12, §15

### Tasks

- [ ] **8.1 · Prometheus `/metrics`** — queue depth, job duration histogram, failure rate, dead-letter count.
  *Logs say what happened; metrics say how much and how often.*
- [ ] **8.2 · Metrics from both processes**, labelled by role.
  *Worker throughput is invisible from the API's registry.*
- [ ] **8.3 · Rate limiting** on the abuse-prone surface (auth, submit) → resolve **D16**.
  *Re-verify `@nestjs/throttler`'s Nest 12 support at this point rather than assuming it.*
- [ ] **8.4 · `trust proxy`** configured before rate limiting is believed.
  *Behind a proxy every client shares one IP unless the forwarded header is trusted.*
- [ ] **8.5 · helmet, CORS allowlist, body-size limits.**
  *Cheap defence in depth; `*` CORS is a dev convenience only.*
- [ ] **8.6 · Dead-letter inspection and bulk re-drive** → resolve **D11**.
  *A dead letter nobody can act on is just a slow data leak.*
- [ ] **8.7 · Verify `correlationId` joins API and worker logs** end to end.
  *A correlation id that stops at the process boundary is decorative.*

### Done when

- [ ] A scrapeable `/metrics` exists on both processes
- [ ] Queue depth visibly rises and drains under load
- [ ] One job's full story is retrievable from logs by `correlationId` alone

---

# M9 · Test harness and CI

**Goal:** everything written ad hoc so far becomes an automated, repeatable suite.
**Spec:** §14, §15 · *Introduces no new tests — see the testing policy above.*

### Tasks

- [ ] **9.1 · Vitest config**, shared test module builder, DI-swap conventions.
  *`Test.createTestingModule().overrideProvider()` is the payoff of DI.*
- [ ] **9.2 · e2e harness** — boot the real app, real Postgres and Redis, Supertest.
  *Mocked infrastructure cannot exercise a transaction or a queue.*
- [ ] **9.3 · Deterministic fixtures** + isolated DB state per test.
  *A shared dirty database makes failures unreproducible.*
- [ ] **9.4 · Automate A1–A7** — including process kill/restart — as suite cases.
  *Manual reliability checks decay the moment they stop being run.*
- [ ] **9.5 · GitHub Actions** — Postgres + Redis service containers, `migrate deploy`, lint → typecheck → test.
  *An unbiased "does it work from scratch" gate on every push.*
- [ ] **9.6 · Coverage reporting**, with the reliability paths held to a higher bar.
  *Not all uncovered lines cost the same.*

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
  *A target chosen after seeing the result is not a target.*
- [ ] **10.2 · k6 scenarios** — sustained submit, burst, and a mixed job-type profile.
  *Different shapes expose different bottlenecks.*
- [ ] **10.3 · Run A9** — kill a worker mid-run under sustained load; A2 and A3 must still hold.
  *Correctness claims are unproven until they are contended.*
- [ ] **10.4 · Scale to ≥2 worker instances**; confirm no job is processed twice.
  *Single-worker runs cannot detect a broken claim guard.*
- [ ] **10.5 · Observe connection-pool behaviour** and queue backpressure.
  *Pool exhaustion is the usual first ceiling.*
- [ ] **10.6 · Resolve D6a** (queue split) and **D10** (concurrency, sandboxed processors) from measurements.
  *Both triggers are defined as measurements, not opinions.*

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
  *One image runs in any environment; nothing baked in.*
- [ ] **11.2 · Provision the VPS** — Ubuntu, non-root user, SSH keys, `ufw`.
  *The firewall is the boundary the PaaS used to own.*
- [ ] **11.3 · Caddy in front** — automatic HTTPS, a real domain.
  *A reverse proxy without the certificate ceremony.*
- [ ] **11.4 · API + worker via compose** on the box; managed Postgres; restart policies.
  *Self-hosting the app keeps ops in scope; a managed DB owns durability and backups.*
- [ ] **11.5 · Migrations as a release step**, never at image build.
  *A start command that exits is a crash loop; build has no database.*
- [ ] **11.6 · Second API instance** → resolve **D13** and D8's multi-instance half.
  *socket.io needs the Redis adapter **plus** websocket-only transport or sticky routing.*
- [ ] **11.7 · Backup and a rehearsed restore.**
  *An unrehearsed backup is a hypothesis.*

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
