import {
  Inject,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  type OnGatewayConnection,
  type OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import type { Server, Socket } from 'socket.io';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module.js';
import {
  JOB_EVENTS_CHANNEL,
  type JobUpdatedEvent,
} from '../jobs/job-events.js';
import type { AccessTokenPayload } from '../auth/auth.types.js';

export const userRoom = (userId: string) => `user:${userId}`;

@WebSocketGateway({ namespace: 'events', cors: { origin: true } })
export class EventsGateway
  implements OnGatewayInit, OnGatewayConnection, OnModuleInit, OnModuleDestroy
{
  @WebSocketServer() server!: Server;

  private readonly logger = new Logger(EventsGateway.name);
  private subscriber?: Redis;

  constructor(
    private readonly jwtService: JwtService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  // Authenticating in middleware rejects during the handshake, so the client
  // gets a connect_error and never has a connected socket. Doing it in
  // handleConnection would accept the connection and then drop it.
  afterInit(server: Server) {
    server.use(async (socket, next) => {
      const token = socket.handshake.auth?.token as string | undefined;

      if (!token) {
        next(new Error('unauthorized'));

        return;
      }

      try {
        const payload =
          await this.jwtService.verifyAsync<AccessTokenPayload>(token);

        socket.data.userId = payload.sub;

        next();
      } catch {
        next(new Error('unauthorized'));
      }
    });
  }

  async handleConnection(client: Socket) {
    const userId = client.data.userId as string | undefined;

    if (!userId) {
      client.disconnect(true);

      return;
    }

    // The room comes from the verified token, never from anything the client
    // sends; otherwise subscribing to another tenant is a one-line request.
    await client.join(userRoom(userId));
  }

  async onModuleInit() {
    // A subscribed ioredis connection refuses every other command, so the
    // shared client cannot be the one that subscribes.
    this.subscriber = this.redis.duplicate();

    this.subscriber.on('message', (_channel, raw: string) => this.fanOut(raw));

    await this.subscriber.subscribe(JOB_EVENTS_CHANNEL);
  }

  private fanOut(raw: string) {
    try {
      const event = JSON.parse(raw) as JobUpdatedEvent;

      if (!event?.userId || !event.job) {
        return;
      }

      this.server.to(userRoom(event.userId)).emit('job.updated', event.job);
    } catch (error) {
      this.logger.warn(
        `Discarded a malformed job event: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async onModuleDestroy() {
    await this.subscriber
      ?.quit()
      .catch(() => this.subscriber?.disconnect());
  }
}
