import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { Params } from 'nestjs-pino';
import type { ApiEnv } from '../../config/env.schema.js';

export function buildLoggerParams(config: ConfigService<ApiEnv, true>): Params {
  const nodeEnv = config.get('NODE_ENV', { infer: true });

  return {
    pinoHttp: {
      level: nodeEnv === 'test' ? 'silent' : config.get('LOG_LEVEL', { infer: true }),

      genReqId: (req, res) => {
        const inbound = req.headers['x-request-id'];
        const id = typeof inbound === 'string' && inbound ? inbound : randomUUID();

        res.setHeader('X-Request-Id', id);

        return id;
      },

      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie'],
        censor: '[redacted]',
      },

      autoLogging: {
        ignore: (req) => req.url === '/health' || req.url === '/ready',
      },

      customProps: (req) => ({ userId: (req as Request).user?.id }),

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
