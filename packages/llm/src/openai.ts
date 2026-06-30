import OpenAI from 'openai';
import { ProviderError } from '@app/shared';
import type { LlmProvider, LlmUsage, RawCompleteRequest, RawCompleteResult } from './types.js';

/** Default request timeout when none is supplied. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Real OpenAI adapter. Uses Chat Completions in JSON-object response mode. The
 * system prompt and the serialized input become the two messages. SDK failures
 * (and timeouts) surface as {@link ProviderError}. Not exercised in tests (no
 * key); kept lean but correct.
 */
export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai' as const;
  readonly model: string;
  private readonly client: OpenAI;

  constructor(args: { apiKey: string; model: string }) {
    this.model = args.model;
    this.client = new OpenAI({ apiKey: args.apiKey });
  }

  /**
   * Issue one Chat Completions request in JSON-object mode and return the raw
   * text plus usage. Empty responses and SDK errors surface as {@link ProviderError}.
   */
  async rawComplete(req: RawCompleteRequest): Promise<RawCompleteResult> {
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const userContent =
      typeof req.input === 'string' ? req.input : JSON.stringify(req.input);

    try {
      const completion = await this.client.chat.completions.create(
        {
          model: req.model || this.model,
          temperature: req.temperature,
          max_tokens: req.maxTokens,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: userContent },
          ],
        },
        { timeout: timeoutMs },
      );

      const text = completion.choices[0]?.message?.content;
      if (text === undefined || text === null) {
        throw new ProviderError('OpenAI returned an empty completion', {
          provider: 'openai',
          model: req.model || this.model,
        });
      }

      let usage: LlmUsage | null = null;
      if (completion.usage) {
        usage = {
          promptTokens: completion.usage.prompt_tokens,
          completionTokens: completion.usage.completion_tokens,
          totalTokens: completion.usage.total_tokens,
        };
      }

      return { text, usage };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError('OpenAI request failed', {
        provider: 'openai',
        model: req.model || this.model,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
