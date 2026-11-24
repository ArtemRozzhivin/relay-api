import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { minutes } from '@nestjs/throttler';
import { Role } from '../generated/prisma/enums.js';
import { ApiKeysService } from './api-keys.service.js';
import {
  listAllApiKeysSchema,
  revokeMatchingSchema,
  type ListAllApiKeysQuery,
  type RevokeMatchingInput,
} from './api-keys.schema.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { RateLimit } from '../common/rate-limit/rate-limit.js';

// The operator's, not a seller's: keys across accounts (§6.3f).
@Roles([Role.ADMIN])
@Controller('admin/api-keys')
export class AdminApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Get()
  findAll(@Query({ schema: listAllApiKeysSchema }) query: ListAllApiKeysQuery) {
    return this.apiKeys.findAll(query);
  }

  @RateLimit(10, minutes(1))
  @Post('revoke')
  @HttpCode(200)
  revokeMatching(
    @CurrentUser() admin: AuthenticatedUser,
    @Body({ schema: revokeMatchingSchema }) input: RevokeMatchingInput,
  ) {
    return this.apiKeys.revokeMatching(admin.id, input);
  }
}
