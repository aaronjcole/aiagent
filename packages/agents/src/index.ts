/**
 * @app/agents — the six LLM-backed agents.
 *
 * Agents RECOMMEND only: each takes typed inputs plus an `LlmClient`, builds a
 * disciplined prompt, calls the structured-output runner, and returns a
 * Zod-validated payload plus production metadata. They are PURE with respect to
 * side effects — no DB, no provider calls, no email/calendar. The
 * workflow/activity layer persists `AgentRun`/`AuditLog` rows and routes
 * escalations to human review.
 */

// Shared runner + result types.
export { runAgent } from './run-agent.js';
export type { AgentResult, AgentMeta, AgentTypeKey, RunAgentArgs } from './run-agent.js';

// System-prompt constants.
export {
  RESEARCH_SYSTEM_PROMPT,
  OUTREACH_SYSTEM_PROMPT,
  COMPLIANCE_SYSTEM_PROMPT,
  INBOUND_CLASSIFY_SYSTEM_PROMPT,
  SCHEDULING_EXTRACT_SYSTEM_PROMPT,
  SCHEDULING_REPLY_SYSTEM_PROMPT,
} from './prompts.js';

// Agents + their input types.
export { researchProspect } from './research.js';
export type {
  ResearchInput,
  ResearchProspect,
  ResearchCompany,
  ResearchSignal,
  AgentOptions,
} from './research.js';

export { draftOutreach } from './outreach.js';
export type { OutreachInput, SenderProfile } from './outreach.js';

export { reviewCompliance } from './compliance.js';
export type { ComplianceInput } from './compliance.js';

export { classifyInbound } from './inbound.js';
export type { InboundInput } from './inbound.js';

export { extractScheduling, draftSchedulingReply } from './scheduling.js';
export type {
  SchedulingExtractInput,
  SchedulingReplyInput,
  Availability,
} from './scheduling.js';
