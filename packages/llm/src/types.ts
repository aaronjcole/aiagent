import type { ZodType } from 'zod';

/** Provider identifier. */
export type LlmProviderName = 'mock' | 'openai' | 'anthropic';

/** Token usage reported by a provider, when available. */
export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Low-level request handed to a provider's `rawComplete`. Providers are
 * responsible only for turning a system prompt + input into a single raw text
 * response (ideally JSON); they do NOT parse or validate.
 */
export interface RawCompleteRequest {
  /** Model id to use (provider-specific). */
  model: string;
  /** System prompt / instructions. */
  system: string;
  /** Arbitrary structured input; serialized into the user turn. */
  input: unknown;
  /** Per-call timeout in milliseconds. */
  timeoutMs?: number;
  /**
   * Used by the mock to pick a canned, schema-valid payload. Real providers
   * may ignore it. Accepts both the shared `AgentType` values
   * (`inbound_classifier`, `scheduling_extractor`) and the short aliases
   * (`inbound_classify`, `scheduling_extract`).
   */
  agentType?: string;
  /** Optional sampling temperature. */
  temperature?: number;
  /** Optional max output tokens. */
  maxTokens?: number;
}

/** What a provider returns from `rawComplete`: raw text plus optional usage. */
export interface RawCompleteResult {
  text: string;
  usage: LlmUsage | null;
}

/**
 * The provider contract. A single low-level method; the JSON-parse + Zod
 * validation + repair loop lives in {@link LlmClient} / {@link runStructured}
 * so it is implemented exactly once.
 */
export interface LlmProvider {
  readonly name: LlmProviderName;
  readonly model: string;
  rawComplete(req: RawCompleteRequest): Promise<RawCompleteResult>;
}

/** Retry policy for the structured-output repair loop. */
export interface RetryPolicy {
  /** Maximum number of repair attempts (in addition to the first try). Default 2. */
  maxRepairs?: number;
}

/**
 * High-level structured request. Carries the Zod schema the output must
 * satisfy; the client parses, validates and repairs against it.
 */
export interface StructuredRequest<T> {
  model?: string;
  system: string;
  input: unknown;
  schema: ZodType<T>;
  timeoutMs?: number;
  retry?: RetryPolicy;
  agentType?: string;
  temperature?: number;
  maxTokens?: number;
}

/** The validated, structured result returned by the client. */
export interface LlmResult<T> {
  /** The parsed + Zod-validated value. */
  parsed: T;
  /** The redacted, truncated raw response (safe to persist/log). */
  rawRedacted: string;
  /** Token usage, when the provider reported it. */
  usage: LlmUsage | null;
  /** Total provider calls made (1 = success on first try). */
  attempts: number;
  /** Provider name that served the request. */
  provider: string;
  /** Model id used. */
  model: string;
  /** End-to-end latency in milliseconds. */
  latencyMs: number;
  /** Whether a repair attempt was needed to produce a valid result. */
  repaired: boolean;
}
