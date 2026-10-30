-- 004 — the launch gate (plans, trials, billing state).
--
-- Mirrors SQLite migration 5 in server/account-migrations.ts. Every column is nullable: an account
-- created before this migration reads as a Founder account in server/plans.ts, which is application
-- policy and deliberately not encoded as a database default.
alter table accounts add column if not exists plan text;
alter table accounts add column if not exists trial_ends_at bigint;
alter table accounts add column if not exists billing text;

-- Reading the commercial view is an owner-only operation; the desk builds it from accounts and
-- platform_store, so no new table is required for hubs either (a publication is part of the
-- tournament JSON inside platform_store).
create index if not exists accounts_plan on accounts (plan);
create index if not exists accounts_trial_ends_at on accounts (trial_ends_at);
