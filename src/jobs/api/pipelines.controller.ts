import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { minutes } from '@nestjs/throttler';
import { PipelinesService } from './pipelines.service.js';
import { IdempotencyKey } from './idempotency-key.decorator.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/auth.types.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.js';
import {
  pipelineIdSchema,
  startPipelineSchema,
  type StartPipelineInput,
} from '../jobs.schema.js';
import { AllowApiKeys } from '../../api-keys/allow-api-keys.decorator.js';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HttpStatus } from '@nestjs/common';
import { ApiData, ApiIdempotencyKey } from '../../docs/openapi-schemas.js';
import { pipelineView, startedPipelineView } from '../jobs.responses.js';

@ApiTags('Pipelines')
@AllowApiKeys()
@Controller('pipelines')
export class PipelinesController {
  constructor(private readonly pipelines: PipelinesService) {}

  @ApiOperation({
    summary: 'Import a CSV, then enrich and image what it imported',
  })
  @ApiIdempotencyKey()
  @ApiData(
    HttpStatus.ACCEPTED,
    startedPipelineView,
    'The pipeline, with its import queued',
  )
  // A pipeline is an import and every batch it fans out into. The import cap
  // bounds the work in flight (D32); this bounds the requests, as for a submit.
  @RateLimit(60, minutes(1))
  @Post()
  @HttpCode(202)
  async start(
    @CurrentUser() user: AuthenticatedUser,
    @IdempotencyKey() idempotencyKey: string,
    @Body({ schema: startPipelineSchema }) input: StartPipelineInput,
    @Req() request: Request,
  ) {
    const { pipeline, replayed } = await this.pipelines.start({
      userId: user.id,
      idempotencyKey,
      correlationId: String(request.id),
      input,
    });

    return { ...pipeline, replayed };
  }

  @ApiOperation({
    summary: 'How a pipeline is going, and its summary once done',
  })
  @ApiData(HttpStatus.OK, pipelineView, 'The pipeline')
  @Get(':id')
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', { schema: pipelineIdSchema }) id: string,
  ) {
    return this.pipelines.findOne(user.id, id);
  }
}
