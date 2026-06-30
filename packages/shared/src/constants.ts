/**
 * Shared enum-like constant objects and their inferred types.
 *
 * These string values MUST stay aligned with the Prisma enums declared in
 * `packages/db/prisma/schema.prisma`. Downstream code may import either the
 * Prisma enum (runtime) or these constants (no DB dependency).
 */

/** Helper: derive a string-literal union from a `const` object's values. */
type ValueOf<T> = T[keyof T];

export const ProspectStatus = {
  NEW: 'new',
  RESEARCHING: 'researching',
  READY: 'ready',
  SEQUENCED: 'sequenced',
  ENGAGED: 'engaged',
  MEETING_BOOKED: 'meeting_booked',
  UNSUBSCRIBED: 'unsubscribed',
  BOUNCED: 'bounced',
  SUPPRESSED: 'suppressed',
  CLOSED: 'closed',
} as const;
export type ProspectStatus = ValueOf<typeof ProspectStatus>;

export const ResearchStatus = {
  RESEARCHED: 'researched',
  PARTIAL: 'partial',
  INSUFFICIENT: 'insufficient',
  NEEDS_REVIEW: 'needs_review',
} as const;
export type ResearchStatus = ValueOf<typeof ResearchStatus>;

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
export type DraftStatus = ValueOf<typeof DraftStatus>;

export const ApprovalType = {
  OUTREACH_SEND: 'outreach_send',
  REPLY_SEND: 'reply_send',
  SCHEDULE_MEETING: 'schedule_meeting',
  ESCALATION: 'escalation',
} as const;
export type ApprovalType = ValueOf<typeof ApprovalType>;

export const ApprovalStatus = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  AUTO_APPROVED: 'auto_approved',
} as const;
export type ApprovalStatus = ValueOf<typeof ApprovalStatus>;

export const CalendarEventStatus = {
  PROPOSED: 'proposed',
  TENTATIVE: 'tentative',
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
} as const;
export type CalendarEventStatus = ValueOf<typeof CalendarEventStatus>;

export const SuppressionReason = {
  UNSUBSCRIBE: 'unsubscribe',
  BOUNCE: 'bounce',
  COMPLAINT: 'complaint',
  MANUAL: 'manual',
  GLOBAL_BLOCK: 'global_block',
  COMPETITOR: 'competitor',
} as const;
export type SuppressionReason = ValueOf<typeof SuppressionReason>;

export const AgentType = {
  RESEARCH: 'research',
  OUTREACH: 'outreach',
  COMPLIANCE: 'compliance',
  INBOUND_CLASSIFIER: 'inbound_classifier',
  SCHEDULING_EXTRACTOR: 'scheduling_extractor',
  SCHEDULING_REPLY: 'scheduling_reply',
} as const;
export type AgentType = ValueOf<typeof AgentType>;

export const AgentRunStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  INVALID_OUTPUT: 'invalid_output',
  ESCALATED: 'escalated',
} as const;
export type AgentRunStatus = ValueOf<typeof AgentRunStatus>;

export const EmailDirection = {
  OUTBOUND: 'outbound',
  INBOUND: 'inbound',
} as const;
export type EmailDirection = ValueOf<typeof EmailDirection>;

export const ActorType = {
  SYSTEM: 'system',
  AGENT: 'agent',
  HUMAN: 'human',
  PROVIDER: 'provider',
} as const;
export type ActorType = ValueOf<typeof ActorType>;
