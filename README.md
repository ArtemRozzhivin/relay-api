# Relay

[![CI](https://github.com/ArtemRozzhivin/relay-api/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ArtemRozzhivin/relay-api/actions/workflows/ci.yml)

An async job-processing API where a submitted job runs its side effect **exactly once**, or ends
in a state that says why. No lost work, no duplicated work, no silent partial work, and each of
those claims has a test that kills real processes to prove it.

## What it does

- **Jobs over HTTP.** `POST /jobs` with an `Idempotency-Key` answers `202` at once; a separate
  worker process runs the job, with retries and backoff, dead-lettering, cancellation, and
  re-drive one at a time or by filter — with the dead letters a filter matches listed first.
- **CSV catalog import.** The client uploads straight to S3 with a presigned POST, so the API never
  carries the file. The worker streams it into Postgres 500 rows at a time in flat memory, resumes
  from its last committed batch after a crash, and leaves a downloadable report of the bad rows.
- **Product images.** The worker downloads each product's image from the seller's URL through a
  guard that reaches only public addresses, so a URL cannot point it at the cloud metadata
  service, and stores three WebP sizes in S3.
- **AI enrichment.** A language model gives each product a category from a fixed list and some
  tags, and every answer is checked before anything is written. The model sits behind one
  interface; the one bound by default is a deterministic fake that needs no key and costs nothing.
- **Pipelines.** `POST /pipelines` imports a catalog, fans out into enrichment and image batches,
  and sums up what they did once the last one finishes.
- **Limits per account.** Caps on unfinished jobs, one running pipeline, 5 000 products a store
  and 20 uploads a day, so one account cannot fill the queues or the bucket for the others.
- **API keys** for a seller's own scripts, with read and write scopes, and the reference at `/docs`.
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
| One request id finds everything it caused, in both logs   | A job fails, is re-driven; both processes' logs read back (A28)   |
| A model's answer is checked before anything is written    | Cut-off JSON and a category outside the list (A19)                |
| A provider's rate limit slows only the jobs that call it  | AI jobs limited to 1 a second; other jobs run at once (A29)       |
| A busy AI provider slows the queue and fails no job       | A 429 on a one-attempt job: the queue waits, the job runs (A20)   |
| Enriching an unchanged product again costs nothing        | A second run on the same text asks the model nothing (A21)        |
| A pipeline writes each of its batches once                | The import fails after writing them; the retry writes none (A23)  |
| A pipeline's summary job survives a crash                 | API down and worker killed around the last batch (A24)            |
| A failed batch does not fail its pipeline                 | One batch dead-letters; the pipeline ends with errors (A22)       |
| A revoked API key stops working on the next request       | Revoke, then use it at once, same process (A25)                   |
| An API key's secret is in no row and no log line          | Every text column of every table, both logs (A26)                 |

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
                           │   ├─► S3: reads uploads; writes error reports and product images
                           │   ├─► the web: seller image URLs, through the guard (public only)
                           │   └─► the language model (a built-in fake unless one is bound)
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
cp .env.example .env         # then set AWS_REGION, S3_BUCKET and the AWS key pair
docker compose up -d         # Postgres and Redis
npm run db:migrate
npm run db:generate:client

npm run start:dev            # API on http://localhost:3000
npm run start:worker:dev     # the worker, in a second terminal
```

`GET /health` answers while the process is up; `GET /ready` also checks Postgres and Redis.
Set `METRICS_PORT` on either process to have it serve Prometheus metrics on that port
([§12.3](docs/TECH_SPEC.md#123-metrics)).
Behind a reverse proxy, set `TRUST_PROXY` to it, or every client shares the rate limits of the
proxy's address ([§15.2](docs/TECH_SPEC.md#152-phase-8--written-2026-11-12)).

To make an account an admin — needed for `GET /admin/api-keys` and `POST /admin/api-keys/revoke` —
register it, then run the line below and log in again; the role reaches the token at login.

```bash
echo "UPDATE \"User\" SET role = 'ADMIN' WHERE email = 'you@example.com';" | npx prisma db execute --stdin
```

## Tests

| Tier        | Command                    | What it covers                                                          |
| ----------- | -------------------------- | ----------------------------------------------------------------------- |
| Unit        | `npm test`                 | Services, schemas and pure helpers, in memory                           |
| Integration | `npm run test:integration` | The HTTP contract and the handlers, against real Postgres, Redis and S3 |
| Assertions  | `npm run test:assertions`  | The guarantees above, with real API and worker processes; ~16 minutes   |

CI runs all three on every pull request.

## Documentation

- [`docs/TECH_SPEC.md`](docs/TECH_SPEC.md): what the system does and why: the data model, the
  state machine, the reliability rules, and every decision with its trade-offs.
- [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md): the milestones and where each one
  stands.
- **The API reference** is served by the API itself, at `/docs` (`http://localhost:3000/docs`
  locally), with the OpenAPI document at `/docs/openapi.json`. It covers signing in with a session
  or an API key, and every route a client calls.

## License

[MIT](LICENSE)
