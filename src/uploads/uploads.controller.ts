import { Controller, HttpCode, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { UploadsService } from './uploads.service.js';

@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  // 200, not 201: nothing exists yet. The object appears only once the client
  // has sent the file to S3, and nothing on this side records the request.
  @Post()
  @HttpCode(200)
  create(@CurrentUser() user: AuthenticatedUser) {
    return this.uploads.createUpload(user.id);
  }
}
