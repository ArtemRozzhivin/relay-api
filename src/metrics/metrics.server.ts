import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Registry } from '@prometheus-io/client';
import type { SharedEnv } from '../config/env.schema.js';
import { describeError } from '../common/errors/describe-error.js';

/**
 * `GET /metrics` on its own port, apart from the API's: the edge's CORS and
 * rate limits never apply to Prometheus, and the port can be closed to the
 * internet while the API's is open. The worker has no other HTTP server.
 */
@Injectable()
export class MetricsServer implements OnApplicationShutdown {
  private readonly logger = new Logger(MetricsServer.name);
  private server?: Server;

  constructor(
    private readonly registry: Registry,
    private readonly config: ConfigService<SharedEnv, true>,
  ) {}

  /**
   * Starts serving on `METRICS_PORT`, or does nothing when it is unset.
   * Called by the entry points, not on bootstrap, so a test that compiles a
   * module opens no port.
   *
   * @throws when the port cannot be bound — a second process given the same
   * one fails at startup, not silently unscraped.
   */
  async listen() {
    const port = this.config.get('METRICS_PORT', { infer: true });

    if (port === undefined) {
      return;
    }

    const server = createServer((req, res) => void this.respond(req, res));

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, resolve);
    });

    this.server = server;
    this.logger.log(`Serving metrics on :${port}/metrics`);
  }

  async onApplicationShutdown() {
    const server = this.server;

    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  private async respond(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404).end();

      return;
    }

    try {
      const body = await this.registry.metrics();

      res.writeHead(200, { 'Content-Type': this.registry.contentType });
      res.end(body);
    } catch (error) {
      this.logger.error(`Could not collect metrics: ${describeError(error)}`);
      res.writeHead(500).end();
    }
  }
}
