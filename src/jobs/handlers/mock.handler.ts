import { Injectable } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { JobHandler } from '../job-handler.js';
import type { JobContext } from '../job-context.js';
import { mockPayloadSchema, type PayloadOf } from '../jobs.schema.js';

@Injectable()
export class MockJobHandler extends JobHandler<PayloadOf<'MOCK'>> {
  readonly type = 'MOCK' as const;

  protected readonly payloadSchema = mockPayloadSchema;

  protected async execute(context: JobContext, payload: PayloadOf<'MOCK'>) {
    const perStep = Math.floor(payload.durationMs / payload.steps);

    // The remainder is spread over the first steps rather than dropped, so the
    // job really sleeps for the duration it was asked to.
    const longSteps = payload.durationMs % payload.steps;

    // One roll for the whole job, not one per step: `failureRate` is the odds
    // that this job fails, and rolling each step would make ten steps at 0.1
    // almost certain to. It fails just past halfway, so a failed attempt leaves
    // progress behind for the next one to overwrite — except at `steps: 1`,
    // where there is no earlier step to have reported.
    const failAtStep =
      Math.random() < payload.failureRate
        ? Math.floor(payload.steps / 2) + 1
        : 0;

    context.log(
      `sleeping ${payload.durationMs}ms over ${payload.steps} step(s)`,
    );

    for (let step = 1; step <= payload.steps; step += 1) {
      await sleep(perStep + (step <= longSteps ? 1 : 0));

      if (step === failAtStep) {
        throw new Error('Mock job failed on purpose');
      }

      // Deliberately not awaited: reporting without awaiting is part of the
      // contract, and nothing else in the project exercises it. The processor's
      // flush is what makes the final report land before the job is finished.
      void context.reportProgress({ processed: step, total: payload.steps });
    }

    return { sleptMs: payload.durationMs };
  }
}
