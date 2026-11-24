import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { ApiKeyScope } from '../generated/prisma/enums.js';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator.js';
import { bearerToken } from '../auth/bearer-token.js';
import {
  ApiKeyNotAllowedError,
  ApiKeyScopeMissingError,
} from '../common/errors/app-error.js';
import { ALLOWS_API_KEYS } from './allow-api-keys.decorator.js';
import { isApiKey } from './api-key-secret.js';
import { ApiKeysService } from './api-keys.service.js';

// The methods that only read: a `read` key may make these and nothing else.
const READS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/**
 * Lets in a request that carries an API key (§6.3f), beside `JwtAuthGuard`,
 * which lets in one that carries a login token: each passes a request bearing
 * the other's credential, so either satisfies a route that takes both. Sets
 * the key's owner as the request's user, as a login would.
 *
 * @throws UnauthorizedException (401) for a key no unrevoked key hashes to.
 * @throws ApiKeyNotAllowedError (403) on a route that takes no key.
 * @throws ApiKeyScopeMissingError (403) for a key without the scope the
 * request's method needs.
 * @throws ApiKeysDisabledError (403) while the operator has keys turned off.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext) {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const token = bearerToken(request);

    if (token === undefined || !isApiKey(token)) {
      return true;
    }

    const key = await this.apiKeys.authenticate(token);

    if (!key) {
      throw new UnauthorizedException();
    }

    if (!this.reflector.getAllAndOverride<boolean>(ALLOWS_API_KEYS, targets)) {
      throw new ApiKeyNotAllowedError();
    }

    const needed: ApiKeyScope = READS.has(request.method) ? 'read' : 'write';

    if (!key.scopes.includes(needed)) {
      throw new ApiKeyScopeMissingError(needed);
    }

    request.user = { ...key.user, apiKeyId: key.id };

    return true;
  }
}
