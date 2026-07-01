/**
 * Service barrel — the REAL, fully unit-testable orchestration logic. Each
 * service takes an injected {@link Deps} and plain inputs, performs all side
 * effects + decisions + DB writes, and returns a plain result. No Temporal.
 */

export {
  researchProspectService,
  type ResearchProspectInput,
  type ResearchProspectResult,
} from './research.js';

export {
  outboundSequenceService,
  type OutboundSequenceInput,
  type OutboundSequenceResult,
  type OutboundOutcome,
} from './outbound.js';

export {
  inboundEmailService,
  type InboundEmailInput,
  type InboundEmailResult,
  type InboundOutcome,
} from './inbound.js';

export {
  sendApprovedDraft,
  type SendApprovedDraftInput,
  type SendApprovedDraftResult,
  type SendApprovedDraftOutcome,
} from './send.js';

export {
  recordTerminalFailure,
  type RecordTerminalFailureInput,
  type RecordTerminalFailureResult,
} from './dead-letter.js';

export {
  isValidIanaTimezone,
} from './tz.js';

export {
  confirmAndCreateCalendarEvent,
  proposeCalendarEvent,
  type ConfirmAndCreateInput,
  type ConfirmAndCreateResult,
  type ConfirmedSlot,
  type ProposeEventInput,
} from './calendar.js';

export {
  persistAgentRun,
  writeAudit,
  readBooleanSetting,
  prospectStatusFromResearch,
  toJson,
  type PersistAgentRunInput,
  type WriteAuditInput,
  type AgentRunRef,
} from './shared.js';
