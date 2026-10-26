import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RedisModule } from '../redis/redis.module.js';
import { EventsGateway } from './events.gateway.js';

@Module({
  imports: [AuthModule, RedisModule],
  providers: [EventsGateway],
})
export class EventsModule {}
