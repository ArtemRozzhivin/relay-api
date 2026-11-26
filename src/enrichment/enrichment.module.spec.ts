import { describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EnrichmentModule } from './enrichment.module.js';
import { LLM_PROVIDER } from './llm-provider.js';
import { ClaudeLlmProvider } from './claude-llm.provider.js';
import { FakeLlmProvider } from './fake-llm.provider.js';

// A configuration of exactly these values: the real one would also read the
// test tier's own LLM_PROVIDER from the environment.
const providerFor = async (env: Record<string, unknown>) => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      {
        module: class StubConfigModule {},
        global: true,
        providers: [
          {
            provide: ConfigService,
            useValue: { get: (key: string) => env[key] },
          },
        ],
        exports: [ConfigService],
      },
      EnrichmentModule,
    ],
  }).compile();

  return moduleRef.get(LLM_PROVIDER);
};

describe('EnrichmentModule', () => {
  it('binds Claude, at the configured model, when LLM_PROVIDER says so', async () => {
    const provider = await providerFor({
      LLM_PROVIDER: 'claude',
      LLM_MODEL: 'claude-haiku-5-5',
      ANTHROPIC_API_KEY: 'test-key',
    });

    expect(provider).toBeInstanceOf(ClaudeLlmProvider);
    expect(provider.price).toEqual({
      inputUsdPerMillionTokens: 0.1,
      outputUsdPerMillionTokens: 0.5,
    });
  });

  it('binds the fake otherwise', async () => {
    expect(
      await providerFor({ LLM_PROVIDER: 'fake', FAKE_LLM_DIRECTIVES: false }),
    ).toBeInstanceOf(FakeLlmProvider);
  });
});
