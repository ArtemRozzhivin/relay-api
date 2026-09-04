import { z } from 'zod';

/**
 * The environment contract.
 *
 * Every variable the application reads is declared here, and `process.env` is
 * not read anywhere else (TECH_SPEC §11). Validation runs once at boot, so a
 * misconfigured deployment fails to start rather than failing a request later.
 */

/** `15m`, `24h`, `30d` — the shape jsonwebtoken and ms accept. */
const duration = z
  .string()
  .regex(/^\d+(ms|s|m|h|d)$/, 'expected a duration such as 15m, 24h or 30d');

/**
 * Required by every process. The API and the worker deliberately do not share a
 * config surface — the worker holding JWT secrets it never uses would be
 * needless blast radius.
 */
export const sharedEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
});

/** The API additionally serves HTTP and mints tokens. */
export const apiEnvSchema = sharedEnvSchema.extend({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // 32 chars minimum: the secret is the only thing standing between an attacker
  // and minting a valid token for any user.
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
});

export type SharedEnv = z.infer<typeof sharedEnvSchema>;
export type ApiEnv = z.infer<typeof apiEnvSchema>;
