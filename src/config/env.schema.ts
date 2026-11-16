import { z } from 'zod';

const duration = z
  .string()
  .regex(/^\d+(ms|s|m|h|d)$/, 'expected a duration such as 15m, 24h or 30d');

// Express's own forms: a hop count, or the proxies' addresses and subnets.
// `true` is refused: it trusts every hop, so a client that writes its own
// X-Forwarded-For chooses the address it is limited by.
const trustProxy = z
  .string()
  .refine((raw) => raw.trim() !== 'true', {
    message: 'name a hop count or the proxy addresses, not true',
  })
  .transform((raw) =>
    /^\d+$/.test(raw.trim())
      ? Number(raw)
      : raw
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean),
  );

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
  AWS_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ENDPOINT: z.url().optional(),
  // Unset, the process serves no metrics: a port is opened only where a
  // deployment asks for one.
  METRICS_PORT: z.coerce.number().int().min(1).max(65535).optional(),
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
  // Unset, a request's address is its socket's and X-Forwarded-For is ignored.
  TRUST_PROXY: trustProxy.optional(),
  // Off only in the tests, which register hundreds of accounts from one
  // address. Never off in production.
  RATE_LIMITS: z.stringbool().default(true),
  RELAY_FAULT_AFTER_COMMIT: z.stringbool().default(false),
  ARGONID_TIME_COST: z.coerce.number().int().positive().default(2),
  ARGONID_MEMORY_COST: z.coerce.number().int().positive().default(19456),
});

export const workerEnvSchema = sharedEnvSchema.extend({
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  RELAY_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1000).default(60_000),
  RELAY_FAULT_SKIP_ABANDON: z.stringbool().default(false),
});

export type SharedEnv = z.infer<typeof sharedEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;
export type ApiEnv = z.infer<typeof apiEnvSchema>;
