import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import type { AccessTokenPayload } from '../auth.types.js';
import { bearerToken } from '../bearer-token.js';
import { isApiKey } from '../../api-keys/api-key-secret.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = bearerToken(request);

    if (!token) {
      throw new UnauthorizedException();
    }

    // An API key: ApiKeyGuard, which runs next, lets it in or refuses it.
    if (isApiKey(token)) {
      return true;
    }

    try {
      const payload =
        await this.jwtService.verifyAsync<AccessTokenPayload>(token);

      request.user = {
        id: payload.sub,
        email: payload.email,
        role: payload.role,
      };
    } catch {
      throw new UnauthorizedException();
    }

    return true;
  }
}
