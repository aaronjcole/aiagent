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
 *
 * Dead-letter handling: each workflow body is wrapped in a try/catch. A failure
 * that survives the activity's retry policy (or is non-retryable) is TERMINAL.
 * Before rethrowing (so Temporal still marks the run failed), we durably record
 * it via `recordTerminalFailureActivity`: a `workflow.terminal_failure` audit,
 * an ESCALATION ApprovalItem, and a `DeadLetter` row. The recording activity has
 * its own retry policy so the durable record is best-effort guaranteed.
 */

import { proxyActivities, workflowInfo } from '@temporalio/workflow';
import type { Activities } from './activities.js';
import type {
  ResearchProspectInput,
  ResearchProspectResult,
  OutboundSequenceInput,
  OutboundSequenceResult,
  InboundEmailInput,
  InboundEmailResult,
  SendApprovedDraftInput,
  SendApprovedDraftResult,
} from './services/index.js';

/** Errors that must never be retried (deterministic failures). */
const NON_RETRYABLE = ['ValidationError', 'PolicyViolationError', 'NotFoundError'];

const {
  researchProspectActivity,
  outboundSequenceActivity,
  inboundEmailActivity,
  sendApprovedDraftActivity,
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
 * The dead-letter recording activity gets its own (generous) retry policy: it is
 * the durability safety-net, so we retry it harder and never treat it as
 * non-retryable. It must succeed even when the primary activity failed terminally.
 */
const { recordTerminalFailureActivity } = proxyActivities<Activities>({
  startToCloseTimeout: '1 minute',
  scheduleToCloseTimeout: '5 minutes',
  retry: {
    maximumAttempts: 5,
    initialInterval: '1s',
    backoffCoefficient: 2,
  },
});

/** Extract a message from an unknown thrown value (deterministic-safe). */
function failureMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown workflow failure';
}

/**
 * Run a workflow body; on a TERMINAL failure record a dead-letter (audit +
 * ESCALATION + DeadLetter row) then rethrow so Temporal marks the run failed.
 */
async function withDeadLetter<T>(
  workflowType: string,
  input: unknown,
  body: () => Promise<T>,
): Promise<T> {
  try {
    return await body();
  } catch (error) {
    await recordTerminalFailureActivity({
      workflowType,
      workflowId: workflowInfo().workflowId,
      input,
      error: failureMessage(error),
    });
    throw error;
  }
}

/**
 * Research a prospect: gather context → agent → persist ResearchResult +
 * lifecycle status, or escalate to human review. Workflow id:
 * `research-<prospectId>`.
 */
export async function researchProspectWorkflow(
  input: ResearchProspectInput,
): Promise<ResearchProspectResult> {
  return withDeadLetter('researchProspectWorkflow', input, () =>
    researchProspectActivity(input),
  );
}

/**
 * Run one outbound sequence step: eligibility → draft → footer → compliance →
 * ordered gates → (auto-send | approval). Default is approval. Workflow id:
 * `outbound-<prospectId>-<sequenceId>`.
 */
export async function outboundSequenceWorkflow(
  input: OutboundSequenceInput,
): Promise<OutboundSequenceResult> {
  return withDeadLetter('outboundSequenceWorkflow', input, () =>
    outboundSequenceActivity(input),
  );
}

/**
 * Process an inbound email: dedup → persist → deterministic unsubscribe →
 * classify → exhaustive branch (suppress | scheduling | escalate | handled).
 * Workflow id: `inbound-<providerMessageId|threadId>`.
 */
export async function inboundEmailWorkflow(
  input: InboundEmailInput,
): Promise<InboundEmailResult> {
  return withDeadLetter('inboundEmailWorkflow', input, () =>
    inboundEmailActivity(input),
  );
}

/**
 * Send a human-APPROVED draft (gated on SENDING_ENABLED + the human approval).
 * Auto-send stays off; this is the explicit human-in-the-loop SEND path.
 * Workflow id: `send-draft-<draftId>`.
 */
export async function sendApprovedDraftWorkflow(
  input: SendApprovedDraftInput,
): Promise<SendApprovedDraftResult> {
  return withDeadLetter('sendApprovedDraftWorkflow', input, () =>
    sendApprovedDraftActivity(input),
  );
}
