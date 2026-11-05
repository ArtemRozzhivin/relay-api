import { Module } from '@nestjs/common';
import { ProductsService } from './products.service.js';

// Holds no queue and no processor, so the worker can import it for the import
// handler and the API for the product list (§3).
@Module({
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
