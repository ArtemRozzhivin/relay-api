import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';
import type { ApiEnv } from './config/env.schema.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // `true` marks the config as validated, so `get` returns a non-optional value.
  const config: ConfigService<ApiEnv, true> = app.get(ConfigService);

  await app.listen(config.get('PORT', { infer: true }));
}

await bootstrap();
