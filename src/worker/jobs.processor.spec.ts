import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { UnrecoverableError, type Job as QueueJob } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalJobError } from '../common/errors/app-error.js';
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

// The dead letter a handler's failure becomes: what the processor asked the
// transition to write.
const deadLetterFor = async (failure: Error) => {
  const errors: Prisma.InputJsonValue[] = [];

  const transitions = {
    cancelBeforeClaim: async () => null,
    claim: async () => claimed,
    deadLetter: async (
      _jobId: string,
      _lease: number,
      error: Prisma.InputJsonValue,
    ) => {
      errors.push(error);

      return claimed;
    },
  } as unknown as JobTransitionService;

  const processor = new JobsProcessor(
    transitions,
    {
      run: async () => {
        throw failure;
      },
    } as unknown as JobHandlerRegistry,
    {
      create: () => ({ flush: async () => {} }),
    } as unknown as JobContextFactory,
    { jobUpdated: async () => {} } as unknown as JobEventsPublisher,
    {} as ConfigService<WorkerEnv, true>,
  );

  await expect(
    processor.process({
      data: { jobId: 'a-job', correlationId: 'req-1' },
    } as QueueJob<JobMessage>),
  ).rejects.toBeInstanceOf(UnrecoverableError);

  return errors;
};

describe('JobsProcessor', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
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
});
