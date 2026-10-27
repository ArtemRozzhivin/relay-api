import { Injectable } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { JobHandler } from '../job-handler.js';
import type { JobContext } from '../job-context.js';
import { mockPayloadSchema, type PayloadOf } from '../jobs.schema.js';

@Injectable()
export class MockJobHandler extends JobHandler<PayloadOf<'MOCK'>> {
  readonly type = 'MOCK' as const;

  protected readonly payloadSchema = mockPayloadSchema;

  protected async execute(_context: JobContext, payload: PayloadOf<'MOCK'>) {
    await sleep(payload.durationMs);

    if (Math.random() < payload.failureRate) {
      throw new Error('Mock job failed on purpose');
    }

    return { sleptMs: payload.durationMs };
  }
}
