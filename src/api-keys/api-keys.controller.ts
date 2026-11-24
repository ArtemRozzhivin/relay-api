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

@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

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

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.apiKeys.list(user.id);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', { schema: apiKeyIdSchema }) id: string,
  ) {
    return this.apiKeys.revoke(user.id, id);
  }
}
