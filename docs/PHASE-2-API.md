# Phase 2 — Database foundations and compatible API boundaries

Completed 2026-10-21 on the active Arena work branch. Report for [`INSTRUCTIONS.md`](INSTRUCTIONS.md) §14 Phase 2. The repository's Phase 0 baseline and Phase 1 website report were reviewed before starting. The tracked account service was confirmed to use Node's `node:sqlite`, with an unversioned `CREATE TABLE IF NOT EXISTS` schema; the desktop and host still use the existing device-link/licence flow. Phase 2 keeps those contracts intact.

## 1. Scope

- Add a transactional, forward-only SQLite migration runner, adopting existing account databases without rebuilding tables.
- Add missing normalized-email enforcement, query indexes and a dedicated privacy-minimized audit log.
- Add generated request correlation IDs to hosted-account and venue-host HTTP surfaces, preserving existing error fields and success responses.
- Centralize account-service session, owner, service-key and same-origin checks in explicit guards.
- Document the actual route/request/response and migration contracts.
- Add integration tests for migration from an existing database, idempotent restart, conflict rollback, request IDs, audit attribution/privacy, and existing client/hosted API parity.

No new account-lifecycle, email, password recovery, roles, lease, updater or telemetry feature is activated in this phase.

## 2. Dependencies and compatibility

**Dependencies:** reviewed Phase 0 architecture baseline and completed Phase 1 public-flow report; Node 20+ runtime and SQLite `node:sqlite` are already part of the project.

**Compatibility decisions:**

- The existing upstream account routes and the host's `/api/beta/*` proxy are unchanged. No public registration route and no new `/api/v1` prefix is exposed yet.
- Existing account success bodies and legacy `{error, code}` fields remain intact; an additive `requestId` is provided on account-service errors. The host provides an `X-Request-Id` header for all responses and adds the ID to existing JSON error objects.
- The old `events` table and application readers remain untouched. New audit records are written to a separate table, with no retroactive synthetic actors.
- Old account databases are recognized by migration 1's idempotent baseline. Migrations 1 and 2 are applied in separate `BEGIN IMMEDIATE` transactions and recorded with SQLite `PRAGMA user_version`.
- If normalized-email duplicates exist, the service refuses startup and rolls back; it does not merge or delete accounts.
- `.env.example` is unchanged because Phase 2 adds no configuration key.

## 3. Implementation and changed areas

- `server/account-migrations.ts` — migration versions, baseline schema adoption, normalized email uniqueness, audit schema and indexes, transactional rollback, actionable conflict errors.
- `server/account-service.ts` — migration startup, request IDs, additive consistent errors, error-message redaction in request logs, explicit service/account/owner/origin authorization helpers, durable audit writes for existing event actions, and timing-safe comparison for the configured machine service key.
- `server/index.ts` — generated `X-Request-Id` on every host/site HTTP response; established error JSON gains only additive correlation data.
- `tests/account-service.test.ts`, `tests/panel-live.test.ts` — migration, boundary and compatibility integration coverage.
- `docs/API-CONTRACTS.md` — final Phase 2 API/migration contract, explicitly recording what remains legacy or deferred.
- `docs/ACCOUNT-SERVICE.md` — migration, backup and recovery steps updated.

## 4. Database changes

Migration 1 creates the prior schema only when absent and adopts existing tables as-is. Migration 2 adds:

- a backfilled `normalized_email` column (using the API's Unicode-aware trim/lowercase normalization) and unique index;
- lookup/expiry indexes for sessions, grants and active devices;
- `audit_logs` with actor type/id, action, target type/id, timestamp, request ID and validated JSON metadata;
- indexes for audit time, actor, target and request correlation.

The dedicated audit table does not copy email addresses, invitation secrets, device codes, free-form request data or legacy event details into metadata. Existing `events` rows are preserved. Migration recovery is backup/restore; there is no destructive down migration. Operators must make and verify a SQLite backup before deployment.

## 5. Tests and commands

Baseline after `npm ci`:

- `npm test` — **333/333 passed** before Phase 2 source changes.
- `npm run build` — passed before Phase 2 changes (existing Framer Motion and large-chunk warnings).

Phase 2 verification:

- `npx tsc --noEmit` — passed after implementation.
- `npx tsx --test tests/account-service.test.ts` — **15/15 passed**; includes unchanged local/hosted field parity and new migration/request-ID/audit cases.
- `npm test` — **337/337 passed**, including the real host HTTP regression tests.
- `npm run build` — passed: TypeScript check and Vite production build.

The migration tests create a pre-migration database with existing account/event rows, adopt and restart it, and force a case-normalization collision to prove rollback leaves both accounts and the prior migration version intact. Security tests verify error IDs cannot be supplied by callers and audit metadata excludes free-form PII. The host live test checks request correlation while existing access-control and GSI scenarios continue to exercise local tournament boundaries.

## 6. Results

- **Phase 2 exit gate:** migrations, tests and production frontend/server TypeScript build passed.
- `npm test`: **337 passed, 0 failed** (includes all existing local beta/account, GSI, overlay, OBS, host/site boundary, and new Phase 2 tests).
- `npm run build`: passed. Vite continues to emit the pre-existing Framer Motion `use client` directive notices and the existing >500 kB main-chunk advisory; output is generated successfully.
- `git diff --check`: passed.
- `npm audit --omit=dev --audit-level=moderate`: **0 production dependency vulnerabilities**. `npm ci` reports 9 total findings across all dependencies (2 moderate, 7 high); these are in the existing dependency tree, with no dependency changes in this phase.
- Desktop/Rust/Windows packaging validation was not executable here: `cargo` and `rustc` are not installed, and this Linux environment cannot run the verified Windows/Inno Setup installer workflow. No desktop, GSI, OBS or packaging source was changed; their relevant host regression coverage passed, but this is not a Windows end-to-end claim.

## 7. Security and limitations

- Existing server-side owner/session/installation protections remain the authority. The new guards consolidate existing checks; they do not infer roles from client-provided data.
- Request IDs are freshly generated, never accepted from clients as authoritative, and contain no credential or user identifier.
- Unhandled account-service request logs contain only the correlation ID and error class, not exception messages or submitted body fields. Existing operational CLI `--approve` output intentionally displays the one-time invite so an operator can deliver it; protect that terminal output as a secret.
- The legacy `events` table remains for compatibility and may contain earlier free-form details. The new audit log is privacy-minimized, but legacy retention/deletion policy and a complete role/permission model remain for later phases.
- SQLite uniqueness can reject a migration if legacy rows collide after trimming and case normalization; the documented backup/manual-resolution path prevents silent data loss.
- The current invitation workflow still has no email sender; that is Phase 3 and is not represented as implemented by this work.

## 8. Files and developer/deployment guidance

See `docs/API-CONTRACTS.md` for endpoints and error compatibility, and `docs/ACCOUNT-SERVICE.md` for the migration, backup and restore procedures. The Windows Tauri/installer build pipeline and current local operator endpoints are not changed.

## 9. Remaining work and next-phase prerequisites

- Finish the complete test suite and production build before considering Phase 2 complete.
- Phase 3 must build application/invitation/account lifecycle on top of these stable data and API boundaries; implement reliable email delivery, single-use/expiry/atomicity and account activation then.
- Password recovery, role grants, installation identity evolution, leases, signed updates and telemetry remain disabled/deferred.
