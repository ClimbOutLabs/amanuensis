import Database from 'better-sqlite3';
import {
  CompiledQuery,
  Kysely,
  ParseJSONResultsPlugin,
  SqliteAdapter,
  SqliteDriver,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryCompiler,
  type TransactionSettings,
} from 'kysely';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Database as Schema } from './types';

/**
 * Wraps SqliteDriver and maps Kysely access mode onto SQLite begin kinds:
 * - omit / `read only` → deferred BEGIN (matches Postgres default feel)
 * - `read write` → BEGIN IMMEDIATE (RESERVED write lock)
 *
 * Stock SqliteDriver.d.ts omits `settings` on beginTransaction; compose instead of override.
 */
class ImmediateSqliteDriver implements Driver {
  readonly #inner: SqliteDriver;

  constructor(database: Database.Database) {
    this.#inner = new SqliteDriver({ database });
  }

  init(): Promise<void> {
    return this.#inner.init();
  }

  acquireConnection(): Promise<DatabaseConnection> {
    return this.#inner.acquireConnection();
  }

  async beginTransaction(connection: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    const begin = settings.accessMode === 'read write' ? 'begin immediate' : 'begin';
    await connection.executeQuery(CompiledQuery.raw(begin));
  }

  commitTransaction(connection: DatabaseConnection): Promise<void> {
    return this.#inner.commitTransaction(connection);
  }

  rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    return this.#inner.rollbackTransaction(connection);
  }

  savepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler['compileQuery'],
  ): Promise<void> {
    return this.#inner.savepoint(connection, savepointName, compileQuery);
  }

  rollbackToSavepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler['compileQuery'],
  ): Promise<void> {
    return this.#inner.rollbackToSavepoint(connection, savepointName, compileQuery);
  }

  releaseSavepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler['compileQuery'],
  ): Promise<void> {
    return this.#inner.releaseSavepoint(connection, savepointName, compileQuery);
  }

  releaseConnection(): Promise<void> {
    return this.#inner.releaseConnection();
  }

  destroy(): Promise<void> {
    return this.#inner.destroy();
  }
}

class ImmediateSqliteDialect implements Dialect {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  createDriver(): Driver {
    return new ImmediateSqliteDriver(this.#database);
  }

  createQueryCompiler() {
    return new SqliteQueryCompiler();
  }

  createAdapter() {
    return new SqliteAdapter();
  }

  createIntrospector(db: Kysely<unknown>) {
    return new SqliteIntrospector(db);
  }
}

function applyPragmas(database: Database.Database): void {
  database.pragma('journal_mode = WAL');
  // Autocheckpoint ~4 MiB; leftover WAL 64 MiB after checkpoint (Rails/common WAL-app default).
  database.pragma('wal_autocheckpoint = 1000');
  database.pragma('journal_size_limit = 67108864');
  database.pragma('busy_timeout = 5000');
  database.pragma('synchronous = NORMAL');
  database.pragma('foreign_keys = ON');
  database.pragma('temp_store = MEMORY');
  database.pragma('cache_size = -10240');
}

/**
 * Result aliases that are `json(...)` projections of JSONB columns.
 * Plain TEXT (title, ids, timestamps) must not be parsed even when they look like JSON.
 */
const JSON_RESULT_COLUMNS = new Set([
  'agent_spec',
  'custom',
  'metadata',
  'metrics',
  'ancestor_ids',
  'input',
  'state',
  'checkpoint',
  'agent_info',
  'current_context_usage',
  'body',
  'capability_state',
  'turn_checkpoint',
  'turn_state',
  'thread_checkpoint',
  'event',
  'manifest',
  'metadata',
  'build_metadata',
  'oauth_server',
  'oauth_client',
  'token',
  'auth_data',
  'pinned_preferences',
  'help_areas',
  'tier2_auto_allow',
  'shell_binding',
  'approval_grants',
  'task_checklist',
  'aliases',
  'implementation_plan_grant',
  'created_by_subject',
  'source',
]);

/** Top-level row field only — `$[0]."body"`, not `$[0]."body"."content"`. */
function shouldParseJsonResultColumn(_value: string, jsonPath: string): boolean {
  const match = /^\$\[\d+\]\."([^"]+)"$/.exec(jsonPath);
  const column = match?.[1];
  return column !== undefined && JSON_RESULT_COLUMNS.has(column);
}

export function createSqliteDb(filename: string): Kysely<Schema> {
  const isMemoryDb = filename === ':memory:';
  const isNewFile = !isMemoryDb && !existsSync(filename);
  if (!isMemoryDb) {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    tightenSqlitePermissions(filename);
  }
  const database = new Database(filename);
  if (isNewFile) {
    chmodSync(filename, 0o600);
  }
  applyPragmas(database);
  return new Kysely<Schema>({
    dialect: new ImmediateSqliteDialect(database),
    // Parse only projected JSON columns once; never re-parse nested string values.
    plugins: [new ParseJSONResultsPlugin({ shouldParse: shouldParseJsonResultColumn })],
  });
}

/**
 * Tighten permissions on an existing SQLite database directory and files.
 * Only touches paths owned by the current user; never follows symlinks.
 * Directory goes to 0700; the database file plus -wal/-shm go to 0600.
 * Only tightens (never loosens); missing paths are skipped.
 */
function tightenSqlitePermissions(dbPath: string): void {
  tightenPathMode(dirname(dbPath), 0o700);
  for (const suffix of ['', '-wal', '-shm']) {
    tightenPathMode(`${dbPath}${suffix}`, 0o600);
  }
}

function tightenPathMode(target: string, mode: number): void {
  let stat;
  try {
    stat = lstatSync(target);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    return;
  }
  // Only tighten files we own; skip when ownership cannot be verified.
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    return;
  }
  const current = stat.mode & 0o777;
  if ((current & ~mode) !== 0) {
    chmodSync(target, mode);
  }
}

/**
 * Match better-sqlite3 unique constraint errors without brittle instanceof checks.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) {
    return false;
  }
  const code = err.code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}
