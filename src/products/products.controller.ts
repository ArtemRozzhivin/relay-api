import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { ProductsService } from './products.service.js';
import {
  listProductsSchema,
  type ListProductsQuery,
} from './products.schema.js';

@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  findMany(
    @CurrentUser() user: AuthenticatedUser,
    @Query({ schema: listProductsSchema }) query: ListProductsQuery,
  ) {
    return this.products.findMany(user.id, query);
  }
}
