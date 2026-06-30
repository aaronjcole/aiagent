/**
 * Shared enum-like constant objects and their inferred types.
 *
 * These string values MUST stay aligned with the Prisma enums declared in
 * `packages/db/prisma/schema.prisma`. Downstream code may import either the
 * Prisma enum (runtime) or these constants (no DB dependency).
 */

/** Helper: derive a string-literal union from a `const` object's values. */
type ValueOf<T> = T[keyof T];

/** Lifecycle states a prospect moves through, from intake to close. */
export const ProspectStatus = {
  NEW: 'new',
  RESEARCHING: 'researching',
  RESEARCHED: 'researched',
  PARTIAL: 'partial',
  INSUFFICIENT: 'insufficient',
  NEEDS_REVIEW: 'needs_review',
  READY: 'ready',
  SEQUENCED: 'sequenced',
  ENGAGED: 'engaged',
  MEETING_BOOKED: 'meeting_booked',
  UNSUBSCRIBED: 'unsubscribed',
  BOUNCED: 'bounced',
  SUPPRESSED: 'suppressed',
  CLOSED: 'closed',
} as const;
/** String-literal union of {@link ProspectStatus} values. */
export type ProspectStatus = ValueOf<typeof ProspectStatus>;

/** Outcome of the research stage for a prospect. */
export const ResearchStatus = {
  RESEARCHED: 'researched',
  PARTIAL: 'partial',
  INSUFFICIENT: 'insufficient',
  NEEDS_REVIEW: 'needs_review',
} as const;
/** String-literal union of {@link ResearchStatus} values. */
export type ResearchStatus = ValueOf<typeof ResearchStatus>;

/** Lifecycle of an outbound draft email from creation through send/failure. */
export const DraftStatus = {
  DRAFT: 'draft',
  PENDING_REVIEW: 'pending_review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  SCHEDULED: 'scheduled',
  SENT: 'sent',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;
/** String-literal union of {@link DraftStatus} values. */
export type DraftStatus = ValueOf<typeof DraftStatus>;

/** Kinds of action that can require human approval. */
export const ApprovalType = {
  OUTREACH_SEND: 'outreach_send',
  REPLY_SEND: 'reply_send',
  SCHEDULE_MEETING: 'schedule_meeting',
  ESCALATION: 'escalation',
} as const;
/** String-literal union of {@link ApprovalType} values. */
export type ApprovalType = ValueOf<typeof ApprovalType>;

/** Resolution state of an approval request. */
export const ApprovalStatus = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  AUTO_APPROVED: 'auto_approved',
} as const;
/** String-literal union of {@link ApprovalStatus} values. */
export type ApprovalStatus = ValueOf<typeof ApprovalStatus>;

/** State of a proposed or booked calendar meeting. */
export const CalendarEventStatus = {
  PROPOSED: 'proposed',
  TENTATIVE: 'tentative',
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
} as const;
/** String-literal union of {@link CalendarEventStatus} values. */
export type CalendarEventStatus = ValueOf<typeof CalendarEventStatus>;

/** Why an email/domain was added to the suppression list. */
export const SuppressionReason = {
  UNSUBSCRIBE: 'unsubscribe',
  BOUNCE: 'bounce',
  COMPLAINT: 'complaint',
  MANUAL: 'manual',
  GLOBAL_BLOCK: 'global_block',
  COMPETITOR: 'competitor',
} as const;
/** String-literal union of {@link SuppressionReason} values. */
export type SuppressionReason = ValueOf<typeof SuppressionReason>;

/** The distinct LLM agents in the pipeline. */
export const AgentType = {
  RESEARCH: 'research',
  OUTREACH: 'outreach',
  COMPLIANCE: 'compliance',
  INBOUND_CLASSIFIER: 'inbound_classifier',
  SCHEDULING_EXTRACTOR: 'scheduling_extractor',
  SCHEDULING_REPLY: 'scheduling_reply',
} as const;
/** String-literal union of {@link AgentType} values. */
export type AgentType = ValueOf<typeof AgentType>;

/** Outcome state of a single agent run. */
export const AgentRunStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  INVALID_OUTPUT: 'invalid_output',
  ESCALATED: 'escalated',
} as const;
/** String-literal union of {@link AgentRunStatus} values. */
export type AgentRunStatus = ValueOf<typeof AgentRunStatus>;

/** Direction of an email message relative to our system. */
export const EmailDirection = {
  OUTBOUND: 'outbound',
  INBOUND: 'inbound',
} as const;
/** String-literal union of {@link EmailDirection} values. */
export type EmailDirection = ValueOf<typeof EmailDirection>;

/** Who or what performed an audited action. */
export const ActorType = {
  SYSTEM: 'system',
  AGENT: 'agent',
  HUMAN: 'human',
  PROVIDER: 'provider',
} as const;
/** String-literal union of {@link ActorType} values. */
export type ActorType = ValueOf<typeof ActorType>;

/** Resolution state of a dead-lettered (failed) work item. */
export const DeadLetterStatus = {
  OPEN: 'open',
  RESOLVED: 'resolved',
} as const;
/** String-literal union of {@link DeadLetterStatus} values. */
export type DeadLetterStatus = ValueOf<typeof DeadLetterStatus>;
