import { InboundClassificationSchema, type InboundClassification } from '@app/shared';
import type { LlmClient } from '@app/llm';
import { INBOUND_CLASSIFY_SYSTEM_PROMPT } from './prompts.js';
import { runAgent, type AgentResult } from './run-agent.js';
import type { AgentOptions } from './research.js';

/** Input for {@link classifyInbound}. */
export interface InboundInput {
  subject: string;
  body: string;
  fromEmail: string;
  threadContext?: string;
}

/**
 * Triage an inbound reply into a single category with a human-handoff flag.
 * Pure: no persistence, no provider calls.
 */
export function classifyInbound(
  input: InboundInput,
  client: LlmClient,
  opts?: AgentOptions,
): Promise<AgentResult<InboundClassification>> {
  return runAgent(client, {
    agentType: 'inbound_classify',
    system: INBOUND_CLASSIFY_SYSTEM_PROMPT,
    input,
    schema: InboundClassificationSchema,
    model: opts?.model,
    timeoutMs: opts?.timeoutMs,
  });
}
