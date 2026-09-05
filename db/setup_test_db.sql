-- Creates the local test database. Run once via `npm run db:test:setup`.
-- Idempotent: safe to re-run.
SELECT 'CREATE DATABASE freshline_msos_test OWNER jwairepo'
WHERE NOT EXISTS (
    SELECT FROM pg_database WHERE datname = 'freshline_msos_test'
)\gexec
