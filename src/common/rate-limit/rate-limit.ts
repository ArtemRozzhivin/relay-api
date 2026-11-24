import { Injectable } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  minutes,
  Throttle,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
} from '@nestjs/throttler';
import type { Request } from 'express';
import type { ApiEnv } from '../../config/env.schema.js';

/**
 * The limiter's settings, for `ThrottlerModule.forRootAsync`. Counters are
 * kept in this process's memory: exact while one API instance runs, and a
 * second one is the point to move them to Redis.
 */
export const rateLimitOptions = (
  config: ConfigService<ApiEnv, true>,
): ThrottlerModuleOptions => ({
  // The baseline on every route, per caller: five a second, where a dashboard
  // polling every couple of seconds uses one. Costly routes set their own.
  throttlers: [{ ttl: minutes(1), limit: 300 }],
  skipIf: () => !config.get('RATE_LIMITS', { infer: true }),
  errorMessage: 'Too many requests; retry after the seconds in Retry-After',
});

/**
 * The limiter, global: every route has the baseline unless it sets its own
 * with `RateLimit`. A signed-in caller is counted by account, so changing
 * address does not reset its count and an office behind one address does not
 * share one — which needs `JwtAuthGuard` and `ApiKeyGuard` to have run first
 * and set the user, whichever credential it came with.
 */
@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
  protected override async getTracker(req: Request) {
    return req.user?.id ?? super.getTracker(req);
  }
}

/**
 * Replaces the baseline on one route: each caller may send `limit` requests in
 * any `ttl` milliseconds — per account when signed in, per address otherwise
 * (see `TRUST_PROXY`). The request that goes over it, and every one for a
 * `ttl` after, is answered `429 TOO_MANY_REQUESTS` with `Retry-After` in
 * seconds. Every request counts, a replayed submit included (D16).
 */
export const RateLimit = (limit: number, ttl: number) =>
  Throttle({ default: { limit, ttl } });
