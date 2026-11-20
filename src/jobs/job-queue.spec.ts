import { describe, expect, it } from 'vitest';
import { AI_QUEUE, JOBS_QUEUE, queueFor } from './job-queue.js';
import { JOB_TYPES } from './jobs.schema.js';

describe('queueFor', () => {
  it('sends ai.enrich to the AI queue and every other type to relay-jobs', () => {
    expect(
      Object.fromEntries(JOB_TYPES.map((type) => [type, queueFor(type)])),
    ).toEqual({
      MOCK: JOBS_QUEUE,
      CHARGE: JOBS_QUEUE,
      'import.csv': JOBS_QUEUE,
      'image.process': JOBS_QUEUE,
      'ai.enrich': AI_QUEUE,
    });
  });
});
