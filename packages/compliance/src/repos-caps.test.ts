import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@app/db';
import { createCapRepo } from './repos.js';

/**
 * Minimal in-memory AuditLog double exercising the REAL `createCapRepo` query
 * logic (action `in` filter, distinct-idempotencyKey dedup, metadata-path
 * matching). It implements only the `auditLog.findMany`/`count`/`findFirst`
 * surface the cap repo uses; unrelated PrismaClient members are unused.
 */
interface AuditRow {
  action: string;
  allowed: boolean | null;
  createdAt: Date;
  idempotencyKey: string | null;
  metadata: Record<string, unknown> | null;
  entityType: string;
  entityId: string;
  /** Promoted column (CORR-H3/H4). Nullable — legacy pre-migration rows have
   * no column value even when `metadata.recipientDomain` is present. */
  recipientDomain?: string | null;
}

interface FakeWhere {
  action?: string | { in: string[] };
  allowed?: boolean;
  createdAt?: { gte?: Date };
  entityType?: string;
  entityId?: string;
  metadata?: { path: string[]; equals: unknown };
  recipientDomain?: string;
}

function matches(row: AuditRow, where: FakeWhere): boolean {
  if (where.action) {
    if (typeof where.action === 'object' && 'in' in where.action) {
      if (!where.action.in.includes(row.action)) return false;
    } else if (row.action !== where.action) return false;
  }
  if (where.allowed !== undefined && row.allowed !== where.allowed) return false;
  if (where.createdAt?.gte && row.createdAt < where.createdAt.gte) return false;
  if (where.entityType !== undefined && row.entityType !== where.entityType) return false;
  if (where.entityId !== undefined && row.entityId !== where.entityId) return false;
  if (where.metadata?.path) {
    const key = where.metadata.path[0];
    const val = key === undefined ? undefined : row.metadata?.[key];
    if (val !== where.metadata.equals) return false;
  }
  if (where.recipientDomain !== undefined && row.recipientDomain !== where.recipientDomain) {
    return false;
  }
  return true;
}

function fakePrisma(rows: AuditRow[]): PrismaClient {
  const auditLog = {
    async findMany(args: { where: FakeWhere }) {
      return rows.filter((r) => matches(r, args.where)).map((r) => ({
        idempotencyKey: r.idempotencyKey,
      }));
    },
    async count(args: { where: FakeWhere }) {
      return rows.filter((r) => matches(r, args.where)).length;
    },
    async findFirst(args: { where: FakeWhere }) {
      const filtered = rows
        .filter((r) => matches(r, args.where))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const row = filtered[0];
      return row ? { createdAt: row.createdAt } : null;
    },
  };
  return { auditLog } as unknown as PrismaClient;
}

function row(over: Partial<AuditRow> = {}): AuditRow {
  return {
    action: 'email.send',
    allowed: true,
    createdAt: new Date(),
    idempotencyKey: null,
    metadata: null,
    entityType: 'draft_email',
    entityId: 'd1',
    recipientDomain: null,
    ...over,
  };
}

describe('createCapRepo counting (CORR-N2 / CORR-6)', () => {
  it('counts BOTH email.send and email.reply toward the global send cap', async () => {
    const repo = createCapRepo(
      fakePrisma([
        row({ action: 'email.send', idempotencyKey: 'a' }),
        row({ action: 'email.reply', idempotencyKey: 'b' }),
      ]),
    );
    expect(await repo.countGlobalSentToday()).toBe(2);
  });

  it('email.reply counts toward per-sender and per-domain caps', async () => {
    const md = { senderEmail: 'sender@us.example.com', recipientDomain: 'acme.com' };
    const repo = createCapRepo(
      fakePrisma([
        row({ action: 'email.reply', idempotencyKey: 'x', metadata: md, recipientDomain: 'acme.com' }),
        row({ action: 'email.send', idempotencyKey: 'y', metadata: md, recipientDomain: 'acme.com' }),
      ]),
    );
    expect(await repo.countSenderSentToday('sender@us.example.com')).toBe(2);
    expect(await repo.countDomainSentToday('acme.com')).toBe(2);
  });

  describe('countDomainSentToday (CORR-H3/H4: promoted recipientDomain column)', () => {
    it('counts a row via the new recipientDomain COLUMN (not the metadata JSON path)', async () => {
      const repo = createCapRepo(
        fakePrisma([
          // metadata deliberately omits recipientDomain to prove the column,
          // not the JSON path, drives the count.
          row({ action: 'email.send', idempotencyKey: 'c1', recipientDomain: 'acme.com' }),
        ]),
      );
      expect(await repo.countDomainSentToday('acme.com')).toBe(1);
    });

    it('does NOT count a legacy row with recipientDomain COLUMN NULL, even if metadata JSON has the domain', async () => {
      // Simulates a pre-migration-4 row where the backfill has not (yet) run —
      // the hot query now filters strictly on the column, so an un-backfilled
      // row is correctly invisible to the cap count. This is exactly why the
      // migration includes a backfill step (validated separately against a
      // real Postgres instance) rather than relying on this query to also
      // consult the JSON as a fallback.
      const repo = createCapRepo(
        fakePrisma([
          row({
            action: 'email.send',
            idempotencyKey: 'legacy1',
            metadata: { senderEmail: 'sender@us.example.com', recipientDomain: 'acme.com' },
            recipientDomain: null,
          }),
        ]),
      );
      expect(await repo.countDomainSentToday('acme.com')).toBe(0);
    });

    it('counts a backfilled legacy row once its recipientDomain column is populated', async () => {
      // Same row as above, but with the column populated the way the
      // `4_auditlog_recipient_domain` migration's backfill step sets it
      // (verified against a real Postgres instance in this task's manual
      // verification) — now correctly counted.
      const repo = createCapRepo(
        fakePrisma([
          row({
            action: 'email.send',
            idempotencyKey: 'legacy1',
            metadata: { senderEmail: 'sender@us.example.com', recipientDomain: 'acme.com' },
            recipientDomain: 'acme.com',
          }),
        ]),
      );
      expect(await repo.countDomainSentToday('acme.com')).toBe(1);
    });

    it('scopes the count to the requested domain only', async () => {
      const repo = createCapRepo(
        fakePrisma([
          row({ action: 'email.send', idempotencyKey: 'd1', recipientDomain: 'acme.com' }),
          row({ action: 'email.send', idempotencyKey: 'd2', recipientDomain: 'beta.io' }),
        ]),
      );
      expect(await repo.countDomainSentToday('acme.com')).toBe(1);
      expect(await repo.countDomainSentToday('beta.io')).toBe(1);
      expect(await repo.countDomainSentToday('other.com')).toBe(0);
    });
  });

  it('deduplicates by idempotencyKey (retry does not over-count)', async () => {
    const repo = createCapRepo(
      fakePrisma([
        row({ idempotencyKey: 'same' }),
        row({ idempotencyKey: 'same' }), // Temporal retry wrote a duplicate audit row.
        row({ idempotencyKey: 'other' }),
      ]),
    );
    // Distinct keys: {same, other} → 2 (not 3).
    expect(await repo.countGlobalSentToday()).toBe(2);
  });

  it('rows lacking an idempotencyKey each count individually (conservative)', async () => {
    const repo = createCapRepo(
      fakePrisma([row({ idempotencyKey: null }), row({ idempotencyKey: null })]),
    );
    expect(await repo.countGlobalSentToday()).toBe(2);
  });

  it('mixes keyed + unkeyed rows correctly', async () => {
    const repo = createCapRepo(
      fakePrisma([
        row({ idempotencyKey: 'k1' }),
        row({ idempotencyKey: 'k1' }),
        row({ idempotencyKey: null }),
      ]),
    );
    // distinct keys {k1} = 1, plus 1 null-key row = 2.
    expect(await repo.countGlobalSentToday()).toBe(2);
  });

  it('countThreadAutoRepliesToday dedups by idempotencyKey', async () => {
    const repo = createCapRepo(
      fakePrisma([
        row({ action: 'email.reply', entityType: 'EmailThread', entityId: 't1', idempotencyKey: 'r' }),
        // Temporal retry wrote a duplicate reply audit row for the same send.
        row({ action: 'email.reply', entityType: 'EmailThread', entityId: 't1', idempotencyKey: 'r' }),
        row({ action: 'email.reply', entityType: 'EmailThread', entityId: 't1', idempotencyKey: 'r2' }),
      ]),
    );
    // Distinct keys {r, r2} = 2 (not 3).
    expect(await repo.countThreadAutoRepliesToday('t1')).toBe(2);
  });

  it('countCalendarEventsToday dedups by idempotencyKey', async () => {
    const repo = createCapRepo(
      fakePrisma([
        row({ action: 'calendar.create', idempotencyKey: 'c' }),
        row({ action: 'calendar.create', idempotencyKey: 'c' }), // retry
        row({ action: 'calendar.create', idempotencyKey: 'c2' }),
      ]),
    );
    // Distinct keys {c, c2} = 2 (not 3).
    expect(await repo.countCalendarEventsToday()).toBe(2);
  });

  it('lastSenderSendAt considers both send and reply actions', async () => {
    const older = new Date('2025-06-30T10:00:00.000Z');
    const newer = new Date('2025-06-30T12:00:00.000Z');
    const md = { senderEmail: 'sender@us.example.com', recipientDomain: 'acme.com' };
    const repo = createCapRepo(
      fakePrisma([
        row({ action: 'email.send', createdAt: older, metadata: md, idempotencyKey: 'o' }),
        row({ action: 'email.reply', createdAt: newer, metadata: md, idempotencyKey: 'n' }),
      ]),
    );
    expect(await repo.lastSenderSendAt('sender@us.example.com')).toEqual(newer);
  });
});
