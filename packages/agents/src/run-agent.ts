import type { ZodType } from 'zod';
import type { AgentType } from '@app/shared';
import type { LlmClient, LlmUsage } from '@app/llm';

/**
 * Metadata describing how an agent's structured output was produced. Mirrors the
 * non-payload fields of the llm layer's `LlmResult`, so the workflow/activity
 * layer can persist an `AgentRun` row (provider, model, attempts, latency,
 * usage, redacted raw response) without re-deriving them.
 */
export interface AgentMeta {
  provider: string;
  model: string;
  attempts: number;
  latencyMs: number;
  repaired: boolean;
  usage: LlmUsage | null;
  rawRedacted: string;
}

/** The validated output of an agent plus the metadata about its production. */
export interface AgentResult<T> {
  output: T;
  meta: AgentMeta;
}

/**
 * The `agentType` strings the mock provider (and real adapters) understand.
 * These are the short aliases accepted alongside the shared `AgentType` enum.
 */
export type AgentTypeKey =
  | 'research'
  | 'outreach'
  | 'compliance'
  | 'inbound_classify'
  | 'scheduling_extract'
  | 'scheduling_reply';

/** Arguments for {@link runAgent}. */
export interface RunAgentArgs<T> {
  /** Routes the request to the right canned/structured behavior. */
  agentType: AgentType | AgentTypeKey;
  /** The system prompt for this agent. */
  system: string;
  /** Arbitrary structured input serialized into the user turn. */
  input: unknown;
  /** The Zod schema the output must satisfy. */
  schema: ZodType<T>;
  /** Optional model override; falls back to the client's default model. */
  model?: string;
  /** Optional per-call timeout in milliseconds. */
  timeoutMs?: number;
}

/**
 * Shared helper that every agent funnels through. It issues a single structured
 * request via `client.structured(...)` and maps the llm layer's `LlmResult` onto
 * an {@link AgentResult}.
 *
 * It does NOT catch {@link import('@app/shared').EscalationError}: when the llm
 * layer exhausts its repair budget it throws, and that error is allowed to
 * propagate so the workflow/activity layer can record the `AgentRun` +
 * `AuditLog` and route the case to human review. Agents are pure with respect to
 * side effects — no DB writes, no provider calls of their own.
 */
export async function runAgent<T>(
  client: LlmClient,
  args: RunAgentArgs<T>,
): Promise<AgentResult<T>> {
  const result = await client.structured<T>({
    agentType: args.agentType,
    system: args.system,
    input: args.input,
    schema: args.schema,
    model: args.model,
    timeoutMs: args.timeoutMs,
  });

  return {
    output: result.parsed,
    meta: {
      provider: result.provider,
      model: result.model,
      attempts: result.attempts,
      latencyMs: result.latencyMs,
      repaired: result.repaired,
      usage: result.usage,
      rawRedacted: result.rawRedacted,
    },
  };
}
