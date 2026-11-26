import { Controller, HttpCode, Post } from '@nestjs/common';
import { minutes } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { UploadsService } from './uploads.service.js';
import { RateLimit } from '../common/rate-limit/rate-limit.js';
import { AllowApiKeys } from '../api-keys/allow-api-keys.decorator.js';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HttpStatus } from '@nestjs/common';
import { ApiData } from '../docs/openapi-schemas.js';
import { uploadSlipView } from './uploads.responses.js';

@ApiTags('Uploads')
@AllowApiKeys()
@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @ApiOperation({ summary: 'A slip to send one CSV straight to storage' })
  @ApiData(
    HttpStatus.OK,
    uploadSlipView,
    'POST the file to `url`, with `fields`, starting before `expiresAt` (a minute), then name `key` in an import or a pipeline',
  )
  // Each slip lets its holder store up to 50 MB.
  @RateLimit(10, minutes(1))
  // 200, not 201: nothing exists yet. The object appears only once the client
  // has sent the file to S3; what is recorded here is that a slip was given.
  @Post()
  @HttpCode(200)
  create(@CurrentUser() user: AuthenticatedUser) {
    return this.uploads.createUpload(user.id);
  }
}
