-- Promote AuditLog.metadata->>'recipientDomain' to a real, indexed column
-- (fixes CORR-H3/H4 follow-up documented in repos.ts / commit 0d8d017).
--
-- Previously the per-domain send cap (`countDomainSentToday`) filtered a JSON
-- path (`metadata->>'recipientDomain'`) with no dedicated index, relying only
-- on the leading (action, allowed, createdAt) composite index to narrow the
-- scan before the JSON-path equality ran. This migration adds a genuine
-- `recipientDomain` scalar column plus a composite index that covers the
-- cap query's exact predicate shape, and backfills historical rows from their
-- existing `metadata` JSON so the new column is correct immediately —
-- non-destructively: the JSON `metadata` column is left completely intact
-- (still populated by every write path for audit-trail readability), this
-- only ADDS a derived column, no data is removed.
--
-- Additive and reversible: nullable column, backfill computed from data
-- already present in `metadata`, no rows deleted, no columns dropped.
-- Style matches the non-destructive backfill in `3_deadletter_dedupe`.

-- AlterTable: add the column nullable first so existing rows stay valid.
ALTER TABLE "AuditLog" ADD COLUMN "recipientDomain" TEXT;

-- Backfill existing rows NON-DESTRUCTIVELY from the JSON metadata that already
-- carries the same value (`SendAuditMetadata.recipientDomain`, written by every
-- send/reply/reservation audit row). Only rows that actually have a non-empty
-- string at that JSON path are touched; rows with no such key (e.g.
-- calendar.create, policy.denied, or any non-send action) are correctly left
-- NULL — they never counted toward the per-domain cap before this migration
-- either. Idempotent: safe to re-run (WHERE ... IS NULL guards it).
UPDATE "AuditLog"
SET "recipientDomain" = "metadata"->>'recipientDomain'
WHERE "recipientDomain" IS NULL
  AND "metadata"->>'recipientDomain' IS NOT NULL
  AND "metadata"->>'recipientDomain' <> '';

-- CreateIndex: composite index matching countDomainSentToday's exact predicate
-- shape — (action IN [...], allowed = true, recipientDomain = X, createdAt >=
-- since) — equality columns first, range column last, so per-domain cap
-- lookups are a direct index scan instead of a sequential scan + JSON filter.
CREATE INDEX "AuditLog_action_allowed_recipientDomain_createdAt_idx"
  ON "AuditLog"("action", "allowed", "recipientDomain", "createdAt");
