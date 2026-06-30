-- Runs once on first Postgres container init (mounted into
-- /docker-entrypoint-initdb.d). The POSTGRES_DB env (default "aiagent") is
-- created automatically by the entrypoint; here we additionally create the
-- databases Temporal's auto-setup expects so a single Postgres instance backs
-- both the application and Temporal.
--
-- NOTE: temporalio/auto-setup will create these itself when DBNAME/VISIBILITY
-- DBNAME do not yet exist, but creating them up-front is harmless and makes the
-- intent explicit. "IF NOT EXISTS" is not supported by CREATE DATABASE in
-- vanilla SQL, so guard with a DO block.
DO
$$
BEGIN
   IF NOT EXISTS (SELECT FROM pg_database WHERE datname = 'temporal') THEN
      CREATE DATABASE temporal;
   END IF;
   IF NOT EXISTS (SELECT FROM pg_database WHERE datname = 'temporal_visibility') THEN
      CREATE DATABASE temporal_visibility;
   END IF;
END
$$;
