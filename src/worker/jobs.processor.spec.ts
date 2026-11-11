import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { UnrecoverableError, type Job as QueueJob } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RetryableJobError,
  TerminalJobError,
} from '../common/errors/app-error.js';
import type { Job, Prisma } from '../generated/prisma/client.js';
import type { JobContextFactory } from '../jobs/job-context.factory.js';
import type { JobEventsPublisher } from '../jobs/job-events.publisher.js';
import type { JobHandlerRegistry } from '../jobs/job-handler.registry.js';
import type { JobMessage } from '../jobs/job-queue.js';
import type { JobTransitionService } from '../jobs/job-transition.service.js';
import type { WorkerEnv } from '../config/env.schema.js';
import { JobsProcessor } from './jobs.processor.js';

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

// A processor whose handler throws `failure` on the attempt given, with every
// error the processor asked a transition to write collected in `errors`, and
// what it built each handler's context from in `contexts`.
const failingOn = (attempt: number, failure: unknown) => {
  const errors: Prisma.InputJsonValue[] = [];
  const contexts: { lastAttempt?: boolean }[] = [];
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
    } as unknown as JobTransitionService,
    {
      run: async () => {
        throw failure;
      },
    } as unknown as JobHandlerRegistry,
    {
      create: (job: { lastAttempt?: boolean }) => {
        contexts.push(job);

        return { flush: async () => {} };
      },
    } as unknown as JobContextFactory,
    { jobUpdated: async () => {} } as unknown as JobEventsPublisher,
    { get: () => false } as unknown as ConfigService<WorkerEnv, true>,
  );

  return { processor, errors, contexts };
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
      const { processor, errors } = failingOn(1, null);

      processor.onFailed(
        { ...message, finishedOn: Date.now() } as QueueJob<JobMessage>,
        failure,
      );

      await vi.waitFor(() =>
        expect(errors).toEqual([
          { code: 'DELIVERY_ABANDONED', message: shown },
        ]),
      );
    });
  });
});
