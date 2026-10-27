import { Injectable } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaService } from '../../prisma/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { JobHandler } from '../job-handler.js';
import type { JobContext } from '../job-context.js';
import { chargePayloadSchema, type PayloadOf } from '../jobs.schema.js';

@Injectable()
export class ChargeJobHandler extends JobHandler<PayloadOf<'CHARGE'>> {
  readonly type = 'CHARGE' as const;

  protected readonly payloadSchema = chargePayloadSchema;

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  protected async execute(context: JobContext, payload: PayloadOf<'CHARGE'>) {
    // Keyed on the job id, not on the client's idempotency key: a redelivery
    // of this job has to find the same row, while two different jobs must
    // never collide — and `effectKey` is unique across all tenants, so a
    // tenant-scoped key here would let one tenant suppress another's charge.
    const effectKey = `${context.jobId}:charge`;

    try {
      await this.prisma.sideEffect.create({
        data: {
          effectKey,
          jobId: context.jobId,
          kind: 'charge',
          detail: {
            amountCents: payload.amountCents,
            reference: payload.reference,
          },
        },
      });
    } catch (error) {
      // The unique index is the guard, not a SELECT before the insert: a
      // concurrent redelivery would pass that read and charge twice. Losing
      // the insert proves the charge already happened, so report success
      // without performing it again.
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
