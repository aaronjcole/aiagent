import { ResearchOutputSchema, type ResearchOutput } from '@app/shared';
import type { LlmClient } from '@app/llm';
import { RESEARCH_SYSTEM_PROMPT } from './prompts.js';
import { runAgent, type AgentResult } from './run-agent.js';

/** Minimal prospect identity the research agent reasons over (DB-free). */
export interface ResearchProspect {
  email: string;
  name?: string;
  title?: string;
  companyName?: string;
}

/** Minimal company context (DB-free). */
export interface ResearchCompany {
  name?: string;
  domain?: string;
  industry?: string;
  description?: string;
}

/** A raw source/snippet the research provider gathered. */
export interface ResearchSignal {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Input for {@link researchProspect}. Carries whatever the research provider
 * already gathered (enrichment + search snippets); the agent only summarizes and
 * structures it — it never accesses the web itself.
 */
export interface ResearchInput {
  prospect: ResearchProspect;
  company?: ResearchCompany;
  signals?: ResearchSignal[];
  webContext?: string;
}

/** Optional per-call overrides. */
export interface AgentOptions {
  model?: string;
  timeoutMs?: number;
}

/**
 * Summarize and structure gathered research into a validated `ResearchOutput`.
 * Pure: performs no web calls and no persistence.
 */
export function researchProspect(
  input: ResearchInput,
  client: LlmClient,
  opts?: AgentOptions,
): Promise<AgentResult<ResearchOutput>> {
  return runAgent(client, {
    agentType: 'research',
    system: RESEARCH_SYSTEM_PROMPT,
    input,
    schema: ResearchOutputSchema,
    model: opts?.model,
    timeoutMs: opts?.timeoutMs,
  });
}
