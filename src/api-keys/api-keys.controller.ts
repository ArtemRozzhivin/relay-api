import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { hours } from '@nestjs/throttler';
import { ApiKeysService } from './api-keys.service.js';
import {
  apiKeyIdSchema,
  createApiKeySchema,
  type CreateApiKeyInput,
} from './api-keys.schema.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { RateLimit } from '../common/rate-limit/rate-limit.js';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { HttpStatus } from '@nestjs/common';
import { z } from 'zod';
import { ApiData } from '../docs/openapi-schemas.js';
import { apiKeyView, createdApiKeyView } from './api-keys.responses.js';

@ApiTags('API keys')
@ApiBearerAuth('session')
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @ApiOperation({ summary: 'Make an API key; its secret is shown once' })
  @ApiData(HttpStatus.CREATED, createdApiKeyView, 'The key, with its secret')
  // A person makes a key per system they connect, a few in a day at most.
  @RateLimit(10, hours(1))
  @Post()
  @HttpCode(201)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body({ schema: createApiKeySchema }) input: CreateApiKeyInput,
  ) {
    return this.apiKeys.create(user.id, input);
  }

  @ApiOperation({ summary: "The account's keys, revoked ones too" })
  @ApiData(HttpStatus.OK, z.array(apiKeyView), 'Newest first')
  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.apiKeys.list(user.id);
  }

  @ApiOperation({ summary: 'Revoke a key, from the next request on' })
  @ApiData(HttpStatus.OK, apiKeyView, 'The key, revoked')
  @Post(':id/revoke')
  @HttpCode(200)
  revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', { schema: apiKeyIdSchema }) id: string,
  ) {
    return this.apiKeys.revoke(user.id, id);
  }
}
