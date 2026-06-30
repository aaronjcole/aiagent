-- Production-hardening forward migration.
--
-- (a) Create the DeadLetter enum + table (durable record of terminal workflow
--     failures). Generated via `prisma migrate diff`.
-- (b) Idempotently ensure the ProspectStatus enum carries the research-verdict
--     values. Databases created from the ORIGINAL 0_init may predate these
--     values; `ADD VALUE IF NOT EXISTS` upgrades them without failing on
--     databases that already have them (or were created from the current
--     0_init baseline).

-- (a) DeadLetter -------------------------------------------------------------

-- CreateEnum
CREATE TYPE "DeadLetterStatus" AS ENUM ('open', 'resolved');

-- CreateTable
CREATE TABLE "DeadLetter" (
    "id" TEXT NOT NULL,
    "workflowType" TEXT NOT NULL,
    "workflowId" TEXT,
    "input" JSONB NOT NULL,
    "error" TEXT NOT NULL,
    "stackRedacted" TEXT,
    "status" "DeadLetterStatus" NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "DeadLetter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeadLetter_status_createdAt_idx" ON "DeadLetter"("status", "createdAt");

-- (b) ProspectStatus enum upgrade (idempotent) -------------------------------
-- Upgrades databases migrated from an older 0_init that lacked these values.
-- No-op where the value already exists.
ALTER TYPE "ProspectStatus" ADD VALUE IF NOT EXISTS 'researched';
ALTER TYPE "ProspectStatus" ADD VALUE IF NOT EXISTS 'partial';
ALTER TYPE "ProspectStatus" ADD VALUE IF NOT EXISTS 'insufficient';
ALTER TYPE "ProspectStatus" ADD VALUE IF NOT EXISTS 'needs_review';
