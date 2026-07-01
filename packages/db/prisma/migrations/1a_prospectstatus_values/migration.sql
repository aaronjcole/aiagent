-- ProspectStatus enum upgrade (idempotent), split out of `1_hardening`.
--
-- Databases migrated from an ORIGINAL 0_init may predate these research-verdict
-- values. `ADD VALUE IF NOT EXISTS` upgrades them without failing on databases
-- that already have them (or were created from the current 0_init baseline).
--
-- These statements are ISOLATED in their own migration (separate transaction
-- from the `1_hardening` DDL). Postgres forbids using a newly-added enum value
-- in the same transaction that adds it, and mixing `ALTER TYPE ... ADD VALUE`
-- with `CREATE TYPE`/`CREATE TABLE` in one transaction can abort a legacy-DB
-- upgrade. Keeping them alone avoids that abort. Requires Postgres 12+.
--
-- Ordering: Prisma applies migrations in lexical order. The `1a`/`1b` prefixes
-- sort AFTER `1_hardening` (because 'a'/'b' > '_') and BEFORE `2_autonomy`
-- (because '1' < '2'), giving:
-- `0_init` < `1_hardening` < `1a_prospectstatus_values`
--   < `1b_auditlog_capindex` < `2_autonomy` < `3_deadletter_dedupe`.
ALTER TYPE "ProspectStatus" ADD VALUE IF NOT EXISTS 'researched';
ALTER TYPE "ProspectStatus" ADD VALUE IF NOT EXISTS 'partial';
ALTER TYPE "ProspectStatus" ADD VALUE IF NOT EXISTS 'insufficient';
ALTER TYPE "ProspectStatus" ADD VALUE IF NOT EXISTS 'needs_review';
