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
import { JobsService } from './jobs.service.js';
import { IdempotencyKey } from './idempotency-key.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import {
  jobIdSchema,
  listJobsSchema,
  submitJobSchema,
  type ListJobsQuery,
  type SubmitJobInput,
} from './jobs.schema.js';

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

    return { ...job, replayed };
  }

  @Post(':id/retry')
  @HttpCode(202)
  redrive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', { schema: jobIdSchema }) id: string,
    @Req() request: Request,
  ) {
    return this.jobs.redrive(user.id, id, String(request.id));
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', { schema: jobIdSchema }) id: string,
  ) {
    return this.jobs.findOne(user.id, id);
  }

  @Get()
  findMany(
    @CurrentUser() user: AuthenticatedUser,
    @Query({ schema: listJobsSchema }) query: ListJobsQuery,
  ) {
    return this.jobs.findMany(user.id, query);
  }
}
