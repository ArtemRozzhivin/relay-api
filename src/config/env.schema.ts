import { z } from 'zod';

const duration = z
  .string()
  .regex(/^\d+(ms|s|m|h|d)$/, 'expected a duration such as 15m, 24h or 30d');

export const sharedEnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
});

export const apiEnvSchema = sharedEnvSchema.extend({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'must be at least 32 characters'),
  ACCESS_TOKEN_TTL: duration.default('15m'),
  REFRESH_TOKEN_TTL: duration.default('30d'),
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((raw) =>
      raw
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  ARGONID_TIME_COST: z.coerce.number().int().positive().default(2),
  ARGONID_MEMORY_COST: z.coerce.number().int().positive().default(19456),
});

export type SharedEnv = z.infer<typeof sharedEnvSchema>;
export type ApiEnv = z.infer<typeof apiEnvSchema>;
