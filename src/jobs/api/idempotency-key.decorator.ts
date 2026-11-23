import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import {
  IdempotencyKeyRequiredError,
  IdempotencyKeyReservedError,
} from '../../common/errors/app-error.js';
import { PIPELINE_KEY_PREFIX } from '../engine/pipeline-keys.js';

export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const header = context.switchToHttp().getRequest<Request>().headers[
      'idempotency-key'
    ];

    if (typeof header !== 'string' || header.trim().length === 0) {
      throw new IdempotencyKeyRequiredError();
    }

    if (header.trim().startsWith(PIPELINE_KEY_PREFIX)) {
      throw new IdempotencyKeyReservedError(PIPELINE_KEY_PREFIX);
    }

    return header.trim();
  },
);
