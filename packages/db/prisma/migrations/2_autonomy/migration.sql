-- Controlled-autonomy foundation forward migration.
--
-- Additive and reversible: introduces the SenderAccount sending-identity model
-- and links DraftEmail to an optional SenderAccount. Nothing in the existing
-- draft/approval flow is removed or weakened. Generated via `prisma migrate diff`.

-- AlterTable
ALTER TABLE "DraftEmail" ADD COLUMN     "senderAccountId" TEXT;

-- CreateTable
CREATE TABLE "SenderAccount" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "pausedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SenderAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SenderAccount_email_key" ON "SenderAccount"("email");

-- AddForeignKey
ALTER TABLE "DraftEmail" ADD CONSTRAINT "DraftEmail_senderAccountId_fkey" FOREIGN KEY ("senderAccountId") REFERENCES "SenderAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
