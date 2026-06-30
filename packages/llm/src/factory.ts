import { ProviderError, type Config, type Logger } from '@app/shared';
import { LlmClient } from './client.js';
import { MockLlmProvider } from './mock.js';
import { OpenAiProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import type { LlmProvider } from './types.js';

/**
 * Select and construct an {@link LlmProvider} from config. Defaults to the
 * deterministic, offline {@link MockLlmProvider} (`config.llmProvider === 'mock'`),
 * which needs no credentials. The `openai`/`anthropic` adapters require their
 * respective API keys; a missing key throws {@link ProviderError}.
 */
export function createLlmProvider(config: Config, logger?: Logger): LlmProvider {
  switch (config.llmProvider) {
    case 'openai': {
      if (!config.openaiApiKey) {
        throw new ProviderError('OPENAI_API_KEY is required for the openai provider', {
          provider: 'openai',
        });
      }
      logger?.info({ provider: 'openai', model: config.openaiModel }, 'creating llm provider');
      return new OpenAiProvider({ apiKey: config.openaiApiKey, model: config.openaiModel });
    }
    case 'anthropic': {
      if (!config.anthropicApiKey) {
        throw new ProviderError('ANTHROPIC_API_KEY is required for the anthropic provider', {
          provider: 'anthropic',
        });
      }
      logger?.info(
        { provider: 'anthropic', model: config.anthropicModel },
        'creating llm provider',
      );
      return new AnthropicProvider({
        apiKey: config.anthropicApiKey,
        model: config.anthropicModel,
      });
    }
    case 'mock':
    default:
      logger?.info({ provider: 'mock' }, 'creating llm provider');
      return new MockLlmProvider();
  }
}

/**
 * Convenience: build a provider from config and wrap it in an {@link LlmClient}
 * so callers can issue `.structured(req)` calls with logging applied.
 */
export function createLlmClient(config: Config, logger?: Logger): LlmClient {
  return new LlmClient(createLlmProvider(config, logger), logger);
}
