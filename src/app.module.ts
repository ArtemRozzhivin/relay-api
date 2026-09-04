import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { apiEnvSchema } from './config/env.schema.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      // Global: every module can inject ConfigService without importing this one.
      isGlobal: true,
      cache: true,
      envFilePath: ['.env'],
      // Nest 12 accepts any Standard Schema validator, so the Zod schema goes in
      // directly — no Joi, and no second definition of the same contract.
      validationSchema: apiEnvSchema,
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
