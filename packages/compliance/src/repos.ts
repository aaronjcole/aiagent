/**
 * Prisma-backed implementations of the narrow compliance repository interfaces.
 *
 * These are the ONLY place in the package that touches a real database. The
 * deterministic checks depend on the interfaces in `types.ts`, so unit tests
 * substitute in-memory fakes and never need Postgres.
 */

import type { PrismaClient } from '@app/db';
import { EmailDirection } from '@app/shared';
import type {
  AddSuppressionInput,
  ReplyHistoryRepo,
  SendCountRepo,
  SuppressionEntryLike,
  SuppressionRepo,
} from './types.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
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
