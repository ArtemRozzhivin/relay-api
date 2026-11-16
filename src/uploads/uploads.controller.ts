import { Controller, HttpCode, Post } from '@nestjs/common';
import { minutes } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { UploadsService } from './uploads.service.js';
import { RateLimit } from '../common/rate-limit/rate-limit.js';

@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  // Each slip lets its holder store up to 50 MB.
  @RateLimit(10, minutes(1))
  // 200, not 201: nothing exists yet. The object appears only once the client
  // has sent the file to S3, and nothing on this side records the request.
  @Post()
  @HttpCode(200)
  create(@CurrentUser() user: AuthenticatedUser) {
    return this.uploads.createUpload(user.id);
  }
}
