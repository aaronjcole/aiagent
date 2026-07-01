-- Production-hardening forward migration.
--
-- Create the DeadLetter enum + table (durable record of terminal workflow
-- failures). Generated via `prisma migrate diff`.
--
-- NOTE: The ProspectStatus enum `ADD VALUE` upgrade that previously lived here
-- has been split into its own migration (`1a_prospectstatus_values`). Mixing
-- `ALTER TYPE "ProspectStatus" ADD VALUE` with `CREATE TYPE`/`CREATE TABLE` DDL
-- inside one Prisma transaction can abort when upgrading a legacy DB (Postgres
-- forbids using a newly-added enum value in the same transaction that adds it).
-- Isolating the enum changes avoids that abort. See
-- `1a_prospectstatus_values/migration.sql`.

-- DeadLetter -----------------------------------------------------------------

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
