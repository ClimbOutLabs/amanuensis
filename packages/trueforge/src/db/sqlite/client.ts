import Database from 'better-sqlite3-multiple-ciphers';
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
  type SqliteDatabase,
  type TransactionSettings,
} from 'kysely';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { errorCode } from '../../cli/errorCode';
import type { Database as Schema } from './types';

const STATEMENT_CACHE_SIZE = 200;

/**
 * Kysely's SqliteDriver prepares a new statement for every query. Each statement holds native
 * SQLite memory that is freed only when V8 collects its small JS wrapper, so a busy run (an
 * import, a burst of requests) piles up hundreds of MB before a GC. Reusing one statement per
 * SQL text keeps that flat. A statement still being iterated is busy, so that caller gets a
 * fresh one instead of sharing it.
 */
export function cacheStatements({
  database,
  maxSize,
}: {
  database: Database.Database;
  maxSize: number;
}): SqliteDatabase {
  const cache = new Map<string, Database.Statement>();
  const prepare = (sql: string): Database.Statement => {
    const cached = cache.get(sql);
    if (cached !== undefined) {
      cache.delete(sql);
      if (!cached.busy) {
        cache.set(sql, cached);
        return cached;
      }
    }
    const statement = database.prepare(sql);
    cache.set(sql, statement);
    if (cache.size > maxSize) {
      const oldest = cache.keys().next();
      if (oldest.done !== true) {
        cache.delete(oldest.value);
      }
    }
    return statement;
  };
  return { close: () => database.close(), prepare };
}

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
    this.#inner = new SqliteDriver({ database: cacheStatements({ database, maxSize: STATEMENT_CACHE_SIZE }) });
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

/** The database file is encrypted and the key given, if any, is not its key. */
export class DatabaseKeyError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      'The database is encrypted and this computer\'s key does not open it. Run "aman doctor" to see how to fix it.',
      options,
    );
    this.name = 'DatabaseKeyError';
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
  // A deleted chat's words are overwritten on disk, not left in free pages a file reader could recover.
  database.pragma('secure_delete = ON');
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
  'last_check',
  'network_approval',
  'network_allowed_hosts',
  'network_denied_hosts',
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

/** Gives an open connection the key of an encrypted database file. Must run before anything is read. */
function applyKey({ database, key }: { database: Database.Database; key: Buffer }): void {
  database.pragma("cipher = 'chacha20'");
  database.pragma(`key = 'raw:${key.toString('hex')}'`);
}

/**
 * A plain connection to a database file, for the few commands that do not go through Kysely.
 * With `key`, the file is read and written encrypted; a wrong or missing key fails on first read.
 */
export function openSqliteFile({
  filename,
  key,
  readonly = false,
  fileMustExist = true,
  timeoutMs,
}: {
  filename: string;
  key: Buffer | undefined;
  readonly?: boolean;
  fileMustExist?: boolean;
  timeoutMs?: number;
}): Database.Database {
  const database = new Database(filename, {
    readonly,
    fileMustExist,
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
  });
  if (key !== undefined) {
    applyKey({ database, key });
  }
  return database;
}

// By code, not by class: the driver's error class is not the same object in every loaded copy of it.
function isNotADatabase(caught: unknown): boolean {
  return errorCode(caught) === 'SQLITE_NOTADB';
}

function opens({ filename, key }: { filename: string; key: Buffer | undefined }): boolean {
  const database = openSqliteFile({ filename, key, readonly: true });
  try {
    database.pragma('schema_version');
    return true;
  } catch (caught) {
    if (isNotADatabase(caught)) {
      return false;
    }
    throw caught;
  } finally {
    database.close();
  }
}

/**
 * How a database file is stored: `missing`, readable by anyone (`plain`), encrypted with `key`
 * (`encrypted`), or neither, which means another key encrypted it (`other_key`).
 */
export function sqliteFileState({
  filename,
  key,
}: {
  filename: string;
  key: Buffer;
}): 'missing' | 'plain' | 'encrypted' | 'other_key' {
  if (!existsSync(filename)) {
    return 'missing';
  }
  if (opens({ filename, key })) {
    return 'encrypted';
  }
  return opens({ filename, key: undefined }) ? 'plain' : 'other_key';
}

const IN_USE = 'The database is in use. Stop Aman, then run this again.';

/**
 * Rewrites every page of a database file under `to`, in place: from readable to encrypted when
 * `from` is undefined, or from one key to another. Nothing else may have the file open, because
 * the pages still waiting in the write-ahead log have to be folded in first.
 */
export function rekeySqliteFile({
  filename,
  from,
  to,
}: {
  filename: string;
  from: Buffer | undefined;
  to: Buffer;
}): void {
  const database = openSqliteFile({ filename, key: from, timeoutMs: 5000 });
  try {
    database.pragma('wal_checkpoint(TRUNCATE)');
    // Stays in write-ahead mode while another program has the file open.
    if (database.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') {
      throw new Error(IN_USE);
    }
    database.pragma("cipher = 'chacha20'");
    database.pragma(`rekey = 'raw:${to.toString('hex')}'`);
  } catch (caught) {
    const code = errorCode(caught);
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
      throw new Error(IN_USE, { cause: caught });
    }
    throw caught;
  } finally {
    database.close();
  }
}

export function createSqliteDb(filename: string, options: { key?: Buffer | undefined } = {}): Kysely<Schema> {
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
  if (options.key !== undefined) {
    applyKey({ database, key: options.key });
  }
  try {
    applyPragmas(database);
  } catch (caught) {
    database.close();
    if (isNotADatabase(caught)) {
      throw new DatabaseKeyError({ cause: caught });
    }
    throw caught;
  }
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
