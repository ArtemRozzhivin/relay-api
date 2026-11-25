import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';

export const ALLOWS_API_KEYS = 'allowsApiKeys';

/**
 * Lets an API key reach the controller's routes, `read` for a `GET` and
 * `write` for the rest (§6.3f). Without it a route answers a key with 403:
 * what a seller's script does is the seller's jobs, pipelines, uploads and
 * products, and nothing about the account or its keys.
 *
 * Also what the API's reference says of the routes, so it cannot tell a
 * client a key works where the guard refuses one.
 */
export const AllowApiKeys = () =>
  applyDecorators(
    SetMetadata(ALLOWS_API_KEYS, true),
    ApiBearerAuth('session'),
    ApiBearerAuth('apiKey'),
  );
