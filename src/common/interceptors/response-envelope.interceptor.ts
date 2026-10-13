import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { map, type Observable } from 'rxjs';
import { NO_ENVELOPE_KEY } from '../decorators/no-envelope.decorator.js';

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
  requestId: string;
}

@Injectable()
export class ResponseEnvelopeInterceptor<T>
  implements NestInterceptor<T, T | SuccessEnvelope<T>>
{
  constructor(private readonly reflector: Reflector) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<T | SuccessEnvelope<T>> {
    const skip = this.reflector.getAllAndOverride<boolean>(NO_ENVELOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (skip) {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const requestId =
      (request.headers['x-request-id'] as string | undefined) ?? randomUUID();

    return next.handle().pipe(
      map((data) => {
        if (response.statusCode === HttpStatus.NO_CONTENT) {
          return data;
        }

        return { success: true as const, data, requestId };
      }),
    );
  }
}
