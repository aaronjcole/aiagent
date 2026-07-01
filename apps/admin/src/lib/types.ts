/**
 * Local, structural types for the entities the admin UI renders.
 *
 * The admin is a thin HTTP client for `@app/api`; it does NOT import `@app/db`.
 * These types mirror the relevant fields of the Prisma models as exposed by the
 * API JSON responses. Enum string-literal unions are imported from `@app/shared`
 * (no runtime/db dependency) where helpful, but everything here stays optional
 * and tolerant of extra/missing fields so the UI degrades gracefully.
 */
import type {
  ProspectStatus,
  ResearchStatus,
  DraftStatus,
  ApprovalType,
  ApprovalStatus,
  SuppressionReason,
  EmailDirection,
  EmailAutonomyMode,
  CalendarAutonomyMode,
} from '@app/shared';

/** Any JSON value returned by the API. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A sales prospect as exposed by the API. */
export interface Prospect {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  title?: string | null;
  companyId?: string | null;
  companyName?: string | null;
  companyDomain?: string | null;
  status: ProspectStatus | string;
  createdAt?: string;
  updatedAt?: string;
}

/** A cited source backing a research result. */
export interface ResearchSource {
  title?: string;
  url?: string;
  snippet?: string;
}

/** Structured output produced by the research agent. */
export interface ResearchOutput {
  status?: ResearchStatus | string;
  summary?: string;
  companyInsights?: string;
  personalizationPoints?: Array<{ point: string; evidence?: string; sourceUrl?: string | null }>;
  sources?: ResearchSource[];
  dataGaps?: string[];
  confidence?: number;
  riskFlags?: string[];
}

/** A persisted research result row for a prospect. */
export interface ResearchResult {
  id: string;
  prospectId: string;
  status: ResearchStatus | string;
  confidence?: number | null;
  summary?: string | null;
  output?: ResearchOutput | null;
  createdAt?: string;
}

/** A draft email (outreach or reply) awaiting review/approval/send. */
export interface DraftEmail {
  id: string;
  prospectId?: string | null;
  threadId?: string | null;
  status: DraftStatus | string;
  subject?: string | null;
  bodyText?: string | null;
  body?: string | null;
  toEmail?: string | null;
  fromEmail?: string | null;
  complianceFlags?: Json;
  createdAt?: string;
}

/** A human-in-the-loop approval item, optionally linked to a draft. */
export interface ApprovalItem {
  id: string;
  type: ApprovalType | string;
  status: ApprovalStatus | string;
  prospectId?: string | null;
  draftId?: string | null;
  draft?: DraftEmail | null;
  reason?: string | null;
  payload?: Json;
  createdAt?: string;
}

/** A single message within an email thread. */
export interface EmailMessage {
  id: string;
  threadId?: string | null;
  direction: EmailDirection | string;
  fromEmail?: string | null;
  toEmail?: string | null;
  subject?: string | null;
  bodyText?: string | null;
  providerMessageId?: string | null;
  createdAt?: string;
  receivedAt?: string | null;
}

/** An email thread with its prospect, classification, and messages. */
export interface EmailThread {
  id: string;
  subject?: string | null;
  prospectId?: string | null;
  providerThreadId?: string | null;
  classification?: string | null;
  requiresHuman?: boolean | null;
  messages?: EmailMessage[];
  createdAt?: string;
}

/** A suppression-list entry blocking sends to an email or domain. */
export interface SuppressionEntry {
  id: string;
  email?: string | null;
  domain?: string | null;
  reason?: SuppressionReason | string | null;
  notes?: string | null;
  createdAt?: string;
}

/** An audit-log row recording a system or human decision. */
export interface AuditLog {
  id: string;
  entityType?: string | null;
  entityId?: string | null;
  action?: string | null;
  actorType?: string | null;
  actor?: string | null;
  allowed?: boolean | null;
  reason?: string | null;
  metadata?: Json;
  createdAt?: string;
}

/** A configurable system setting (key/value with optional metadata). */
export interface SystemSetting {
  key: string;
  value: Json;
  description?: string | null;
  updatedAt?: string;
}

/** An outreach sequence definition. */
export interface OutreachSequence {
  id: string;
  name?: string | null;
  maxSteps?: number | null;
}

/**
 * Re-export the canonical autonomy ladders from `@app/shared` so the admin UI
 * uses the single source of truth (type-only; can't drift from a hand-mirrored
 * copy).
 */
export type { EmailAutonomyMode, CalendarAutonomyMode };

/**
 * Live automation counts from `GET /automation/counts`. All fields optional so
 * the UI degrades gracefully if the endpoint/contract is incomplete.
 */
export interface AutomationCounts {
  globalSentToday?: number;
  calendarEventsToday?: number;
}

/**
 * Draft fields relevant to the controlled-autonomy phase. Extends {@link DraftEmail}
 * with the policy-eligibility fields the API may attach (`GET /drafts/:id`).
 */
export interface DraftPolicyInfo {
  autoSendEligible?: boolean;
  denialReasons?: string[];
}

/** A draft as returned by `GET /drafts/:id`, including optional policy info. */
export type DraftWithPolicy = DraftEmail & DraftPolicyInfo;
