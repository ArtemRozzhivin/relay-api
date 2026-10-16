import { setTimeout as sleep } from 'node:timers/promises';
import type { SubmitJobInput } from './jobs.schema.js';

type Payload<T extends SubmitJobInput['type']> = Extract<
  SubmitJobInput,
  { type: T }
>['payload'];

export const jobHandlers = {
  async MOCK(payload: Payload<'MOCK'>) {
    await sleep(payload.durationMs);

    if (Math.random() < payload.failureRate) {
      throw new Error('Mock job failed on purpose');
    }

    return { sleptMs: payload.durationMs };
  },

  async CHARGE(payload: Payload<'CHARGE'>) {
    return {
      charged: payload.amountCents,
      reference: payload.reference,
    };
  },
} satisfies {
  [T in SubmitJobInput['type']]: (payload: Payload<T>) => Promise<unknown>;
};
