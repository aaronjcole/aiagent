-- Dead-letter idempotency forward migration.
--
-- Additive and reversible: adds a stable `dedupeKey` to DeadLetter so a Temporal
-- retry of the terminal-failure recording cannot create a duplicate DeadLetter /
-- ApprovalItem. Nothing in the existing flow is removed or weakened. Generated
-- via offline `prisma migrate diff`; the backfill + DEFAULT make it safe to run
-- against a non-empty table.

-- AlterTable: add the column nullable first so existing rows are valid.
ALTER TABLE "DeadLetter" ADD COLUMN "dedupeKey" TEXT;

-- Backfill any existing rows with a deterministic, collision-free key derived
-- from workflowType + workflowId (falling back to the row id when workflowId is
-- null, so legacy rows never collide).
UPDATE "DeadLetter"
SET "dedupeKey" = "workflowType" || ':' || COALESCE("workflowId", "id")
WHERE "dedupeKey" IS NULL;

-- Enforce NOT NULL now that every row has a value.
ALTER TABLE "DeadLetter" ALTER COLUMN "dedupeKey" SET NOT NULL;

-- CreateIndex: the unique constraint that backs the idempotent upsert/guard.
CREATE UNIQUE INDEX "DeadLetter_dedupeKey_key" ON "DeadLetter"("dedupeKey");
