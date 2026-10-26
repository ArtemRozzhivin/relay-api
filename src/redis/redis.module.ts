import { Inject, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { SharedEnv } from '../config/env.schema.js';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (config: ConfigService<SharedEnv, true>) => {
        const logger = new Logger('Redis');

        const client = new Redis(config.get('REDIS_URL', { infer: true }));

        client.on('ready', () => logger.log('Connected'));
        client.on('reconnecting', () => logger.warn('Reconnecting'));
        client.on('error', (error) =>
          logger.error('Connection refused', error),
        );

        return client;
      },
      inject: [ConfigService],
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onModuleDestroy() {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
