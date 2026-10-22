import type {DatabaseSync} from 'node:sqlite';

/**
 * Forward-only SQLite migrations for the hosted account service.
 *
 * Version 1 is intentionally an idempotent baseline: deployments made before the migration
 * runner already have these tables, and CREATE IF NOT EXISTS adopts them without rewriting data.
 */
export const ACCOUNT_DB_SCHEMA_VERSION=3;

const MIGRATIONS:Array<{version:number;name:string;sql:string;apply?:(db:DatabaseSync)=>void}>=[
 {
  version:1,
  name:'account-service-baseline',
  sql:`
   CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, organisation TEXT NOT NULL,
    country TEXT NOT NULL, use_case TEXT NOT NULL, events TEXT NOT NULL, status TEXT NOT NULL,
    password TEXT, created_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT NOT NULL DEFAULT '',
    invite_digest TEXT, invite_expires_at INTEGER, last_login_at INTEGER
   );
   CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
    address TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT ''
   );
   CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, label TEXT NOT NULL, platform TEXT NOT NULL,
    created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, revoked_at INTEGER, token_digest TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS grants (
    device_code TEXT PRIMARY KEY, user_code TEXT NOT NULL, label TEXT NOT NULL, platform TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL,
    account_id TEXT, device_id TEXT, pending_token TEXT, claimed_at INTEGER
   );
   CREATE TABLE IF NOT EXISTS platform_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS events (
    at INTEGER NOT NULL, kind TEXT NOT NULL, account_id TEXT, detail TEXT NOT NULL DEFAULT ''
   );
   CREATE INDEX IF NOT EXISTS sessions_account ON sessions (account_id);
   CREATE INDEX IF NOT EXISTS devices_account ON devices (account_id);
   CREATE INDEX IF NOT EXISTS grants_user_code ON grants (user_code);
   CREATE INDEX IF NOT EXISTS accounts_status ON accounts (status);
  `,
 },
 {
  version:2,
  name:'normalized-email-index-and-audit-log',
  sql:`
   ALTER TABLE accounts ADD COLUMN normalized_email TEXT;
   CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (created_at, last_seen_at);
   CREATE INDEX IF NOT EXISTS grants_status_expiry ON grants (status, expires_at);
   CREATE INDEX IF NOT EXISTS devices_active_account ON devices (account_id, created_at) WHERE revoked_at IS NULL;
   CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at INTEGER NOT NULL,
    request_id TEXT,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('anonymous','account','service')),
    actor_id TEXT,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata))
   );
   CREATE INDEX IF NOT EXISTS audit_logs_time ON audit_logs (occurred_at DESC, id DESC);
   CREATE INDEX IF NOT EXISTS audit_logs_actor ON audit_logs (actor_type, actor_id, occurred_at DESC);
   CREATE INDEX IF NOT EXISTS audit_logs_target ON audit_logs (target_type, target_id, occurred_at DESC);
   CREATE INDEX IF NOT EXISTS audit_logs_request ON audit_logs (request_id) WHERE request_id IS NOT NULL;
  `,
  // JavaScript normalization matches the API's normalizeEmail (trim + Unicode lowercase), unlike
  // SQLite's built-in lower(), which is ASCII-only unless compiled with ICU.
  apply(db){
   const rows=db.prepare('SELECT id,email FROM accounts').all() as Array<{id:string;email:string}>;
   const update=db.prepare('UPDATE accounts SET normalized_email = ? WHERE id = ?');
   for(const row of rows)update.run(String(row.email).trim().toLowerCase(),row.id);
   db.exec('CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_normalized ON accounts (normalized_email)');
  },
 },
 {
  version:3,
  name:'email-invitations-password-recovery-and-account-roles',
  sql:`
   ALTER TABLE accounts ADD COLUMN activated_at INTEGER;
   CREATE TABLE IF NOT EXISTS account_roles (
    account_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user','beta_reviewer')),
    granted_at INTEGER NOT NULL,
    granted_by TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (account_id,role)
   );
   CREATE INDEX IF NOT EXISTS account_roles_role ON account_roles (role,account_id);
   CREATE TABLE IF NOT EXISTS password_recovery_tokens (
    token_digest TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
   );
   CREATE INDEX IF NOT EXISTS recovery_account_expiry ON password_recovery_tokens (account_id,expires_at);
   CREATE TABLE IF NOT EXISTS email_outbox (
    id TEXT PRIMARY KEY,
    template TEXT NOT NULL CHECK (template IN ('invitation','password_recovery')),
    recipient_digest TEXT NOT NULL,
    payload_ciphertext TEXT NOT NULL,
    payload_iv TEXT NOT NULL,
    payload_tag TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    sent_at INTEGER,
    last_error_code TEXT
   );
   CREATE INDEX IF NOT EXISTS email_outbox_pending ON email_outbox (next_attempt_at,created_at) WHERE sent_at IS NULL;
  `,
  apply(db){
   // Adopt already-activated accounts without forcing an unnecessary password reset.
   db.exec("UPDATE accounts SET activated_at = COALESCE(last_login_at,created_at) WHERE status = 'approved' AND password IS NOT NULL AND activated_at IS NULL");
   db.exec("INSERT OR IGNORE INTO account_roles (account_id,role,granted_at,granted_by) SELECT id,'user',COALESCE(activated_at,created_at),'migration' FROM accounts WHERE activated_at IS NOT NULL");
  },
 },
];

/** Apply pending migrations atomically, recording each version in SQLite's built-in user_version. */
export function migrateAccountDatabase(db:DatabaseSync):number{
 let current=Number((db.prepare('PRAGMA user_version').get() as {user_version?:number}|undefined)?.user_version||0);
 if(current>ACCOUNT_DB_SCHEMA_VERSION) throw new Error(`Account database schema ${current} is newer than this application supports (maximum ${ACCOUNT_DB_SCHEMA_VERSION}).`);
 for(const migration of MIGRATIONS){
  if(migration.version<=current) continue;
  db.exec('BEGIN IMMEDIATE');
  try{
   db.exec(migration.sql);
   migration.apply?.(db);
   db.exec(`PRAGMA user_version = ${migration.version}`);
   db.exec('COMMIT');
   current=migration.version;
  }catch(error){
   try{db.exec('ROLLBACK')}catch{}
   const reason=error instanceof Error?error.message:String(error);
   if(migration.version===2&&/(accounts_email_normalized|normalized_email)/i.test(reason)){
    throw new Error(`Account migration ${migration.version} (${migration.name}) could not create the normalized email uniqueness index. Back up the database, resolve duplicate emails after trimming and case normalization, then retry. No rows were changed. Original SQLite error: ${reason}`);
   }
   throw new Error(`Account migration ${migration.version} (${migration.name}) failed; the migration was rolled back. Original SQLite error: ${reason}`);
  }
 }
 return current;
}
