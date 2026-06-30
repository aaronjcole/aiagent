/**
 * @app/llm — LlmProvider interface + mock/openai/anthropic adapters and a
 * structured-output helper (JSON parse + Zod validation + repair/retry loop).
 *
 * The providers implement a low-level `rawComplete` (raw text + usage). The
 * parse/validate/repair loop lives once in `runStructured` / `LlmClient`.
 */
export type {
  LlmProvider,
  LlmProviderName,
  LlmUsage,
  LlmResult,
  RawCompleteRequest,
  RawCompleteResult,
  StructuredRequest,
  RetryPolicy,
} from './types.js';

export { MockLlmProvider, mockPayloadFor } from './mock.js';
export { OpenAiProvider } from './openai.js';
export { AnthropicProvider } from './anthropic.js';
export { runStructured, LlmClient } from './client.js';
export { createLlmProvider, createLlmClient } from './factory.js';
export { redactRaw, MAX_RAW_LENGTH } from './redact.js';
