import type { IncomingMessage, ServerResponse } from 'node:http';
import type { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { IoAdapter } from '@nestjs/platform-socket.io';
import helmet from 'helmet';
import type { ServerOptions } from 'socket.io';
import type { ApiEnv } from './config/env.schema.js';
import { assignRequestId } from './common/logging/request-id.js';
import { HttpMetrics } from './metrics/http-metrics.js';
import { setUpApiDocs } from './docs/api-docs.js';

// The largest body a route takes is an image.process batch: 50 SKUs, about
// 30 KB even with every character sent as a \u escape.
const JSON_BODY_LIMIT = '64kb';

/**
 * The HTTP edge: the client's address, request metrics, the request id,
 * security headers, the body parser, and the origins a browser may call from
 * — over HTTP and over the socket alike — and the API's reference at /docs.
 * Shared by `main.ts` and the tests that boot `AppModule`, so those run against
 * the edge that ships.
 *
 * Call before `listen()`, on an app created with `bodyParser: false`: Nest's
 * default parsers would otherwise add a form parser nothing here reads.
 */
export const configureApp = (app: NestExpressApplication) => {
  const config: ConfigService<ApiEnv, true> = app.get(ConfigService);
  const origins = config.get('CORS_ORIGINS', { infer: true });

  // What `req.ip` is — the address an anonymous caller is rate-limited by.
  app.set('trust proxy', config.get('TRUST_PROXY', { infer: true }) ?? false);

  // In the order they run. Metrics first, so a request the parser refuses is
  // timed and counted too. CORS before the body parser: a browser can read
  // an error only from a response that carries its CORS headers.
  app.use(app.get(HttpMetrics).middleware);
  app.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
    assignRequestId(req, res);
    next();
  });
  app.use(helmet());
  app.enableCors({
    origin: origins,
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
  });
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });

  app.useWebSocketAdapter(new AllowlistIoAdapter(app, origins));

  setUpApiDocs(app);
};

// A gateway's decorator is evaluated when its file is imported, before any
// configuration exists, so the configured origins reach socket.io here.
// They bind only a browser's polling requests — a WebSocket is not subject to
// CORS. What keeps a socket private is the token its handshake must carry.
class AllowlistIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly origins: string[],
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions) {
    // Nest types the options as complete; socket.io takes them partial, the
    // way a gateway's decorator gives them.
    return super.createIOServer(port, {
      ...options,
      cors: { origin: this.origins },
    } as ServerOptions);
  }
}
