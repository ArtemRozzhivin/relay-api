import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SharedEnv } from '../config/env.schema.js';
import { LLM_PROVIDER } from './llm-provider.js';
import { FakeLlmProvider } from './fake-llm.provider.js';

// The fake is the only provider PD builds (§6.3d); a real one replaces this
// binding and nothing that injects LLM_PROVIDER changes. It obeys the
// directives in product names only where the setting asks: they are how the
// tests make the model fail, and in a name any account can write, one of them
// pauses every account's AI work.
@Module({
  providers: [
    {
      provide: LLM_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<SharedEnv, true>) =>
        new FakeLlmProvider({
          directives: config.get('FAKE_LLM_DIRECTIVES', { infer: true }),
        }),
    },
  ],
  exports: [LLM_PROVIDER],
})
export class EnrichmentModule {}
