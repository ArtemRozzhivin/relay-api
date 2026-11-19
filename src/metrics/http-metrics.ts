import type { IncomingMessage, ServerResponse } from 'node:http';
import { Injectable } from '@nestjs/common';
import { Histogram, Registry } from '@prometheus-io/client';
import type { Request } from 'express';

/**
 * Every response the API sends, timed from the first middleware, by method,
 * route and status — so `429`s by route are a query, not a log search.
 *
 * `route` is the matched pattern (`/jobs/:id`), never the path: one series
 * per job id would grow without bound. A request no route matched — a `404`,
 * or a body the parser refused first — is `unmatched`.
 */
@Injectable()
export class HttpMetrics {
  private readonly duration: Histogram<'method' | 'route' | 'status'>;

  constructor(registry: Registry) {
    this.duration = new Histogram({
      name: 'relay_http_request_duration_seconds',
      help: 'API responses by method, matched route and status',
      labelNames: ['method', 'route', 'status'],
      registers: [registry],
    });
  }

  readonly middleware = (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ) => {
    const end = this.duration.startTimer({ method: req.method });

    // 'finish', not 'close': a client that hung up was sent no status, and
    // counting it under the one the handler had set would invent one.
    res.once('finish', () => {
      const { route } = req as Request;
      // Nest mounts module middleware — the logger — as a wildcard route,
      // `{/*splat}`, so a request no controller took still carries that one.
      // No controller's route has a wildcard.
      const path = route === undefined ? '' : String(route.path);

      end({
        route: path && !path.includes('*') ? path : 'unmatched',
        status: res.statusCode,
      });
    });
    next();
  };
}
