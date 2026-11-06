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
import type { Job } from '../generated/prisma/client.js';
import { JobsService } from './jobs.service.js';
import { IdempotencyKey } from './idempotency-key.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import {
  bulkRedriveSchema,
  jobIdSchema,
  listJobsSchema,
  redriveQuerySchema,
  submitJobSchema,
  type BulkRedriveInput,
  type ListJobsQuery,
  type RedriveQuery,
  type SubmitJobInput,
} from './jobs.schema.js';

// The fingerprint is how the API recognises a retry (D28), the lease is how
// workers recognise each other (D7), and the checkpoint is where a handler
// resumes (D26); none is part of the job a client sees, and a field in a
// response is a field clients come to rely on.
const toJobView = ({
  requestHash: _requestHash,
  lease: _lease,
  checkpoint: _checkpoint,
  ...job
}: Job) => job;

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

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

  @Post('retry')
  @HttpCode(202)
  redriveMatching(
    @CurrentUser() user: AuthenticatedUser,
    @Body({ schema: bulkRedriveSchema }) filter: BulkRedriveInput,
    @Req() request: Request,
  ) {
    return this.jobs.redriveMatching(user.id, filter, String(request.id));
  }

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

  @Get(':id')
  async findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', { schema: jobIdSchema }) id: string,
  ) {
    return toJobView(await this.jobs.findOne(user.id, id));
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
