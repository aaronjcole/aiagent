-- Runs once on first Postgres container init (mounted into
-- /docker-entrypoint-initdb.d). The POSTGRES_DB env (default "aiagent") is
-- created automatically by the entrypoint; here we additionally create the
-- databases Temporal's auto-setup expects so a single Postgres instance backs
-- both the application and Temporal.
--
-- NOTE: temporalio/auto-setup will create these itself when DBNAME/VISIBILITY
-- DBNAME do not yet exist, but creating them up-front is harmless and makes the
-- intent explicit.
--
-- CREATE DATABASE cannot run inside a transaction / DO block (Postgres forbids
-- it), so we use psql's \gexec meta-command to run a top-level, conditional
-- CREATE DATABASE only when the database does not already exist. Idempotent.
SELECT 'CREATE DATABASE temporal'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'temporal')\gexec

SELECT 'CREATE DATABASE temporal_visibility'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'temporal_visibility')\gexec
