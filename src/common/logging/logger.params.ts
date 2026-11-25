import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { Params } from 'nestjs-pino';
import type { ApiEnv, SharedEnv } from '../../config/env.schema.js';
import { assignRequestId } from './request-id.js';

export function buildLoggerParams(config: ConfigService<ApiEnv, true>): Params {
  const nodeEnv = config.get('NODE_ENV', { infer: true });

  return {
    pinoHttp: {
      level:
        nodeEnv === 'test'
          ? 'silent'
          : config.get('LOG_LEVEL', { infer: true }),

      genReqId: assignRequestId,

      // Every line logged while a request is handled carries its id, and under
      // the worker's name for it: one search for a correlationId finds the
      // request and the job runs it started (§12.1). The whole request goes on
      // the line that closes it, not on each line before.
      quietReqLogger: true,
      customAttributeKeys: { reqId: 'correlationId' },

      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie'],
        censor: '[redacted]',
      },

      autoLogging: {
        ignore: (req) => req.url === '/health' || req.url === '/ready',
      },

      // The key's id, never the key: which of an account's keys made a
      // request is what its owner asks after a leak (§6.3f).
      customProps: (req) => ({
        userId: (req as Request).user?.id,
        apiKeyId: (req as Request).user?.apiKeyId,
      }),

      transport:
        nodeEnv === 'production'
          ? undefined
          : {
              target: 'pino-pretty',
              options: { singleLine: true, translateTime: 'HH:MM:ss.l' },
            },
    },
  };
}

export function buildWorkerLoggerParams(
  config: ConfigService<SharedEnv, true>,
): Params {
  const nodeEnv = config.get('NODE_ENV', { infer: true });

  return {
    pinoHttp: {
      level:
        nodeEnv === 'test'
          ? 'silent'
          : config.get('LOG_LEVEL', { infer: true }),
      base: { role: 'worker' },
      transport:
        nodeEnv === 'production'
          ? undefined
          : {
              target: 'pino-pretty',
              options: { singleLine: true, translateTime: 'HH:MM:ss.l' },
            },
    },
  };
}
