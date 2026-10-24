-- Forward upgrade for Supabase projects that already applied migrations 001-002.
-- Mirrors SQLite schema version 4 (server/account-migrations.ts):
-- 1. Adds the 'revoked' account status for cutting off approved beta accounts, plus the
--    owner-written revocation reason recorded with the decision.
-- 2. Adds email-outbox failure detail (provider HTTP status and provider error name) so a
--    `provider-rejected` delivery can be diagnosed without reading the service log.
--
-- Apply BEFORE deploying the server code that writes these columns: PostgREST rejects unknown
-- columns, and the widened status CHECK must accept 'revoked' before any revocation is flushed.
--   supabase db push   (Supabase CLI, linked project)
-- or paste into the Supabase SQL Editor.

-- The unnamed CHECK from 001 is named accounts_status_check by PostgreSQL.
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_status_check;
ALTER TABLE accounts ADD CHECK (status IN ('pending', 'approved', 'rejected', 'revoked'));

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS revoked_reason TEXT;

ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS last_error_status INTEGER;
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS last_provider_error TEXT;
