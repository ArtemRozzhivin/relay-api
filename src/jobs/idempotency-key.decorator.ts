import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { IdempotencyKeyRequiredError } from '../common/errors/app-error.js';

export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const header = context
      .switchToHttp()
      .getRequest<Request>().headers['idempotency-key'];

    if (typeof header !== 'string' || header.trim().length === 0) {
      throw new IdempotencyKeyRequiredError();
    }

    return header.trim();
  },
);
