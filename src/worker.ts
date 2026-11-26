// First, before any module: the processors' concurrency and limiter are read
// from process.env as jobs.processor.ts loads, so .env must be loaded by then
// (§8.4). Moved below another import, those settings fall back to defaults.
import './load-env.js';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker/worker.module.js';
import { MetricsServer } from './metrics/metrics.server.js';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });

  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  await app.get(MetricsServer).listen();
}

await bootstrap();
