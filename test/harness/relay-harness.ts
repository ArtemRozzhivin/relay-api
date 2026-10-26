import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { PrismaPg } from '@prisma/adapter-pg';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import type { Job, JobStatus, Prisma } from '../../src/generated/prisma/client.js';
import { JOBS_QUEUE, messageId } from '../../src/jobs/job-queue.js';

const QUEUE_PREFIX = 'bull:relay-jobs';

// Each harness binds its own port. Sharing one meant a slow-to-die API from the
// previous test file still held it, the new one exited with EADDRINUSE, and the
// health check was then satisfied by the old process — so a test could run
// against a server started with entirely different environment variables.
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();

    probe.once('error', reject);
    probe.listen(0, () => {
      const address = probe.address();

      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('could not reserve a port')));

        return;
      }

      probe.close(() => resolve(address.port));
    });
  });

export interface Account {
  id: string;
  email: string;
  token: string;
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

// A real OS process, so a test can do to it what production does: SIGKILL it
// mid-handler, or SIGSTOP it to simulate a frozen event loop.
export class ProcessHandle {
  private output = '';

  constructor(
    readonly name: string,
    private readonly child: ChildProcess,
  ) {
    child.stdout?.on('data', (chunk) => (this.output += String(chunk)));
    child.stderr?.on('data', (chunk) => (this.output += String(chunk)));
  }

  get log() {
    return this.output;
  }

  get pid() {
    return this.child.pid;
  }

  get exitCode() {
    return this.child.exitCode ?? undefined;
  }

  count(pattern: string | RegExp) {
    const matches = this.output.match(
      typeof pattern === 'string'
        ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
        : new RegExp(pattern, 'g'),
    );

    return matches?.length ?? 0;
  }

  signal(signal: NodeJS.Signals) {
    // Not `child.killed`: that flag only records that some signal was sent, so
    // testing it would suppress the SIGKILL that has to follow a SIGCONT and
    // leave the process running. Every harness used to leak its last-signalled
    // children this way, and the survivors then drained the next file's jobs.
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }

    try {
      this.child.kill(signal);
    } catch {
      // ESRCH — it exited between the check and the signal.
    }
  }

  // Killing is not the same as being gone: the port stays bound and the worker
  // keeps consuming jobs until the kernel has reaped the process.
  terminate(timeoutMs = 10_000) {
    return new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve();

        return;
      }

      const done = setTimeout(resolve, timeoutMs);

      this.child.once('exit', () => {
        clearTimeout(done);
        resolve();
      });

      // A frozen process must be thawed before it can be reaped.
      this.signal('SIGCONT');
      this.signal('SIGKILL');
    });
  }

  sigkill() {
    this.signal('SIGKILL');
  }

  freeze() {
    this.signal('SIGSTOP');
  }

  thaw() {
    this.signal('SIGCONT');
  }
}

export class RelayHarness {
  readonly prisma: PrismaClient;
  readonly redis: Redis;

  readonly baseUrl: string;

  private readonly processes: ProcessHandle[] = [];
  private jobQueue?: Queue;

  private constructor(private readonly port: number) {
    this.baseUrl = `http://localhost:${port}`;
    this.prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    });
    this.redis = new Redis(process.env.REDIS_URL!);
  }

  static async create() {
    const harness = new RelayHarness(await freePort());

    await harness.prisma.$connect();

    return harness;
  }

  // ─── processes ───────────────────────────────────────────────────────────

  private spawnNode(name: string, entry: string, env: NodeJS.ProcessEnv = {}) {
    const child = spawn(process.execPath, [entry], {
      // Vitest sets NODE_ENV=test, and the logger treats that as 'silent'
      // (logger.params.ts). Inheriting it would leave every spawned process
      // mute, so the assertions that read a worker's log would silently see
      // nothing rather than fail.
      env: {
        ...process.env,
        NODE_ENV: 'development',
        LOG_LEVEL: 'info',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const handle = new ProcessHandle(name, child);

    this.processes.push(handle);

    return handle;
  }

  async startApi(env: NodeJS.ProcessEnv = {}) {
    const api = this.spawnNode('api', 'dist/main.js', {
      PORT: String(this.port),
      ...env,
    });

    await this.waitUntil(
      async () => {
        if (api.exitCode !== undefined) {
          throw new Error(
            `the API exited before answering /health:\n${api.log}`,
          );
        }

        const response = await fetch(`${this.baseUrl}/health`).catch(
          () => undefined,
        );

        return response?.ok ? true : undefined;
      },
      { timeoutMs: 30_000, label: 'the API to answer /health' },
    );

    return api;
  }

  startWorker(name = 'worker', env: NodeJS.ProcessEnv = {}) {
    return this.spawnNode(name, 'dist/worker.js', env);
  }

  async stop() {
    // Awaited, not fired and forgotten: a surviving worker would go on
    // consuming jobs belonging to the next test file.
    await Promise.all(this.processes.map((handle) => handle.terminate()));

    await this.jobQueue?.close();
    await this.prisma.$disconnect();
    this.redis.disconnect();
  }

  // ─── waiting ─────────────────────────────────────────────────────────────

  // Tests wait for a condition rather than for a duration. A fixed sleep is
  // what made the first version of A3b measure jobs that were still running.
  async waitUntil<T>(
    probe: () => Promise<T | undefined>,
    {
      timeoutMs = 60_000,
      intervalMs = 200,
      label = 'condition',
    }: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const result = await probe();

      if (result !== undefined) {
        return result;
      }

      if (Date.now() > deadline) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  waitForJobStatus(jobId: string, statuses: JobStatus[], timeoutMs = 60_000) {
    return this.waitUntil(
      async () => {
        const job = await this.job(jobId);

        return job && statuses.includes(job.status) ? job : undefined;
      },
      { timeoutMs, label: `job ${jobId} to reach ${statuses.join(' or ')}` },
    );
  }

  waitForCount(
    userId: string,
    where: Prisma.JobWhereInput,
    expected: number,
    timeoutMs = 60_000,
  ) {
    return this.waitUntil(
      async () =>
        (await this.prisma.job.count({ where: { userId, ...where } })) ===
        expected
          ? true
          : undefined,
      { timeoutMs, label: `${expected} jobs matching ${JSON.stringify(where)}` },
    );
  }

  waitForDrain(userId: string, timeoutMs = 120_000) {
    return this.waitUntil(
      async () =>
        (await this.prisma.job.count({
          where: { userId, status: { in: ['QUEUED', 'RUNNING'] } },
        })) === 0
          ? true
          : undefined,
      { timeoutMs, label: 'every job to reach a terminal state' },
    );
  }

  waitForLog(handle: ProcessHandle, pattern: RegExp, timeoutMs = 30_000) {
    return this.waitUntil(
      async () => (pattern.test(handle.log) ? true : undefined),
      { timeoutMs, label: `${handle.name} to log ${pattern}` },
    );
  }

  // ─── http ────────────────────────────────────────────────────────────────

  async request<T = any>(
    path: string,
    init: RequestInit = {},
  ): Promise<ApiResponse<T>> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers },
    });

    return {
      status: response.status,
      body: (await response.json().catch(() => null)) as T,
    };
  }

  async signUp(label = 'user'): Promise<Account> {
    const email = `${label}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}@example.com`;
    const password = 'password123';

    await this.request('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });

    const { body } = await this.request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { email },
    });

    return { id: user.id, email, token: body.data.accessToken };
  }

  submit(
    account: Account,
    payload: Record<string, unknown>,
    idempotencyKey = `k-${Math.random().toString(36).slice(2)}`,
  ) {
    return this.request('/jobs', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${account.token}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
    });
  }

  fetchJob(account: Account, jobId: string) {
    return this.request(`/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${account.token}` },
    });
  }

  redrive(account: Account, jobId: string) {
    return this.request(`/jobs/${jobId}/retry`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${account.token}` },
    });
  }

  // ─── state ───────────────────────────────────────────────────────────────

  job(jobId: string): Promise<Job | null> {
    return this.prisma.job.findUnique({ where: { id: jobId } });
  }

  jobs(userId: string) {
    return this.prisma.job.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
  }

  countByStatus(userId: string, status: JobStatus) {
    return this.prisma.job.count({ where: { userId, status } });
  }

  sideEffects(userId: string) {
    return this.prisma.sideEffect.findMany({ where: { job: { userId } } });
  }

  outbox(jobId: string) {
    return this.prisma.outbox.findMany({
      where: { jobId },
      orderBy: { id: 'asc' },
    });
  }

  // ─── queue ───────────────────────────────────────────────────────────────

  // The queue entry is keyed by the Outbox row, not the job (§7.5a), so a test
  // that wants Redis state has to resolve the row first.
  private async latestMessageId(jobId: string) {
    const [row] = await this.prisma.outbox.findMany({
      where: { jobId },
      orderBy: { id: 'desc' },
      take: 1,
    });

    return row ? messageId(jobId, row.id) : undefined;
  }

  async queueEntry(jobId: string) {
    const id = await this.latestMessageId(jobId);

    if (!id) {
      return undefined;
    }

    const hash = await this.redis.hgetall(`${QUEUE_PREFIX}:${id}`);

    return Object.keys(hash).length > 0 ? hash : undefined;
  }

  // A4 needs a delivery of a job that is already terminal. A fresh queue entry
  // for the same job id is what a duplicate delivery looks like to the worker.
  async redeliver(jobId: string) {
    const job = await this.prisma.job.findUniqueOrThrow({ where: { id: jobId } });

    this.jobQueue ??= new Queue(JOBS_QUEUE, {
      connection: { url: process.env.REDIS_URL },
    });

    return this.jobQueue.add(
      job.type,
      { jobId, correlationId: job.correlationId },
      { jobId: `${jobId}.redeliver-${Date.now()}`, attempts: 1 },
    );
  }

  async expireQueueLock(jobId: string) {
    const id = await this.latestMessageId(jobId);

    if (id) {
      await this.redis.del(`${QUEUE_PREFIX}:${id}:lock`);
    }
  }
}
