import Anthropic from '@anthropic-ai/sdk';
import { ProviderError } from '@app/shared';
import type { LlmProvider, LlmUsage, RawCompleteRequest, RawCompleteResult } from './types.js';

/** Default request timeout when none is supplied. */
const DEFAULT_TIMEOUT_MS = 60_000;
/** Anthropic requires an explicit max_tokens. */
const DEFAULT_MAX_TOKENS = 2048;

/**
 * Real Anthropic adapter. Uses the Messages API; the system prompt is passed as
 * `system` and the serialized input as the single user turn. We instruct
 * JSON-only output via the system prompt (the Messages API has no native JSON
 * response_format). SDK failures and timeouts surface as {@link ProviderError}.
 * Not exercised in tests (no key); kept lean but correct.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  readonly model: string;
  private readonly client: Anthropic;

  constructor(args: { apiKey: string; model: string }) {
    this.model = args.model;
    this.client = new Anthropic({ apiKey: args.apiKey });
  }

  /**
   * Issue one Messages API completion and return the raw text plus token usage.
   * Empty responses, SDK errors, and timeouts surface as {@link ProviderError}.
   */
  async rawComplete(req: RawCompleteRequest): Promise<RawCompleteResult> {
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const userContent =
      typeof req.input === 'string' ? req.input : JSON.stringify(req.input);
    const system = `${req.system}\n\nRespond with a single valid JSON object only. Do not include markdown fences or any prose.`;

    try {
      const message = await this.client.messages.create(
        {
          model: req.model || this.model,
          system,
          max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          temperature: req.temperature,
          messages: [{ role: 'user', content: userContent }],
        },
        { timeout: timeoutMs },
      );

      const text = message.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')
        .trim();

      if (text.length === 0) {
        throw new ProviderError('Anthropic returned an empty message', {
          provider: 'anthropic',
          model: req.model || this.model,
        });
      }

      const usage: LlmUsage = {
        promptTokens: message.usage.input_tokens,
        completionTokens: message.usage.output_tokens,
        totalTokens: message.usage.input_tokens + message.usage.output_tokens,
      };

      return { text, usage };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError('Anthropic request failed', {
        provider: 'anthropic',
        model: req.model || this.model,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
