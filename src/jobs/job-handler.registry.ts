import { Injectable } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { Job } from '../generated/prisma/client.js';
import type { SubmitJobInput } from './jobs.schema.js';

type PayloadOf<T extends SubmitJobInput['type']> = Extract<
  SubmitJobInput,
  { type: T }
>['payload'];

@Injectable()
export class JobHandlerRegistry {
  constructor(private readonly prisma: PrismaService) {}

  run(job: Job): Promise<Prisma.InputJsonValue> {
    switch (job.type) {
      case 'MOCK':
        return this.mock(job);
      case 'CHARGE':
        return this.charge(job);
    }
  }

  private async mock(job: Job) {
    const payload = job.payload as PayloadOf<'MOCK'>;

    await sleep(payload.durationMs);

    if (Math.random() < payload.failureRate) {
      throw new Error('Mock job failed on purpose');
    }

    return { sleptMs: payload.durationMs };
  }

  private async charge(job: Job) {
    const payload = job.payload as PayloadOf<'CHARGE'>;

    const effectKey = `${job.id}:charge`;

    try {
      await this.prisma.sideEffect.create({
        data: {
          effectKey,
          jobId: job.id,
          kind: 'charge',
          detail: {
            amountCents: payload.amountCents,
            reference: payload.reference,
          },
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return {
          charged: payload.amountCents,
          reference: payload.reference,
          deduplicated: true,
        };
      }

      throw error;
    }

    await sleep(payload.delayMs);

    return { charged: payload.amountCents, reference: payload.reference };
  }
}
