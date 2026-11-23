import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type { Request } from 'express';
import { Req } from '@nestjs/common';
import { minutes } from '@nestjs/throttler';
import type { Job } from '../../generated/prisma/client.js';
import { JobsService } from './jobs.service.js';
import { IdempotencyKey } from './idempotency-key.decorator.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/auth.types.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.js';
import {
  bulkRedriveSchema,
  jobIdSchema,
  listDeadLettersSchema,
  listJobsSchema,
  redriveQuerySchema,
  submitJobSchema,
  type BulkRedriveInput,
  type ListDeadLettersQuery,
  type ListJobsQuery,
  type RedriveQuery,
  type SubmitJobInput,
} from '../jobs.schema.js';

// The fingerprint is how the API recognises a retry (D28), the lease is how
// workers recognise each other (D7), the checkpoint is where a handler resumes
// (D26), and the pipeline flag is how its counter counts each job once (D24);
// none is part of the job a client sees, and a field in a response is a field
// clients come to rely on.
const toJobView = ({
  requestHash: _requestHash,
  lease: _lease,
  checkpoint: _checkpoint,
  pendingInPipeline: _pendingInPipeline,
  tokensIn,
  tokensOut,
  estimatedCostUsd,
  ...job
}: Job) => ({
  ...job,
  // A number, not the Decimal's string: a millionth of a dollar is well
  // within what a double holds exactly enough.
  modelUsage: {
    tokensIn,
    tokensOut,
    estimatedCostUsd: estimatedCostUsd.toNumber(),
  },
});

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  // Each accepted job is work for the worker; many images go in one
  // image.process batch, not one submit each.
  @RateLimit(60, minutes(1))
  @Post()
  @HttpCode(202)
  async submit(
    @CurrentUser() user: AuthenticatedUser,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: submitJobSchema }) input: SubmitJobInput,
    @Req() request: Request,
  ) {
    const { job, replayed } = await this.jobs.submit({
      userId: user.id,
      idempotencyKey,
      correlationId: String(request.id),
      input,
    });

    return { ...toJobView(job), replayed };
  }

  // Each call can send up to 1000 dead letters back to work. Working through
  // an outage is a loop of calls, and ten a minute is ten thousand jobs.
  @RateLimit(10, minutes(1))
  @Post('retry')
  @HttpCode(202)
  redriveMatching(
    @CurrentUser() user: AuthenticatedUser,
    @Body({ schema: bulkRedriveSchema }) filter: BulkRedriveInput,
    @Req() request: Request,
  ) {
    return this.jobs.redriveMatching(user.id, filter, String(request.id));
  }

  // Each re-drive runs a job again, as a submit does.
  @RateLimit(60, minutes(1))
  @Post(':id/retry')
  @HttpCode(202)
  async redrive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', { schema: jobIdSchema }) id: string,
    @Query({ schema: redriveQuerySchema }) { from }: RedriveQuery,
    @Req() request: Request,
  ) {
    return toJobView(
      await this.jobs.redrive(user.id, id, String(request.id), {
        fromStart: from === 'start',
      }),
    );
  }

  @Post(':id/cancel')
  @HttpCode(202)
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', { schema: jobIdSchema }) id: string,
  ) {
    return toJobView(await this.jobs.cancel(user.id, id));
  }

  // Declared before ':id', which would otherwise take 'dead-letters' for a job
  // id and refuse it as one.
  @Get('dead-letters')
  async findDeadLetters(
    @CurrentUser() user: AuthenticatedUser,
    @Query({ schema: listDeadLettersSchema }) query: ListDeadLettersQuery,
  ) {
    const page = await this.jobs.findDeadLetters(user.id, query);

    return { ...page, items: page.items.map(toJobView) };
  }

  @Get(':id')
  async findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', { schema: jobIdSchema }) id: string,
  ) {
    return toJobView(await this.jobs.findOne(user.id, id));
  }

  @Get(':id/error-report')
  errorReport(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', { schema: jobIdSchema }) id: string,
  ) {
    return this.jobs.errorReportLink(user.id, id);
  }

  @Get()
  async findMany(
    @CurrentUser() user: AuthenticatedUser,
    @Query({ schema: listJobsSchema }) query: ListJobsQuery,
  ) {
    const page = await this.jobs.findMany(user.id, query);

    return { ...page, items: page.items.map(toJobView) };
  }
}
