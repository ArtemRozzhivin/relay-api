import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { TerminalJobError } from '../../../common/errors/app-error.js';
import { JobHandler } from '../../engine/job-handler.js';
import type { JobContext } from '../../engine/job-context.js';
import { pipelineKey } from '../../engine/pipeline-keys.js';
import {
  pipelineFinalizePayloadSchema,
  type PayloadOf,
} from '../../jobs.schema.js';
import { finalStatus, summarize } from './pipeline-summary.js';

@Injectable()
export class PipelineFinalizeJobHandler extends JobHandler<
  PayloadOf<'pipeline.finalize'>
> {
  readonly type = 'pipeline.finalize' as const;

  protected readonly payloadSchema = pipelineFinalizePayloadSchema;

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  protected async execute(
    context: JobContext,
    { pipelineId }: PayloadOf<'pipeline.finalize'>,
  ) {
    // Scoped to the job's owner, like every read a handler makes.
    const pipeline = await this.prisma.pipeline.findFirst({
      where: { id: pipelineId, userId: context.userId },
    });

    if (!pipeline) {
      throw new TerminalJobError(`Pipeline ${pipelineId} does not exist`);
    }

    const jobs = await this.prisma.job.findMany({
      where: { pipelineId, type: { not: this.type } },
      select: { idempotencyKey: true, type: true, status: true, result: true },
    });

    const importKey = pipelineKey(pipelineId, 'import');
    const importJob = jobs.find((job) => job.idempotencyKey === importKey);

    const status = finalStatus(
      importJob?.status === 'SUCCEEDED',
      pipeline.failedChildren,
    );
    const summary = summarize(importJob, jobs);

    // Once: a second delivery of this job, or a retry after a crash past this
    // write, finds the pipeline finished and leaves it as the first one wrote.
    const [finished] = await this.prisma.pipeline.updateManyAndReturn({
      where: { id: pipelineId, status: 'RUNNING' },
      data: { status, summary, finishedAt: new Date() },
    });

    if (!finished) {
      context.log('found its pipeline already finished; changed nothing');

      return { pipelineId, status: pipeline.status, summary: pipeline.summary };
    }

    return { pipelineId, status, summary };
  }
}
