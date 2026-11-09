# Relay

[![CI](https://github.com/ArtemRozzhivin/relay-api/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ArtemRozzhivin/relay-api/actions/workflows/ci.yml)

An async job-processing API where a submitted job runs its side effect **exactly once**, or ends
in a state that says why. No lost work, no duplicated work, no silent partial work, and each of
those claims has a test that kills real processes to prove it.

## What it does

- **Jobs over HTTP.** `POST /jobs` with an `Idempotency-Key` answers `202` at once; a separate
  worker process runs the job, with retries and backoff, dead-lettering, cancellation, and
  re-drive one at a time or by filter.
- **CSV catalog import.** The client uploads straight to S3 with a presigned POST, so the API never
  carries the file. The worker streams it into Postgres 500 rows at a time in flat memory, resumes
  from its last committed batch after a crash, and leaves a downloadable report of the bad rows.
- **Live progress.** Status and progress reach the browser over Socket.IO, while `GET /jobs/:id`
  stays the source of truth a client reconciles with after a reconnect.

## What is guaranteed, and how it is proven

Each row is a test in [`test/assertions/`](test/assertions) that starts the real API and worker as
separate OS processes against real Postgres, Redis and S3. Each one also checks that the event it
is about really happened, such as a worker dying mid-job, so it cannot pass on a run that proved
nothing.

| Guarantee                                                 | How the test attacks it                                           |
| --------------------------------------------------------- | ----------------------------------------------------------------- |
| A retried submit creates one job                          | Concurrent submits under one key (A1)                             |
| A worker killed mid-charge charges once                   | `SIGKILL` while jobs are running, then restart (A3)               |
| A frozen worker cannot overwrite the one that replaced it | `SIGSTOP`, let another worker take the job, `SIGCONT` (A3b, A3c)  |
| A crash between commit and enqueue loses nothing          | A fault injected at exactly that point; the outbox recovers (A6)  |
| A job the queue gives up on still finishes                | Stalls past BullMQ's limit, with and without its event (A5b, A5d) |
| A cancelled job stops at a safe point                     | Cancel mid-batch: whole batches only (A11)                        |
| Progress never moves backwards                            | Reports from a stale attempt are refused (A12)                    |
| An import killed mid-file resumes rather than restarts    | `SIGKILL` while a batch is held on a row lock (A14)               |
| The same file submitted twice imports once                | Two submits, one key, one catalog (A15)                           |

The full list, with the SQL each test checks, is §14 of the
[technical specification](docs/TECH_SPEC.md#14-verification-plan).

## How it fits together

```
client ──HTTP──► API ──► Postgres: the Job and its Outbox row, in one transaction
                  │
                  └──► BullMQ on Redis ◄── outbox relay: publishes whatever the API did not
                           │
                           ▼
                        worker ──► Postgres: status, progress, products
                           │   └─► S3: reads uploads, writes error reports
                           ▼
client ◄─Socket.IO─ API ◄─Redis pub/sub─ job.updated
```

Postgres is the source of truth and Redis only delivers, at least once. Every write a worker makes
is a conditional `UPDATE` carrying the lease it claimed the job with, so a worker the queue has
given up on matches no rows.

## Stack

NestJS 12 (ESM) · TypeScript · Prisma 7 · PostgreSQL 17 · Redis 7 and BullMQ · AWS S3 · Socket.IO ·
Zod · Vitest · GitHub Actions

## Run it locally

Needs Node 24 (see `.nvmrc`), Docker, and an S3 bucket with an IAM user allowed into it alone. The
one-time AWS setup is in [§13.4 of the specification](docs/TECH_SPEC.md#134-local-stack).

```bash
npm ci
cp .env.example .env         # then set S3_BUCKET and the AWS key pair
docker compose up -d         # Postgres and Redis
npm run db:migrate
npm run db:generate:client

npm run start:dev            # API on http://localhost:3000
npm run start:worker:dev     # the worker, in a second terminal
```

`GET /health` answers while the process is up; `GET /ready` also checks Postgres and Redis.

## Tests

| Tier        | Command                    | What it covers                                                          |
| ----------- | -------------------------- | ----------------------------------------------------------------------- |
| Unit        | `npm test`                 | Services, schemas and pure helpers, in memory                           |
| Integration | `npm run test:integration` | The HTTP contract and the handlers, against real Postgres, Redis and S3 |
| Assertions  | `npm run test:assertions`  | The guarantees above, with real API and worker processes; ~13 minutes   |

CI runs all three on every pull request.

## Documentation

- [`docs/TECH_SPEC.md`](docs/TECH_SPEC.md): what the system does and why: the data model, the
  state machine, the reliability rules, and every decision with its trade-offs.
- [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md): the milestones and where each one
  stands.

## License

[MIT](LICENSE)
