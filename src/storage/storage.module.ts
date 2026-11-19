import { Module } from '@nestjs/common';
import { StorageService } from './storage.service.js';

// Holds no queue and no processor, so either root may import it (§3).
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
