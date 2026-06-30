/**
 * Temporal activities — the THIN side-effecting layer. Each activity builds (or
 * receives) a real {@link Deps} and delegates to a service function. Activities
 * are the only place side effects happen from Temporal's view; all branching,
 * gate evaluation, and DB writes live in the services. Workflow code never
 * imports this module's implementations directly — only its `typeof` for the
 * proxy.
 */

import { createDeps, type Deps } from './deps.js';
import {
  researchProspectService,
  outboundSequenceService,
  inboundEmailService,
  confirmAndCreateCalendarEvent,
  sendApprovedDraft,
  recordTerminalFailure,
  type ResearchProspectInput,
  type ResearchProspectResult,
  type OutboundSequenceInput,
  type OutboundSequenceResult,
  type InboundEmailInput,
  type InboundEmailResult,
  type ConfirmAndCreateInput,
  type ConfirmAndCreateResult,
  type SendApprovedDraftInput,
  type SendApprovedDraftResult,
  type RecordTerminalFailureInput,
  type RecordTerminalFailureResult,
} from './services/index.js';

/**
 * Lazily-built, process-wide Deps for the worker. Built once on first activity
 * invocation from `loadConfig()` + the real provider/llm/prisma factories.
 */
let cachedDeps: Deps | undefined;

async function getDeps(): Promise<Deps> {
  if (!cachedDeps) {
    cachedDeps = await createDeps();
  }
  return cachedDeps;
}

/**
 * Override the module-level Deps (used by the worker app to inject a shared
 * logger/prisma, or by integration tests). Call before the first activity runs.
 */
export function setActivityDeps(deps: Deps): void {
  cachedDeps = deps;
}

/** Activity: run the full research flow for a prospect. */
export async function researchProspectActivity(
  input: ResearchProspectInput,
): Promise<ResearchProspectResult> {
  return researchProspectService(await getDeps(), input);
}

/** Activity: run a single outbound sequence step. */
export async function outboundSequenceActivity(
  input: OutboundSequenceInput,
): Promise<OutboundSequenceResult> {
  return outboundSequenceService(await getDeps(), input);
}

/** Activity: process a single inbound email. */
export async function inboundEmailActivity(
  input: InboundEmailInput,
): Promise<InboundEmailResult> {
  return inboundEmailService(await getDeps(), input);
}

/** Activity: confirm a PROPOSED calendar event and create the provider event. */
export async function confirmCalendarEventActivity(
  input: ConfirmAndCreateInput,
): Promise<ConfirmAndCreateResult> {
  return confirmAndCreateCalendarEvent(await getDeps(), input);
}

/** Activity: send a human-APPROVED draft (gated on SENDING_ENABLED + approval). */
export async function sendApprovedDraftActivity(
  input: SendApprovedDraftInput,
): Promise<SendApprovedDraftResult> {
  return sendApprovedDraft(await getDeps(), input);
}

/** Activity: durably record a terminal workflow failure (dead-letter). */
export async function recordTerminalFailureActivity(
  input: RecordTerminalFailureInput,
): Promise<RecordTerminalFailureResult> {
  return recordTerminalFailure(await getDeps(), input);
}

/** The activity surface registered by the worker; also the `typeof` proxied. */
export type Activities = {
  researchProspectActivity: typeof researchProspectActivity;
  outboundSequenceActivity: typeof outboundSequenceActivity;
  inboundEmailActivity: typeof inboundEmailActivity;
  confirmCalendarEventActivity: typeof confirmCalendarEventActivity;
  sendApprovedDraftActivity: typeof sendApprovedDraftActivity;
  recordTerminalFailureActivity: typeof recordTerminalFailureActivity;
};
