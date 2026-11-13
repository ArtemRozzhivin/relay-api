import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { configureApp } from './configure-app.js';
import { MetricsServer } from './metrics/metrics.server.js';
import type { ApiEnv } from './config/env.schema.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    bodyParser: false,
  });

  app.useLogger(app.get(Logger));
  configureApp(app);
  const config: ConfigService<ApiEnv, true> = app.get(ConfigService);

  app.enableShutdownHooks();

  await app.listen(config.get('PORT', { infer: true }));
  await app.get(MetricsServer).listen();
}

await bootstrap();
