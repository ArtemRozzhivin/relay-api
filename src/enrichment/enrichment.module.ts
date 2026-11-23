import { Module } from '@nestjs/common';
import { LLM_PROVIDER } from './llm-provider.js';
import { FakeLlmProvider } from './fake-llm.provider.js';

// The fake is the only provider PD builds (§6.3d); a real one replaces this
// binding and nothing that injects LLM_PROVIDER changes.
@Module({
  providers: [{ provide: LLM_PROVIDER, useClass: FakeLlmProvider }],
  exports: [LLM_PROVIDER],
})
export class EnrichmentModule {}
