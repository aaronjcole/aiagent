/**
 * Narrow repository interfaces and plain input/output types for the
 * deterministic compliance core.
 *
 * Every database dependency is expressed as a *narrow* interface describing
 * exactly the queries this package needs. Prisma-backed implementations live in
 * `repos.ts`; unit tests pass in-memory fakes. Nothing in this package ever
 * talks to a real database directly.
 */

import type {
  ResearchStatus as ResearchStatusType,
  SuppressionReason as SuppressionReasonType,
} from '@app/shared';

/**
 * A suppression entry as far as the compliance core cares about it. This is a
 * structural subset of the Prisma `SuppressionEntry` model so that the Prisma
 * row satisfies it directly while tests can build minimal fakes.
 */
export interface SuppressionEntryLike {
  email: string | null;
  domain: string | null;
  reason: SuppressionReasonType;
  source: string | null;
  notes: string | null;
}

/** Lookup of suppression entries by exact email or by domain. */
export interface SuppressionRepo {
  /** Return the entry whose `email` matches (case-insensitive), or null. */
  findByEmail(email: string): Promise<SuppressionEntryLike | null>;
  /** Return the entry whose `domain` matches (case-insensitive), or null. */
  findByDomain(domain: string): Promise<SuppressionEntryLike | null>;
  /**
   * Idempotently create or return a suppression entry keyed by email/domain.
   * Re-adding the same email/domain must NOT create a duplicate.
   */
  upsert(input: AddSuppressionInput): Promise<SuppressionEntryLike>;
}

/** Input for {@link SuppressionRepo.upsert} / addSuppression. */
export interface AddSuppressionInput {
  email?: string;
  domain?: string;
  reason: SuppressionReasonType;
  source: string;
  notes?: string;
}

/** Counts of outbound sends used to enforce rolling 24h sending caps. */
export interface SendCountRepo {
  /** Total outbound messages sent across all inboxes in the last 24h. */
  countGlobalSentLast24h(): Promise<number>;
  /** Outbound messages sent from a specific inbox (fromEmail) in the last 24h. */
  countByInboxLast24h(fromEmail: string): Promise<number>;
  /** Outbound messages sent to a specific recipient domain in the last 24h. */
  countByDomainLast24h(domain: string): Promise<number>;
  /**
   * Number of outbound steps already sent for a prospect within a sequence
   * (used to enforce the per-prospect sequence step limit). When `sequenceId`
   * is omitted, counts steps for the prospect across sequences.
   */
  countSequenceStepsSent(prospectId: string, sequenceId?: string): Promise<number>;
}

/**
 * Prior inbound reply signals for a prospect/thread used by eligibility checks.
 * Implementations derive these from persisted classifications/replies.
 */
export interface ReplyHistoryRepo {
  /** True if the prospect has previously unsubscribed. */
  hasUnsubscribed(prospectId: string): Promise<boolean>;
  /** True if the prospect previously sent a negative / not-interested reply. */
  hasNegativeReply(prospectId: string): Promise<boolean>;
}

/**
 * Plain reply-history snapshot for the pure {@link checkEligibility} function.
 * (The repo above is for async orchestration; eligibility is fully pure.)
 */
export interface ReplyHistorySnapshot {
  unsubscribed: boolean;
  /** A NOT_INTERESTED / negative reply has been received from this prospect. */
  negativeReply: boolean;
}

/** Minimal prospect shape the deterministic checks read. */
export interface ProspectLike {
  id: string;
  email: string | null;
  status?: string;
}

/** Minimal research shape the eligibility check reads. */
export interface ResearchLike {
  status: ResearchStatusType;
}

/** Result of a suppression lookup. */
export interface SuppressionResult {
  suppressed: boolean;
  entry?: SuppressionEntryLike;
  /** Which key matched, when suppressed. */
  matchedOn?: 'email' | 'domain';
}

/** Per-cap usage counts returned by {@link checkSendingCaps}. */
export interface SendingCapCounts {
  global: number;
  inbox: number;
  domain: number;
  sequenceSteps: number;
}

/** Subset of {@link import('@app/shared').Config} the caps check needs. */
export interface SendingCapConfig {
  dailySendCap: number;
  perInboxDailyCap: number;
  perDomainDailyCap: number;
  sequenceMaxSteps: number;
}

/** Subset of config needed to build the CAN-SPAM footer. */
export interface FooterConfig {
  unsubscribeBaseUrl: string;
  companyAddress: string;
}

/** A single gate's outcome in the ordered outbound safety sequence. */
export interface GateDecision {
  gate: string;
  passed: boolean;
  reason: string;
}

/** Result of running the full ordered outbound gate sequence. */
export interface OutboundGateResult {
  allowed: boolean;
  decisions: GateDecision[];
  requiresApproval: boolean;
  canAutoSend: boolean;
}
