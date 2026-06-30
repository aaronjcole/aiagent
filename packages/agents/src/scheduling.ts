import {
  SchedulingExtractionSchema,
  SchedulingReplyDraftSchema,
  type InboundClassification,
  type SchedulingExtraction,
  type SchedulingReplyDraft,
  type TimeSlot,
} from '@app/shared';
import type { LlmClient } from '@app/llm';
import {
  SCHEDULING_EXTRACT_SYSTEM_PROMPT,
  SCHEDULING_REPLY_SYSTEM_PROMPT,
} from './prompts.js';
import { runAgent, type AgentResult } from './run-agent.js';
import type { AgentOptions } from './research.js';

/** Input for {@link extractScheduling}. */
export interface SchedulingExtractInput {
  subject: string;
  body: string;
  threadContext?: string;
  nowIso: string;
  defaultTimezone?: string;
}

/**
 * Extract meeting-scheduling intent and proposed times from an inbound email,
 * resolving relative times against `nowIso`. Pure: no persistence, no calendar
 * access.
 */
export function extractScheduling(
  input: SchedulingExtractInput,
  client: LlmClient,
  opts?: AgentOptions,
): Promise<AgentResult<SchedulingExtraction>> {
  return runAgent(client, {
    agentType: 'scheduling_extract',
    system: SCHEDULING_EXTRACT_SYSTEM_PROMPT,
    input,
    schema: SchedulingExtractionSchema,
    model: opts?.model,
    timeoutMs: opts?.timeoutMs,
  });
}

/** Free slots the reply agent may offer. */
export interface Availability {
  freeSlots: TimeSlot[];
}

/** Input for {@link draftSchedulingReply}. */
export interface SchedulingReplyInput {
  classification: InboundClassification;
  extraction: SchedulingExtraction;
  availability?: Availability;
  nowIso: string;
}

/**
 * Draft a scheduling reply (propose / confirm / clarify / escalate) grounded in
 * the provided availability and extraction. Pure: no persistence, no send.
 */
export function draftSchedulingReply(
  input: SchedulingReplyInput,
  client: LlmClient,
  opts?: AgentOptions,
): Promise<AgentResult<SchedulingReplyDraft>> {
  return runAgent(client, {
    agentType: 'scheduling_reply',
    system: SCHEDULING_REPLY_SYSTEM_PROMPT,
    input,
    schema: SchedulingReplyDraftSchema,
    model: opts?.model,
    timeoutMs: opts?.timeoutMs,
  });
}
