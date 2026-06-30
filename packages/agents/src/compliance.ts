import { ComplianceReviewSchema, type ComplianceReview, type ResearchOutput } from '@app/shared';
import type { LlmClient } from '@app/llm';
import { COMPLIANCE_SYSTEM_PROMPT } from './prompts.js';
import { runAgent, type AgentResult } from './run-agent.js';
import type { AgentOptions, ResearchProspect } from './research.js';

/** Input for {@link reviewCompliance}. */
export interface ComplianceInput {
  draftSubject: string;
  draftBody: string;
  prospect: ResearchProspect;
  research?: ResearchOutput;
  policySummary: string;
}

/**
 * LLM compliance reviewer. Returns a validated `ComplianceReview` verdict; the
 * deterministic gates in `@app/compliance` consume it. Pure: no persistence, no
 * provider calls.
 */
export function reviewCompliance(
  input: ComplianceInput,
  client: LlmClient,
  opts?: AgentOptions,
): Promise<AgentResult<ComplianceReview>> {
  return runAgent(client, {
    agentType: 'compliance',
    system: COMPLIANCE_SYSTEM_PROMPT,
    input,
    schema: ComplianceReviewSchema,
    model: opts?.model,
    timeoutMs: opts?.timeoutMs,
  });
}
