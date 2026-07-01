-- AuditLog composite index for the controlled-autonomy cap counters.
--
-- The global/sender/domain send caps, per-thread reply cap, and calendar cap
-- all count AuditLog rows filtered by (action, allowed, createdAt). Without a
-- usable composite index these run as scans on the highest-write table on every
-- send/reply/book gate evaluation. This index covers those predicates.
--
-- Additive and reversible: no data change, index only. Generated to match the
-- `@@index([action, allowed, createdAt])` added to the AuditLog model.
--
-- (A domain-column + GIN index for metadata JSON paths is intentionally
--  deferred to P1; this covers the action/allowed/createdAt leading predicate.)

-- CreateIndex
CREATE INDEX "AuditLog_action_allowed_createdAt_idx" ON "AuditLog"("action", "allowed", "createdAt");
