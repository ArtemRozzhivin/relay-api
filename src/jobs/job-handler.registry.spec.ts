import { describe, expect, it } from 'vitest';
import { TerminalJobError } from '../common/errors/app-error.js';
import type { Job } from '../generated/prisma/client.js';
import type { RunnableJobHandler } from './job-handler.js';
import { JobHandlerRegistry } from './job-handler.registry.js';
import { JOB_TYPES, type JobType } from './jobs.schema.js';
import { recordingContext } from './job-context.fixture.js';

const stub = (type: JobType): RunnableJobHandler => ({
  type,
  run: async () => ({ ran: type }),
});

const jobOfType = (type: string) =>
  ({ id: 'a-job', type, payload: {} }) as unknown as Job;

describe('JobHandlerRegistry', () => {
  it('accepts a handler for every submittable type', () => {
    expect(
      () => new JobHandlerRegistry(JOB_TYPES.map((type) => stub(type))),
    ).not.toThrow();
  });

  it('refuses to start when a submittable type has no handler', () => {
    expect(() => new JobHandlerRegistry([stub('MOCK')])).toThrow(/CHARGE/);
  });

  it('refuses to start when two handlers claim the same type', () => {
    expect(
      () =>
        new JobHandlerRegistry([stub('MOCK'), stub('MOCK'), stub('CHARGE')]),
    ).toThrow(/same job type/);
  });

  it('dead-letters a type no handler serves', async () => {
    const registry = new JobHandlerRegistry(
      JOB_TYPES.map((type) => stub(type)),
    );

    await expect(
      registry.run(jobOfType('RETIRED'), recordingContext().context),
    ).rejects.toBeInstanceOf(TerminalJobError);
  });
});
