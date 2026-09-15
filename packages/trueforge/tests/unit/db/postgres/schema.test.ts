import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { TABLES_TO_MOVE } from '../../../../src/db/postgres/schema';

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', '..', 'src', 'db', 'postgres', 'migrations');

/** Matches `.createTable('name')` (Kysely schema builder). */
const CREATE_TABLE_BUILDER = /\.createTable\(\s*['"]([a-zA-Z0-9_]+)['"]/g;
/** Matches raw `CREATE TABLE [IF NOT EXISTS] name (` (hand-written SQL migrations). */
const CREATE_TABLE_RAW = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-zA-Z0-9_]+)\s*\(/gi;

function tableNamesCreatedByMigrations(): Set<string> {
  const created = new Set<string>();
  for (const fileName of readdirSync(MIGRATIONS_DIR)) {
    if (!fileName.endsWith('.ts')) {
      continue;
    }
    const contents = readFileSync(path.join(MIGRATIONS_DIR, fileName), 'utf8');
    for (const match of contents.matchAll(CREATE_TABLE_BUILDER)) {
      const tableName = match[1];
      if (tableName !== undefined) {
        created.add(tableName);
      }
    }
    for (const match of contents.matchAll(CREATE_TABLE_RAW)) {
      const tableName = match[1];
      if (tableName !== undefined) {
        created.add(tableName);
      }
    }
  }
  return created;
}

describe('TABLES_TO_MOVE', () => {
  it('lists every table created by a Postgres migration', () => {
    const createdTables = tableNamesCreatedByMigrations();
    expect(createdTables.size).toBeGreaterThan(0);

    const tablesToMove = new Set<string>(TABLES_TO_MOVE);
    const missing = [...createdTables].filter(tableName => !tablesToMove.has(tableName));
    expect(missing).toEqual([]);
  });

  it('has no duplicate entries', () => {
    expect(new Set(TABLES_TO_MOVE).size).toBe(TABLES_TO_MOVE.length);
  });
});
