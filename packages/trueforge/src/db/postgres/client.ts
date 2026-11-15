import { Kysely, PostgresDialect } from 'kysely';
import pg, { Pool } from 'pg';

import { TRUEFORGE_SCHEMA } from './schema';
import type { Database } from './types';

const INT8_OID = 20;
/**
 * Postgres OID for `bigint[]` / `_int8`. Scalar int8 parser (OID 20) does NOT cover arrays.
 * Widened setter: node-pg's TypeId enum omits array OIDs.
 */
const setTypeParserByOid: (oid: number, parser: (value: string) => unknown) => void = pg.types.setTypeParser.bind(
  pg.types,
);

/**
 * Parse a Postgres array literal of int8 into number[].
 * Safe below Number.MAX_SAFE_INTEGER (2^53) — same contract as the scalar int8 parser.
 * Identity append_ids stay far below that bound.
 */
function parseInt8Array(value: string): number[] {
  if (value === '{}' || value === '') {
    return [];
  }
  // Plain unquoted numeric elements (bigint[] never needs quotes).
  return value
    .slice(1, -1)
    .split(',')
    .map(element => Number(element));
}

function configurePgTypeParsers(): void {
  pg.types.setTypeParser(INT8_OID, Number);
  setTypeParserByOid(1016, parseInt8Array);
}

export function createDb(options: {
  connectionString: string;
  poolMax: number;
  /** Postgres `statement_timeout` in ms. Applied to every pooled connection. */
  statementTimeoutMs: number;
  /** Postgres `idle_in_transaction_session_timeout` in ms. Applied to every pooled connection. */
  idleInTransactionSessionTimeoutMs: number;
  /**
   * How long a query waits for a connection, in ms. pg uses one limit for both opening a new
   * connection and waiting for a busy pool to free one, so it must cover a full pool of slow queries.
   */
  connectionTimeoutMs: number;
  /** Called when an idle pooled connection breaks (for example Postgres restarted). */
  onIdleClientError: (error: Error) => void;
}): Kysely<Database> {
  const {
    connectionString,
    poolMax,
    statementTimeoutMs,
    idleInTransactionSessionTimeoutMs,
    connectionTimeoutMs,
    onIdleClientError,
  } = options;
  configurePgTypeParsers();
  const pool = new Pool({
    connectionString,
    max: poolMax,
    connectionTimeoutMillis: connectionTimeoutMs,
    statement_timeout: statementTimeoutMs,
    idle_in_transaction_session_timeout: idleInTransactionSessionTimeoutMs,
    options: `-c search_path=${TRUEFORGE_SCHEMA}`,
  });
  // Idle clients emit 'error' when the backend closes; without a listener Node exits. The pool
  // drops that client and opens a fresh one for the next query.
  pool.on('error', onIdleClientError);
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool,
    }),
  });
}

/**
 * Match Postgres errors by SQLSTATE without `instanceof DatabaseError`.
 * instanceof breaks silently when two copies of pg-protocol load (version skew / dual CJS+ESM);
 * checking `code` is the conventional node-postgres pattern.
 */
export function isPgErrorCode(err: unknown, code: string): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) {
    return false;
  }
  return err.code === code;
}

export function isUniqueViolation(err: unknown): boolean {
  return isPgErrorCode(err, '23505');
}

/** Match a Postgres unique/PK violation to a named constraint or index. */
export function isPgConstraint(err: unknown, name: string): boolean {
  if (typeof err !== 'object' || err === null || !('constraint' in err)) {
    return false;
  }
  return err.constraint === name;
}
