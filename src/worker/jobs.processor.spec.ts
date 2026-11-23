import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  RateLimitError,
  UnrecoverableError,
  type Job as QueueJob,
  type Worker,
} from 'bullmq';
import { type Histogram, Registry } from '@prometheus-io/client';
import type { PinoLogger, RunInContextOptions } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RetryableJobError,
  TerminalJobError,
} from '../common/errors/app-error.js';
import type { Job, Prisma } from '../generated/prisma/client.js';
import type { JobContextFactory } from '../jobs/engine/job-context.factory.js';
import type { JobEventsPublisher } from '../jobs/events/job-events.publisher.js';
import type { JobHandlerRegistry } from '../jobs/engine/job-handler.registry.js';
import { JOBS_QUEUE, type JobMessage } from '../jobs/delivery/job-queue.js';
import type { JobQueues } from '../jobs/delivery/job-queues.js';
import type { JobTransitionService } from '../jobs/engine/job-transition.service.js';
import type { WorkerEnv } from '../config/env.schema.js';
import {
  JobCancelledError,
  JobRateLimitedError,
} from '../jobs/engine/job-handler.js';
import { JobsProcessor } from './jobs.processor.js';
import { JobMetrics, type AttemptOutcome } from './job-metrics.js';

const claimed = {
  id: 'a-job',
  userId: 'a-user',
  type: 'import.csv',
  attempts: 1,
  lease: 1,
  maxAttempts: 5,
  progress: null,
  checkpoint: null,
} as unknown as Job;

const message = {
  data: { jobId: 'a-job', correlationId: 'req-1' },
} as QueueJob<JobMessage>;

// What Prisma says when it fails: a table, a column, the statement.
const prismaFailure = new Error(
  'Invalid `prisma.product.upsert()` invocation: relation "Product" does not exist',
);

const hidden =
  "Internal error; the worker's log has it under correlationId req-1";

// A processor whose handler runs `run` on the attempt given, with every error
// the processor asked a transition to write collected in `errors`, what it
// built each handler's context from in `contexts`, the fields of each log
// context it opened in `logContexts`, every pause it put on its queue in
// `pauses`, and its metrics in `registry`. `transitions` replaces any of the
// transitions' answers; `limited` gives its queue a limiter.
const processorFor = ({
  attempt = 1,
  run,
  transitions = {},
  limited = false,
}: {
  attempt?: number;
  run: () => Promise<unknown>;
  transitions?: Partial<Record<keyof JobTransitionService, unknown>>;
  limited?: boolean;
}) => {
  const errors: Prisma.InputJsonValue[] = [];
  const pauses: number[] = [];
  const contexts: { lastAttempt?: boolean }[] = [];
  const logContexts: Record<string, unknown>[] = [];
  const registry = new Registry();
  const write = async (
    _jobId: string,
    _lease: number,
    error: Prisma.InputJsonValue,
  ) => {
    errors.push(error);

    return claimed;
  };

  const processor = new JobsProcessor(
    {
      cancelBeforeClaim: async () => null,
      claim: async () => ({ ...claimed, attempts: attempt }),
      deadLetter: write,
      requeueForRetry: write,
      abandon: async (_jobId: string, error: Prisma.InputJsonValue) => {
        errors.push(error);

        return claimed;
      },
      ...transitions,
    } as unknown as JobTransitionService,
    { run } as unknown as JobHandlerRegistry,
    {
      create: (job: { lastAttempt?: boolean }) => {
        contexts.push(job);

        return { flush: async () => {} };
      },
    } as unknown as JobContextFactory,
    { jobUpdated: async () => {} } as unknown as JobEventsPublisher,
    { get: () => false } as unknown as ConfigService<WorkerEnv, true>,
    new JobMetrics(registry),
    {
      runInContext: (fn: () => unknown, options: RunInContextOptions = {}) => {
        logContexts.push({ ...options.bindings });

        return fn();
      },
      assign: (fields: Record<string, unknown>) =>
        Object.assign(logContexts.at(-1)!, fields),
    } as unknown as PinoLogger,
    {
      named: (name: string) =>
        name === JOBS_QUEUE
          ? {
              getJob: async () => message,
              rateLimit: async (ms: number) => {
                pauses.push(ms);
              },
            }
          : undefined,
    } as unknown as JobQueues,
  );

  // The worker @nestjs/bullmq attaches at start-up, as much of it as the
  // processor reads.
  vi.spyOn(processor, 'worker', 'get').mockReturnValue({
    name: JOBS_QUEUE,
    opts: limited ? { limiter: { max: 20, duration: 60_000 } } : {},
  } as Worker);

  return { processor, errors, contexts, logContexts, pauses, registry };
};

// A processor whose handler throws `failure` on the attempt given.
const failingOn = (attempt: number, failure: unknown) =>
  processorFor({
    attempt,
    run: async () => {
      throw failure;
    },
  });

// Every attempt the registry timed, as `[labels, how many]`.
const attemptsIn = async (registry: Registry) => {
  const histogram = registry.getSingleMetric(
    'relay_job_attempt_duration_seconds',
  ) as Histogram<'type' | 'outcome'>;
  const { values } = await histogram.get();

  return values
    .filter(
      ({ metricName }) =>
        metricName === 'relay_job_attempt_duration_seconds_count',
    )
    .map(({ labels, value }) => [labels, value]);
};

// The dead letter a handler's failure becomes: what the processor asked the
// transition to write.
const deadLetterFor = async (failure: Error) => {
  const { processor, errors } = failingOn(1, failure);

  await expect(processor.process(message)).rejects.toBeInstanceOf(
    UnrecoverableError,
  );

  return errors;
};

describe('JobsProcessor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  // Whoever logs while the job runs, so a search for the correlationId finds
  // every line, the handler's included.
  it('logs a run under its correlationId and id, with its type and attempt once claimed', async () => {
    const { processor, logContexts } = processorFor({
      attempt: 2,
      run: async () => ({}),
      transitions: { succeed: async () => claimed },
    });

    await processor.process(message);

    expect(logContexts).toEqual([
      {
        correlationId: 'req-1',
        jobId: 'a-job',
        jobType: 'import.csv',
        attempt: 2,
      },
    ]);
  });

  it('logs a delivery it cannot claim under its correlationId and id', async () => {
    const { processor, logContexts } = processorFor({
      run: async () => ({}),
      transitions: { claim: async () => null },
    });

    await processor.process(message);

    expect(logContexts).toEqual([{ correlationId: 'req-1', jobId: 'a-job' }]);
  });

  // A bare listener, given only the queue entry's id.
  it('logs a stall under its correlationId and id', async () => {
    const { processor, logContexts } = processorFor({ run: async () => ({}) });

    await processor.onStalled('a-job.1');

    expect(logContexts).toEqual([{ correlationId: 'req-1', jobId: 'a-job' }]);
  });

  it("stores a terminal failure's reason beside the engine's code", async () => {
    expect(
      await deadLetterFor(
        new TerminalJobError(
          '60 of 100 rows are invalid',
          'IMPORT_MOSTLY_INVALID',
        ),
      ),
    ).toEqual([
      {
        code: 'TERMINAL_FAILURE',
        reason: 'IMPORT_MOSTLY_INVALID',
        message: '60 of 100 rows are invalid',
        attempt: 1,
      },
    ]);
  });

  it('stores no reason for a terminal failure that names none', async () => {
    expect(
      await deadLetterFor(new TerminalJobError('The file no longer exists')),
    ).toEqual([
      {
        code: 'TERMINAL_FAILURE',
        message: 'The file no longer exists',
        attempt: 1,
      },
    ]);
  });

  // The handler gives up on what it would leave for a retry by this answer, and
  // the processor dead-letters by it: the two must never disagree.
  it.each([
    [4, false, 'ATTEMPT_FAILED'],
    [5, true, 'ATTEMPTS_EXHAUSTED'],
  ])(
    'tells the handler whether attempt %i of 5 is the last',
    async (attempt, last, code) => {
      const { processor, errors, contexts } = failingOn(attempt, prismaFailure);

      await processor.process(message).catch(() => undefined);

      expect(contexts).toEqual([
        expect.objectContaining({ lastAttempt: last }),
      ]);
      expect(errors).toEqual([expect.objectContaining({ code })]);
    },
  );

  describe("never shows a job's owner a message not written for them", () => {
    it('hides a failure that will be retried, and logs it', async () => {
      const { processor, errors } = failingOn(1, prismaFailure);

      await expect(processor.process(message)).rejects.toBe(prismaFailure);

      expect(errors).toEqual([
        { code: 'ATTEMPT_FAILED', message: hidden, attempt: 1 },
      ]);
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.stringContaining('relation "Product" does not exist'),
      );
    });

    it('hides the failure that spends the last attempt', async () => {
      const { processor, errors } = failingOn(
        claimed.maxAttempts,
        prismaFailure,
      );

      await expect(processor.process(message)).rejects.toBeInstanceOf(
        UnrecoverableError,
      );

      expect(errors).toEqual([
        { code: 'ATTEMPTS_EXHAUSTED', message: hidden, attempt: 5 },
      ]);
    });

    it("keeps a retryable failure's own message", async () => {
      const failure = new RetryableJobError(
        '2 of 5 images could not be downloaded this time (Timed out)',
      );
      const { processor, errors } = failingOn(1, failure);

      await expect(processor.process(message)).rejects.toBe(failure);

      expect(errors).toEqual([
        { code: 'ATTEMPT_FAILED', message: failure.message, attempt: 1 },
      ]);
    });

    // The failed event: the queue gave up, outside any attempt's catch.
    it.each([
      [
        'what process() threw before its catch',
        new Error('connect ECONNREFUSED 10.0.3.7:5432'),
        hidden,
      ],
      [
        "BullMQ's own word for a stall past the limit",
        new UnrecoverableError('job stalled more than allowable limit'),
        'job stalled more than allowable limit',
      ],
    ])('abandons a job with %s', async (_label, failure, shown) => {
      const { processor, errors, logContexts } = failingOn(1, null);

      processor.onFailed(
        { ...message, finishedOn: Date.now() } as QueueJob<JobMessage>,
        failure,
      );

      await vi.waitFor(() =>
        expect(errors).toEqual([
          { code: 'DELIVERY_ABANDONED', message: shown },
        ]),
      );
      // Outside process(), where no context is open unless it opens one.
      expect(logContexts).toEqual([{ correlationId: 'req-1', jobId: 'a-job' }]);
    });
  });

  describe('a service the job calls is busy', () => {
    const busy = async () => {
      throw new JobRateLimitedError(1500);
    };

    // On the last attempt too: a busy service is no reason to give up.
    it.each([1, claimed.maxAttempts])(
      'pauses the queue for as long as the service asked, and hands attempt %i back uncounted',
      async (attempt) => {
        const release = vi.fn(async () => claimed);
        const { processor, errors, pauses } = processorFor({
          attempt,
          run: busy,
          limited: true,
          transitions: { release },
        });

        await expect(processor.process(message)).rejects.toBeInstanceOf(
          RateLimitError,
        );
        expect(pauses).toEqual([1500]);
        expect(release).toHaveBeenCalledWith('a-job', claimed.lease);
        expect(errors).toEqual([]);
      },
    );

    // Handed back, it would be delivered again and claim the job from the
    // attempt that holds it now.
    it('pauses the queue, and leaves a job another attempt has taken over', async () => {
      const { processor, pauses } = processorFor({
        run: busy,
        limited: true,
        transitions: { release: async () => null },
      });

      await expect(processor.process(message)).resolves.toBeUndefined();
      expect(pauses).toEqual([1500]);
    });

    // BullMQ would hand the job straight back to ask the busy service again.
    it('fails the attempt on a queue with no limiter to pause', async () => {
      const { processor, errors, pauses } = processorFor({
        run: busy,
        transitions: { release: async () => claimed },
      });

      await expect(processor.process(message)).rejects.toBeInstanceOf(
        JobRateLimitedError,
      );
      expect(pauses).toEqual([]);
      expect(errors).toEqual([
        expect.objectContaining({ code: 'ATTEMPT_FAILED' }),
      ]);
    });
  });

  // The histogram's count per outcome is what the failure rate is computed
  // from, so each branch has to land under its own name, once.
  describe('times each attempt under how it ended', () => {
    const succeeds = async () => ({ imported: 3 });
    const fails = async () => {
      throw prismaFailure;
    };

    it.each<[AttemptOutcome, Parameters<typeof processorFor>[0]]>([
      ['succeeded', { run: succeeds }],
      [
        'superseded',
        { run: succeeds, transitions: { succeed: async () => null } },
      ],
      ['retrying', { run: fails }],
      ['dead_lettered', { attempt: claimed.maxAttempts, run: fails }],
      [
        'superseded',
        { run: fails, transitions: { requeueForRetry: async () => null } },
      ],
      [
        'unrecorded',
        {
          run: fails,
          transitions: {
            requeueForRetry: async () => {
              throw new Error('connect ECONNREFUSED 10.0.3.7:5432');
            },
          },
        },
      ],
      [
        'cancelled',
        {
          run: async () => {
            throw new JobCancelledError();
          },
          transitions: { cancel: async () => claimed },
        },
      ],
      [
        'rate_limited',
        {
          run: async () => {
            throw new JobRateLimitedError(1000);
          },
          limited: true,
          transitions: { release: async () => claimed },
        },
      ],
    ])('%s', async (outcome, setup) => {
      const { processor, registry } = processorFor({
        transitions: { succeed: async () => claimed },
        ...setup,
      });

      await processor.process(message).catch(() => undefined);

      expect(await attemptsIn(registry)).toEqual([
        [{ type: 'import.csv', outcome }, 1],
      ]);
    });

    // Not an attempt: no claim, so nothing ran and nothing is timed.
    it('times nothing for a delivery it cannot claim', async () => {
      const { processor, registry } = processorFor({
        run: succeeds,
        transitions: { claim: async () => null },
      });

      await processor.process(message);

      expect(await attemptsIn(registry)).toEqual([]);
    });
  });
});
