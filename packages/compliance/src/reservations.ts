/**
 * ATOMIC cap check-and-reserve for autonomous actions (fixes CORR-2).
 *
 * The plain cap checks in `policy.ts` are check-then-act: two concurrent
 * workflows can both read a count below the cap and both proceed, exceeding the
 * cap and duplicate-sending. `reserveAutoAction` closes that race by doing the
 * cap check AND the reservation write inside ONE Postgres transaction, guarded
 * by a single coarse advisory lock so all reservations serialize.
 *
 * Flow (all inside `prisma.$transaction`):
 *   1. Take `pg_advisory_xact_lock(LOCK_KEY)` — a constant bigint key. Autonomous
 *      send/book is low-QPS, so serializing ALL reservations is acceptable and
 *      correct; the lock is released automatically at transaction end.
 *   2. Re-count the relevant caps WITHIN the transaction (so a concurrent
 *      caller that already reserved is visible).
 *   3. If any limit is exceeded → return {allowed:false, reason} with NO write.
 *   4. Else write the canonical reservation audit row WITHIN the same tx (so the
 *      NEXT concurrent caller counts it) → return {allowed:true}.
 *
 * SAFE DIRECTION: the reservation is written BEFORE the external send. If the
 * subsequent send then FAILS, the reservation slightly OVER-counts (it blocks
 * rather than over-sends) — the conservative, compliance-safe direction. A
 * later round may add reservation reconciliation/expiry; over-counting never
 * over-sends.
 *
 * This module performs the only *write* in the compliance package's cap path;
 * it is still injectable/fake-able for unit tests. True cross-process
 * concurrency is enforced by the advisory lock and verified in the live-PG
 * round.
 */

import type { Prisma, PrismaClient } from '@app/db';
import { ActorType } from '@app/shared';
import { extractDomain, normalizeEmail } from './email.js';
import type { SettingsReader } from './settings.js';
import { SEND_CAP_ACTIONS, CALENDAR_ACTION } from './repos.js';

/**
 * Constant advisory-lock key for the whole auto-action reservation path. A
 * single coarse lock serializes every reservation (send + calendar); low QPS
 * makes this acceptable and simplest to reason about.
 */
export const RESERVE_LOCK_KEY = 4736251809n;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** The timestamp 24h before `now` — the lower bound of the rolling cap window. */
function since24h(now: Date): Date {
  return new Date(now.getTime() - MS_PER_DAY);
}

/** Outcome of an atomic reservation attempt. */
export interface ReserveResult {
  allowed: boolean;
  /** Present only when denied. */
  reason?: string;
}

/** Common identity fields carried on every reservation. */
interface ReserveCommon {
  /** Idempotency key for the action; also the audit `idempotencyKey` column. */
  idempotencyKey: string;
  /** Actor id for the audit row (optional). */
  actorId?: string;
}

/** Args for reserving an autonomous SEND (fresh outbound or confirmation reply). */
export interface ReserveSendArgs extends ReserveCommon {
  kind: 'send';
  /** Sending account address (normalized internally). */
  senderEmail: string;
  /** Recipient address (domain derived internally). */
  recipientEmail: string;
  /**
   * The canonical audit action to record for the reservation. `email.send` for
   * fresh outbound, `email.reply` for a booking-confirmation reply. Both count
   * toward the send caps (see {@link SEND_CAP_ACTIONS}).
   */
  action?: 'email.send' | 'email.reply';
  /** Entity the audit row attaches to (e.g. the draft or thread id). */
  entityType: string;
  entityId: string;
}

/** Args for reserving an autonomous CALENDAR event creation. */
export interface ReserveCalendarArgs extends ReserveCommon {
  kind: 'calendar';
  /** Entity the audit row attaches to (e.g. the thread id). */
  entityType: string;
  entityId: string;
}

export type ReserveArgs = ReserveSendArgs | ReserveCalendarArgs;

/** Injected dependencies for {@link reserveAutoAction}. */
export interface ReserveDeps {
  /** Full Prisma client (needs `$transaction` + `$executeRaw`). */
  prisma: PrismaClient;
  /** Autonomy settings snapshot (cap limits). */
  settings: SettingsReader;
  /** Defaults to `new Date()`; injectable for deterministic tests. */
  now?: Date;
}

// A structural subset of the transaction client the reservation uses. Prisma's
// interactive `$transaction` callback receives a `Prisma.TransactionClient`.
type Tx = Prisma.TransactionClient;

/**
 * Count DISTINCT sends within the transaction, deduping by the audit
 * `idempotencyKey` column (mirrors `repos.ts#countDistinctSends`, bound to tx).
 */
async function countDistinctSendsTx(tx: Tx, where: Prisma.AuditLogWhereInput): Promise<number> {
  const rows = await tx.auditLog.findMany({ where, select: { idempotencyKey: true } });
  let nullKeyRows = 0;
  const keys = new Set<string>();
  for (const r of rows) {
    if (r.idempotencyKey == null || r.idempotencyKey === '') nullKeyRows += 1;
    else keys.add(r.idempotencyKey);
  }
  return keys.size + nullKeyRows;
}

/**
 * Atomically check the relevant caps and, if within limits, write the canonical
 * reservation (audit) row — all inside one advisory-locked transaction. See the
 * module doc for the safety contract.
 */
export async function reserveAutoAction(
  deps: ReserveDeps,
  args: ReserveArgs,
): Promise<ReserveResult> {
  const { prisma, settings } = deps;
  const now = deps.now ?? new Date();

  return prisma.$transaction(async (tx) => {
    // (1) Serialize all reservations behind one coarse advisory xact lock.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RESERVE_LOCK_KEY})`;

    // (2) Re-count caps WITHIN the tx, then (3)/(4) decide + reserve.
    if (args.kind === 'calendar') {
      // (2a) Idempotency BEFORE the cap: if this exact action was already
      // reserved (same idempotencyKey + calendar action), a Temporal retry must
      // succeed rather than be denied by its own reservation at an exactly-
      // reached cap. Return allowed without writing a duplicate row.
      const existing = await tx.auditLog.findFirst({
        where: {
          action: CALENDAR_ACTION,
          allowed: true,
          idempotencyKey: args.idempotencyKey,
        },
        select: { id: true },
      });
      if (existing) return { allowed: true };

      const count = await tx.auditLog.count({
        where: { action: CALENDAR_ACTION, allowed: true, createdAt: { gte: since24h(now) } },
      });
      const cap = settings.num('maxCalendarEventsPerDay');
      if (count >= cap) {
        return { allowed: false, reason: `daily calendar event cap reached (${count}/${cap})` };
      }
      await tx.auditLog.create({
        data: {
          action: CALENDAR_ACTION,
          actorType: ActorType.SYSTEM,
          actorId: args.actorId ?? null,
          entityType: args.entityType,
          entityId: args.entityId,
          decision: 'reserve',
          allowed: true,
          reason: 'calendar reservation',
          metadata: { idempotencyKey: args.idempotencyKey } as Prisma.InputJsonValue,
          idempotencyKey: args.idempotencyKey,
        },
      });
      return { allowed: true };
    }

    // kind === 'send'
    const sender = normalizeEmail(args.senderEmail);
    const domain = extractDomain(args.recipientEmail) ?? '';

    // (2a) Idempotency BEFORE the cap: if an ALLOWED send/reply reservation with
    // this exact idempotencyKey already exists, a Temporal retry must succeed
    // rather than be denied by its own reservation at an exactly-reached cap.
    // Return allowed without writing a duplicate row.
    const existingSend = await tx.auditLog.findFirst({
      where: {
        action: { in: [...SEND_CAP_ACTIONS] },
        allowed: true,
        idempotencyKey: args.idempotencyKey,
      },
      select: { id: true },
    });
    if (existingSend) return { allowed: true };

    const baseWhere: Prisma.AuditLogWhereInput = {
      action: { in: [...SEND_CAP_ACTIONS] },
      allowed: true,
      createdAt: { gte: since24h(now) },
    };

    const [global, senderCount, domainCount] = await Promise.all([
      countDistinctSendsTx(tx, baseWhere),
      countDistinctSendsTx(tx, {
        ...baseWhere,
        metadata: { path: ['senderEmail'], equals: sender },
      }),
      domain
        ? countDistinctSendsTx(tx, {
            ...baseWhere,
            metadata: { path: ['recipientDomain'], equals: domain },
          })
        : Promise.resolve(0),
    ]);

    const globalCap = settings.num('maxAutoSendsPerDayGlobal');
    const senderCap = settings.num('maxAutoSendsPerSenderPerDay');
    const domainCap = settings.num('maxAutoSendsPerDomainPerDay');

    if (global >= globalCap) {
      return { allowed: false, reason: `global daily auto-send cap reached (${global}/${globalCap})` };
    }
    if (senderCount >= senderCap) {
      return {
        allowed: false,
        reason: `per-sender daily auto-send cap reached (${senderCount}/${senderCap})`,
      };
    }
    if (domain && domainCount >= domainCap) {
      return {
        allowed: false,
        reason: `per-domain daily auto-send cap reached for ${domain} (${domainCount}/${domainCap})`,
      };
    }

    // (4) Reserve: write the canonical send audit row so the next concurrent
    // caller counts it. Carries the REQUIRED SendAuditMetadata shape.
    await tx.auditLog.create({
      data: {
        action: args.action ?? 'email.send',
        actorType: ActorType.SYSTEM,
        actorId: args.actorId ?? null,
        entityType: args.entityType,
        entityId: args.entityId,
        decision: 'reserve',
        allowed: true,
        reason: 'send reservation',
        metadata: {
          senderEmail: sender,
          recipientDomain: domain,
          idempotencyKey: args.idempotencyKey,
        } as Prisma.InputJsonValue,
        idempotencyKey: args.idempotencyKey,
      },
    });
    return { allowed: true };
  });
}
