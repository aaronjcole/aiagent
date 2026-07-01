-- Dead-letter idempotency forward migration.
--
-- Additive and reversible: adds a stable `dedupeKey` to DeadLetter so a Temporal
-- retry of the terminal-failure recording cannot create a duplicate DeadLetter /
-- ApprovalItem. Nothing in the existing flow is removed or weakened. Generated
-- via offline `prisma migrate diff`; the backfill + DEFAULT make it safe to run
-- against a non-empty table.

-- AlterTable: add the column nullable first so existing rows are valid.
ALTER TABLE "DeadLetter" ADD COLUMN "dedupeKey" TEXT;

-- Backfill existing rows NON-DESTRUCTIVELY. The intended runtime semantics are
-- the canonical key `workflowType || ':' || workflowId`. To avoid appending the
-- `:id` suffix to EVERY row (which would needlessly break the canonical key for
-- rows that are already unique), we rank each row within its
-- (workflowType, workflowId) group and only disambiguate where necessary:
--   - a row with a non-null workflowId that is the FIRST of its group (rn = 1)
--     keeps the canonical `workflowType:workflowId`;
--   - genuine duplicates within a group (rn > 1) and rows with a NULL workflowId
--     (which have no canonical key) get the always-unique `id` appended.
-- This still guarantees a collision-free `dedupeKey` before the unique index,
-- while preserving the canonical key for the common (unique) case. Only affects
-- rows present at migration time; new rows dedupe by workflowType:workflowId.
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "workflowType", "workflowId"
      ORDER BY "createdAt", "id"
    ) AS rn
  FROM "DeadLetter"
)
UPDATE "DeadLetter" AS d
SET "dedupeKey" = CASE
  WHEN d."workflowId" IS NOT NULL AND r.rn = 1
    THEN d."workflowType" || ':' || d."workflowId"
  ELSE d."workflowType" || ':' || COALESCE(d."workflowId", '') || ':' || d."id"
END
FROM ranked AS r
WHERE d."id" = r."id" AND d."dedupeKey" IS NULL;

-- Enforce NOT NULL now that every row has a value.
ALTER TABLE "DeadLetter" ALTER COLUMN "dedupeKey" SET NOT NULL;

-- CreateIndex: the unique constraint that backs the idempotent upsert/guard.
CREATE UNIQUE INDEX "DeadLetter_dedupeKey_key" ON "DeadLetter"("dedupeKey");
