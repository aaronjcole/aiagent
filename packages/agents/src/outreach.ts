import { OutreachDraftSchema, type OutreachDraft, type ResearchOutput } from '@app/shared';
import type { LlmClient } from '@app/llm';
import { OUTREACH_SYSTEM_PROMPT } from './prompts.js';
import { runAgent, type AgentResult } from './run-agent.js';
import type { AgentOptions, ResearchCompany, ResearchProspect } from './research.js';

/** Identity/voice of the sender the draft is written as. */
export interface SenderProfile {
  name: string;
  email: string;
  title?: string;
  company?: string;
  valueProposition?: string;
}

/** Input for {@link draftOutreach}. */
export interface OutreachInput {
  prospect: ResearchProspect;
  company?: ResearchCompany;
  research: ResearchOutput;
  sequenceStep: number;
  senderProfile: SenderProfile;
}

/**
 * Draft a personalized outreach email grounded in the research briefing. Pure:
 * no persistence, no send.
 */
export function draftOutreach(
  input: OutreachInput,
  client: LlmClient,
  opts?: AgentOptions,
): Promise<AgentResult<OutreachDraft>> {
  return runAgent(client, {
    agentType: 'outreach',
    system: OUTREACH_SYSTEM_PROMPT,
    input,
    schema: OutreachDraftSchema,
    model: opts?.model,
    timeoutMs: opts?.timeoutMs,
  });
}
