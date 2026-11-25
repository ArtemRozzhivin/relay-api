import { Module } from '@nestjs/common';
import { ApiKeysController } from './api-keys.controller.js';
import { AdminApiKeysController } from './admin-api-keys.controller.js';
import { ApiKeysService } from './api-keys.service.js';

@Module({
  controllers: [ApiKeysController, AdminApiKeysController],
  providers: [ApiKeysService],
  exports: [ApiKeysService],
})
export class ApiKeysModule {}
