import { Module, StandardSchemaValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { apiEnvSchema, type ApiEnv } from './config/env.schema.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RedisModule } from './redis/redis.module.js';
import { HealthModule } from './health/health.module.js';
import { AuthModule } from './auth/auth.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { EventsModule } from './events/events.module.js';
import { UploadsModule } from './uploads/uploads.module.js';
import { ProductsModule } from './products/products.module.js';
import { ApiKeysModule } from './api-keys/api-keys.module.js';
import { BullModule } from '@nestjs/bullmq';
import { ThrottlerModule } from '@nestjs/throttler';
import { DomainExceptionFilter } from './common/filters/domain-exception.filter.js';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor.js';
import { LoggerModule } from 'nestjs-pino';
import { buildLoggerParams } from './common/logging/logger.params.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { HttpMetrics } from './metrics/http-metrics.js';
import {
  RateLimitGuard,
  rateLimitOptions,
} from './common/rate-limit/rate-limit.js';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard.js';
import { RolesGuard } from './auth/guards/roles.guard.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env'],
      validationSchema: apiEnvSchema,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: buildLoggerParams,
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<ApiEnv, true>) => ({
        connection: { url: config.get('REDIS_URL', { infer: true }) },
      }),
    }),
    MetricsModule.forRoot('api'),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: rateLimitOptions,
    }),
    PrismaModule,
    RedisModule,
    HealthModule,
    AuthModule,
    JobsModule,
    EventsModule,
    UploadsModule,
    ProductsModule,
    ApiKeysModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    HttpMetrics,
    {
      provide: APP_PIPE,
      useClass: StandardSchemaValidationPipe,
    },
    // All here, in this order: global guards run in the order they are
    // registered, and the limiter counts a signed-in caller by the account
    // the JWT guard has just read.
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RateLimitGuard,
    },
    // Last: it reads the role the JWT guard put on the request, and lets
    // through every route that names none.
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_FILTER,
      useClass: DomainExceptionFilter,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseEnvelopeInterceptor,
    },
  ],
})
export class AppModule {}
