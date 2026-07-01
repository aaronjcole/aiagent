/**
 * Prisma-backed implementations of the narrow compliance repository interfaces.
 *
 * These are the ONLY place in the package that touches a real database. The
 * deterministic checks depend on the interfaces in `types.ts`, so unit tests
 * substitute in-memory fakes and never need Postgres.
 */

import type { Prisma, PrismaClient } from '@app/db';
import { DraftStatus, EmailDirection } from '@app/shared';
import type {
  AddSuppressionInput,
  CapRepo,
  ReplyHistoryRepo,
  SendCountRepo,
  SuppressionEntryLike,
  SuppressionRepo,
} from './types.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** The timestamp 24 hours before `now`, the lower bound of the rolling window. */
function since24h(now: Date = new Date()): Date {
  return new Date(now.getTime() - MS_PER_DAY);
}

/** Suppression lookups + idempotent upsert backed by `SuppressionEntry`. */
export function createSuppressionRepo(prisma: PrismaClient): SuppressionRepo {
  return {
    async findByEmail(email: string): Promise<SuppressionEntryLike | null> {
      return prisma.suppressionEntry.findUnique({
        where: { email: email.trim().toLowerCase() },
      });
    },
    async findByDomain(domain: string): Promise<SuppressionEntryLike | null> {
      return prisma.suppressionEntry.findUnique({
        where: { domain: domain.trim().toLowerCase() },
      });
    },
    async upsert(input: AddSuppressionInput): Promise<SuppressionEntryLike> {
      const email = input.email?.trim().toLowerCase();
      const domain = input.domain?.trim().toLowerCase();

      // Email-keyed entries take precedence; otherwise key by domain. The
      // `@unique` constraints on email/domain make this idempotent.
      if (email) {
        return prisma.suppressionEntry.upsert({
          where: { email },
          create: {
            email,
            domain: domain ?? null,
            reason: input.reason,
            source: input.source,
            notes: input.notes ?? null,
          },
          update: {
            reason: input.reason,
            source: input.source,
            notes: input.notes ?? null,
          },
        });
      }

      // domain is guaranteed present here (validated in addSuppression).
      return prisma.suppressionEntry.upsert({
        where: { domain: domain as string },
        create: {
          email: null,
          domain: domain as string,
          reason: input.reason,
          source: input.source,
          notes: input.notes ?? null,
        },
        update: {
          reason: input.reason,
          source: input.source,
          notes: input.notes ?? null,
        },
      });
    },
  };
}

/**
 * Rolling 24h send counts + per-prospect sequence step counts, derived from
 * sent outbound `EmailMessage` rows (joined to drafts for sequence attribution).
 */
export function createSendCountRepo(prisma: PrismaClient): SendCountRepo {
  return {
    async countGlobalSentLast24h(): Promise<number> {
      return prisma.emailMessage.count({
        where: { direction: EmailDirection.OUTBOUND, sentAt: { gte: since24h() } },
      });
    },
    async countByInboxLast24h(fromEmail: string): Promise<number> {
      return prisma.emailMessage.count({
        where: {
          direction: EmailDirection.OUTBOUND,
          sentAt: { gte: since24h() },
          fromEmail: fromEmail.trim().toLowerCase(),
        },
      });
    },
    async countByDomainLast24h(domain: string): Promise<number> {
      return prisma.emailMessage.count({
        where: {
          direction: EmailDirection.OUTBOUND,
          sentAt: { gte: since24h() },
          toEmail: { endsWith: `@${domain.trim().toLowerCase()}` },
        },
      });
    },
    async countSequenceStepsSent(prospectId: string, sequenceId?: string): Promise<number> {
      // Count sent outbound drafts for this prospect (optionally within one
      // sequence) as the proxy for completed sequence steps.
      return prisma.draftEmail.count({
        where: {
          prospectId,
          direction: EmailDirection.OUTBOUND,
          sentAt: { not: null },
          ...(sequenceId ? { sequenceId } : {}),
        },
      });
    },
    async countProspectSentTotal(prospectId: string): Promise<number> {
      // All-time outbound sends to this prospect across every sequence.
      return prisma.draftEmail.count({
        where: {
          prospectId,
          direction: EmailDirection.OUTBOUND,
          status: DraftStatus.SENT,
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Controlled-autonomy cap accounting (AuditLog-backed)
// ---------------------------------------------------------------------------

/**
 * Canonical audit `action` values that COUNT toward the send caps.
 *
 * Every real autonomous send — a fresh outbound send AND an inbound
 * booking-confirmation reply — must count toward the global/sender/domain send
 * caps. Confirmation replies are logged as `email.reply`, so both actions are
 * counted here (fixes CORR-N2/SAFE-1: `email.reply` was previously invisible to
 * the send caps). `email.send` and `email.reply` are treated identically for
 * send-cap accounting.
 */
export const SEND_CAP_ACTIONS = ['email.send', 'email.reply'] as const;
/** Audit `action` for autonomous inbound replies (per-thread reply cap). */
export const REPLY_ACTION = 'email.reply';
/** Audit `action` for autonomous calendar creations. */
export const CALENDAR_ACTION = 'calendar.create';

/**
 * REQUIRED metadata shape that EVERY send/reply/confirmation audit row must
 * carry so the cap counters are consistent across all send paths.
 *
 * The workflows round MUST populate all three on every `email.send` /
 * `email.reply` audit it writes (outbound-auto, human-approved, and
 * inbound-confirmation), and set the audit row's top-level `idempotencyKey`
 * column to the same value used here so distinct-key dedup works:
 *  - `senderEmail`     — normalized (lowercased) sending address; per-sender cap.
 *  - `recipientDomain` — normalized recipient domain; per-domain cap.
 *  - `idempotencyKey`  — the send's idempotency key; distinct-key dedup so a
 *                        Temporal at-least-once retry does not over-count.
 */
export interface SendAuditMetadata {
  /** Normalized (lowercased) sending account address. */
  senderEmail: string;
  /** Normalized (lowercased) recipient domain. */
  recipientDomain: string;
  /** Idempotency key for this send (also stored in the AuditLog column). */
  idempotencyKey: string;
}

/**
 * Count DISTINCT audit rows over a `where`, deduping by the audit row's
 * `idempotencyKey` COLUMN so Temporal at-least-once retries (which can write a
 * fresh audit row for an already-committed action) do not over-count (CORR-6).
 * Used for send, per-thread reply, and calendar cap accounting.
 *
 * Rows WITHOUT an `idempotencyKey` are counted individually (conservative — a
 * missing key cannot be deduped, so it counts as one). Rows WITH a key collapse
 * to one per distinct key.
 */
async function countDistinctSends(
  prisma: Pick<PrismaClient, 'auditLog'>,
  where: Prisma.AuditLogWhereInput,
): Promise<number> {
  const rows = await prisma.auditLog.findMany({
    where,
    select: { idempotencyKey: true },
  });
  let nullKeyRows = 0;
  const distinctKeys = new Set<string>();
  for (const r of rows) {
    if (r.idempotencyKey == null || r.idempotencyKey === '') nullKeyRows += 1;
    else distinctKeys.add(r.idempotencyKey);
  }
  return distinctKeys.size + nullKeyRows;
}

/**
 * Controlled-autonomy cap counts, derived from `AuditLog` action rows over a
 * rolling 24h window. Autonomous actions are recorded as allowed audit rows:
 *  - `email.send` / `email.reply` (allowed=true) → count as an autonomous send,
 *  - `email.reply`   (allowed=true) → also counts as an autonomous THREAD reply,
 *  - `calendar.create` (allowed=true) → counts as a calendar creation.
 * The `metadata` carries {@link SendAuditMetadata} (senderEmail, recipientDomain,
 * idempotencyKey); the top-level `idempotencyKey` column dedupes retries.
 */
export function createCapRepo(prisma: PrismaClient): CapRepo {
  return {
    async countGlobalSentToday(): Promise<number> {
      return countDistinctSends(prisma, {
        action: { in: [...SEND_CAP_ACTIONS] },
        allowed: true,
        createdAt: { gte: since24h() },
      });
    },
    async countSenderSentToday(senderEmail: string): Promise<number> {
      return countDistinctSends(prisma, {
        action: { in: [...SEND_CAP_ACTIONS] },
        allowed: true,
        createdAt: { gte: since24h() },
        metadata: { path: ['senderEmail'], equals: senderEmail.trim().toLowerCase() },
      });
    },
    async countDomainSentToday(domain: string): Promise<number> {
      // INDEX NOTE (per-domain cap — CORR-H3/H4): the per-domain cap counts
      // `AuditLog` rows by (action IN SEND_CAP_ACTIONS, allowed=true,
      // createdAt >= now-24h) AND a `metadata.recipientDomain` JSON-path equality.
      // The existing `@@index([action, allowed, createdAt])` (migration
      // `1b_auditlog_capindex`) serves the three LEADING predicates, narrowing the
      // scan to the last-24h allowed send/reply rows before the JSON filter runs.
      //
      // The domain itself lives ONLY inside the `metadata` JSON column
      // (`recipientDomain`), NOT as an independent, indexable scalar column. A
      // dedicated index on the domain is therefore NOT ADDED here: it would
      // require either a Postgres GIN index on the `metadata` jsonb (which Prisma
      // cannot express in schema and needs raw migration SQL) or promoting
      // `recipientDomain` to a real `AuditLog` column + backfill — the larger
      // schema refactor the audit tracks as CORR-H3/H4, out of scope for this
      // additive change. Until that lands, the composite index above bounds the
      // work; the JSON-path equality is evaluated over the already-narrowed set.
      return countDistinctSends(prisma, {
        action: { in: [...SEND_CAP_ACTIONS] },
        allowed: true,
        createdAt: { gte: since24h() },
        metadata: { path: ['recipientDomain'], equals: domain.trim().toLowerCase() },
      });
    },
    async lastSenderSendAt(senderEmail: string): Promise<Date | null> {
      const row = await prisma.auditLog.findFirst({
        where: {
          action: { in: [...SEND_CAP_ACTIONS] },
          allowed: true,
          metadata: { path: ['senderEmail'], equals: senderEmail.trim().toLowerCase() },
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      return row?.createdAt ?? null;
    },
    async countThreadAutoRepliesToday(threadId: string): Promise<number> {
      // Dedup by distinct idempotencyKey (like the send counters) so a Temporal
      // at-least-once retry that re-writes the reply audit row does not
      // over-count against the per-thread reply cap.
      return countDistinctSends(prisma, {
        action: REPLY_ACTION,
        allowed: true,
        createdAt: { gte: since24h() },
        entityType: 'EmailThread',
        entityId: threadId,
      });
    },
    async countCalendarEventsToday(): Promise<number> {
      // Dedup by distinct idempotencyKey so a retry of the calendar-creation
      // audit row does not over-count against the daily calendar cap.
      return countDistinctSends(prisma, {
        action: CALENDAR_ACTION,
        allowed: true,
        createdAt: { gte: since24h() },
      });
    },
  };
}

/** Prior unsubscribe / negative-reply signals for a prospect. */
export function createReplyHistoryRepo(prisma: PrismaClient): ReplyHistoryRepo {
  return {
    async hasUnsubscribed(prospectId: string): Promise<boolean> {
      const prospect = await prisma.prospect.findUnique({
        where: { id: prospectId },
        select: { status: true, email: true },
      });
      if (!prospect) return false;
      if (prospect.status === 'unsubscribed') return true;
      // Also treat an active suppression with reason `unsubscribe` as opted out.
      if (prospect.email) {
        const sup = await prisma.suppressionEntry.findUnique({
          where: { email: prospect.email.trim().toLowerCase() },
          select: { reason: true },
        });
        if (sup?.reason === 'unsubscribe') return true;
      }
      return false;
    },
    async hasNegativeReply(prospectId: string): Promise<boolean> {
      // A prospect marked `closed` after engagement is treated as a negative
      // signal. (Richer per-message classification lives in @app/agents; this
      // is the conservative deterministic floor.)
      const prospect = await prisma.prospect.findUnique({
        where: { id: prospectId },
        select: { status: true },
      });
      return prospect?.status === 'closed';
    },
  };
}
