import { describe, expect, it } from 'vitest';
import { apiEnvSchema } from './env.schema.js';

const valid = {
  DATABASE_URL: 'postgresql://relay:relay@localhost:5432/relay?schema=public',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
};

describe('apiEnvSchema', () => {
  it('applies defaults for optional variables', () => {
    const env = apiEnvSchema.parse(valid);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.JOB_MAX_ATTEMPTS).toBe(5);
    expect(env.ACCESS_TOKEN_TTL).toBe('15m');
  });

  it('coerces numeric variables from their string form', () => {
    const env = apiEnvSchema.parse({ ...valid, PORT: '8080' });
    expect(env.PORT).toBe(8080);
  });

  it('ignores unrelated process variables', () => {
    const env = apiEnvSchema.parse({ ...valid, PATH: '/usr/bin', HOME: '/root' });
    expect(env).not.toHaveProperty('PATH');
  });

  it('splits CORS_ORIGINS into a trimmed list', () => {
    const env = apiEnvSchema.parse({
      ...valid,
      CORS_ORIGINS: 'http://localhost:3000, https://relay.example ',
    });
    expect(env.CORS_ORIGINS).toEqual([
      'http://localhost:3000',
      'https://relay.example',
    ]);
  });

  it('rejects a missing DATABASE_URL', () => {
    const { DATABASE_URL: _omitted, ...withoutUrl } = valid;
    const result = apiEnvSchema.safeParse(withoutUrl);
    expect(result.success).toBe(false);
  });

  it('rejects a database URL with the wrong protocol', () => {
    const result = apiEnvSchema.safeParse({
      ...valid,
      DATABASE_URL: 'mysql://localhost:3306/relay',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a JWT secret shorter than 32 characters', () => {
    const result = apiEnvSchema.safeParse({ ...valid, JWT_ACCESS_SECRET: 'short' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('at least 32 characters');
  });

  it('rejects an out-of-range JOB_MAX_ATTEMPTS', () => {
    expect(apiEnvSchema.safeParse({ ...valid, JOB_MAX_ATTEMPTS: '0' }).success).toBe(false);
    expect(apiEnvSchema.safeParse({ ...valid, JOB_MAX_ATTEMPTS: '21' }).success).toBe(false);
  });
});
