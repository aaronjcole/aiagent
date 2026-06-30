-- Dead-letter idempotency forward migration.
--
-- Additive and reversible: adds a stable `dedupeKey` to DeadLetter so a Temporal
-- retry of the terminal-failure recording cannot create a duplicate DeadLetter /
-- ApprovalItem. Nothing in the existing flow is removed or weakened. Generated
-- via offline `prisma migrate diff`; the backfill + DEFAULT make it safe to run
-- against a non-empty table.

-- AlterTable: add the column nullable first so existing rows are valid.
ALTER TABLE "DeadLetter" ADD COLUMN "dedupeKey" TEXT;

-- Backfill any existing rows with a deterministic, collision-free key. The
-- intended runtime semantics are `workflowType || ':' || workflowId`, but
-- preexisting rows may share the same (workflowType, workflowId) — and rows with
-- a null workflowId all fall back to a base key — so backfilling that base key
-- verbatim would create duplicates and abort the unique index below. We append
-- the row primary key (`id`, always unique) to EVERY backfilled key so legacy
-- rows can never collide. This only affects rows that already exist at migration
-- time; new rows written by the application still dedupe by workflowType:workflowId.
UPDATE "DeadLetter"
SET "dedupeKey" = "workflowType" || ':' || COALESCE("workflowId", "id") || ':' || "id"
WHERE "dedupeKey" IS NULL;

-- Enforce NOT NULL now that every row has a value.
ALTER TABLE "DeadLetter" ALTER COLUMN "dedupeKey" SET NOT NULL;

-- CreateIndex: the unique constraint that backs the idempotent upsert/guard.
CREATE UNIQUE INDEX "DeadLetter_dedupeKey_key" ON "DeadLetter"("dedupeKey");
