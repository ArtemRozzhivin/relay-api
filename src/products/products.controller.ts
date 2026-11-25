import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { ProductsService } from './products.service.js';
import {
  listProductsSchema,
  type ListProductsQuery,
} from './products.schema.js';
import { AllowApiKeys } from '../api-keys/allow-api-keys.decorator.js';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HttpStatus } from '@nestjs/common';
import { ApiData } from '../docs/openapi-schemas.js';
import { productPage } from './products.responses.js';

@ApiTags('Products')
@AllowApiKeys()
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @ApiOperation({ summary: "The account's catalog, by sku" })
  @ApiData(HttpStatus.OK, productPage, 'A page of products')
  @Get()
  findMany(
    @CurrentUser() user: AuthenticatedUser,
    @Query({ schema: listProductsSchema }) query: ListProductsQuery,
  ) {
    return this.products.findMany(user.id, query);
  }
}
