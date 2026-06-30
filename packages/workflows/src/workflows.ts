/**
 * Temporal workflow definitions. Deterministic: NO direct imports of db,
 * providers, or agents — only activity proxies (built from `typeof activities`)
 * and pure helpers. All side effects + decisions live in the activities/
 * services these proxy to.
 *
 * Each workflow proxies one coarse activity that performs the full, idempotent
 * flow. Keeping the orchestration inside an activity (which writes its own audit
 * + idempotency rows) makes replay safe and the logic unit-testable without a
 * Temporal server. The workflow layer owns retry/timeout policy and entity-keyed
 * workflow ids.
 */

import { proxyActivities } from '@temporalio/workflow';
import type { Activities } from './activities.js';
import type {
  ResearchProspectInput,
  ResearchProspectResult,
  OutboundSequenceInput,
  OutboundSequenceResult,
  InboundEmailInput,
  InboundEmailResult,
} from './services/index.js';

/** Errors that must never be retried (deterministic failures). */
const NON_RETRYABLE = ['ValidationError', 'PolicyViolationError', 'NotFoundError'];

const {
  researchProspectActivity,
  outboundSequenceActivity,
  inboundEmailActivity,
} = proxyActivities<Activities>({
  startToCloseTimeout: '2 minutes',
  scheduleToCloseTimeout: '10 minutes',
  retry: {
    maximumAttempts: 3,
    initialInterval: '1s',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: NON_RETRYABLE,
  },
});

/**
 * Research a prospect: gather context → agent → persist ResearchResult +
 * lifecycle status, or escalate to human review. Workflow id:
 * `research-<prospectId>`.
 */
export async function researchProspectWorkflow(
  input: ResearchProspectInput,
): Promise<ResearchProspectResult> {
  return researchProspectActivity(input);
}

/**
 * Run one outbound sequence step: eligibility → draft → footer → compliance →
 * ordered gates → (auto-send | approval). Default is approval. Workflow id:
 * `outbound-<prospectId>-<sequenceId>`.
 */
export async function outboundSequenceWorkflow(
  input: OutboundSequenceInput,
): Promise<OutboundSequenceResult> {
  return outboundSequenceActivity(input);
}

/**
 * Process an inbound email: dedup → persist → deterministic unsubscribe →
 * classify → exhaustive branch (suppress | scheduling | escalate | handled).
 * Workflow id: `inbound-<providerMessageId|threadId>`.
 */
export async function inboundEmailWorkflow(
  input: InboundEmailInput,
): Promise<InboundEmailResult> {
  return inboundEmailActivity(input);
}
