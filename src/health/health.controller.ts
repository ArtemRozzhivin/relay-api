import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisHealthIndicator } from './redis.health.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { NoEnvelope } from '../common/decorators/no-envelope.decorator.js';

@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
    private readonly redis: RedisHealthIndicator,
  ) {}

  @Public()
  @NoEnvelope()
  @Get('health')
  @HealthCheck()
  liveness() {
    return this.health.check([]);
  }

  @Public()
  @NoEnvelope()
  @Get('ready')
  @HealthCheck()
  readiness() {
    return this.health.check([
      () => this.database.pingCheck('database', this.prisma).withTimeout(1500),
      () => this.redis.isHealthy('redis'),
    ]);
  }
}
