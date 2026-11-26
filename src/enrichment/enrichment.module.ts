import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WorkerEnv } from '../config/env.schema.js';
import { LLM_PROVIDER } from './llm-provider.js';
import { FakeLlmProvider } from './fake-llm.provider.js';
import { ClaudeLlmProvider } from './claude-llm.provider.js';

// LLM_PROVIDER chooses, and nothing that injects the token changes with it.
// The fake obeys the directives in product names only where the setting asks:
// they are how the tests make the model fail, and in a name any account can
// write, one of them pauses every account's AI work.
@Module({
  providers: [
    {
      provide: LLM_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<WorkerEnv, true>) =>
        config.get('LLM_PROVIDER', { infer: true }) === 'claude'
          ? new ClaudeLlmProvider({
              apiKey: config.get('ANTHROPIC_API_KEY', { infer: true }),
              model: config.get('LLM_MODEL', { infer: true }),
            })
          : new FakeLlmProvider({
              directives: config.get('FAKE_LLM_DIRECTIVES', { infer: true }),
            }),
    },
  ],
  exports: [LLM_PROVIDER],
})
export class EnrichmentModule {}
