/**
 * @app/workflows — durable Temporal orchestration.
 *
 * Barrel exporting the three workflows, the activity functions + their `typeof`
 * surface, the unit-testable services, the `Deps` type + factory, the research
 * provider, and the registration helpers the worker/api apps need (task queue
 * name, `workflowsPath`, and the `activities` object).
 */

import { fileURLToPath } from 'node:url';
import * as activities from './activities.js';

// --- Workflows (deterministic) ---
export {
  researchProspectWorkflow,
  outboundSequenceWorkflow,
  inboundEmailWorkflow,
  sendApprovedDraftWorkflow,
} from './workflows.js';

// --- Activities (thin side-effecting layer) ---
export {
  researchProspectActivity,
  outboundSequenceActivity,
  inboundEmailActivity,
  confirmCalendarEventActivity,
  sendApprovedDraftActivity,
  recordTerminalFailureActivity,
  setActivityDeps,
  type Activities,
} from './activities.js';

// --- Services (real logic, unit-testable) ---
export * from './services/index.js';

// --- Deps wiring ---
export {
  createDeps,
  asPrisma,
  type Deps,
  type CreateDepsOptions,
  type Clock,
} from './deps.js';

// --- Research provider (co-located) ---
export {
  createResearchProvider,
  MockResearchProvider,
  LiveResearchProvider,
  type ResearchProvider,
  type ResearchSource,
  type CompanyEnrichment,
  type PersonEnrichment,
  type PersonQuery,
} from './providers/research.js';

/** The Temporal task queue this package's workers/clients use. */
export const TASK_QUEUE = 'aiagent';

/**
 * Absolute path to the compiled workflows module, for `Worker.create({
 * workflowsPath })`. Resolves to `dist/workflows.js` at runtime.
 */
export const workflowsPath: string = fileURLToPath(new URL('./workflows.js', import.meta.url));

/** The activities object the worker registers (`Worker.create({ activities })`). */
export const workflowActivities = activities;

/** Deterministic workflow-id helpers (entity-keyed). */
export const workflowIds = {
  research: (prospectId: string): string => `research-${prospectId}`,
  outbound: (prospectId: string, sequenceId: string): string => `outbound-${prospectId}-${sequenceId}`,
  inbound: (key: string): string => `inbound-${key}`,
  sendDraft: (draftId: string): string => `send-draft-${draftId}`,
} as const;
