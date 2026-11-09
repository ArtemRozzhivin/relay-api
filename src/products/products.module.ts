import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller.js';
import { ProductsService } from './products.service.js';
import { StorageModule } from '../storage/storage.module.js';

// Holds no queue and no processor, so the worker can import it for the import
// handler and the API for the product list (§3). The worker builds an
// application context with no HTTP server, so the controller serves nothing
// there.
@Module({
  imports: [StorageModule],
  controllers: [ProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
