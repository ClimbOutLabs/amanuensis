import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { z } from 'zod';

import { backupCheck, createBackupCheck } from '../../../src/cli/backupCheck';
import { UsageError } from '../../../src/cli/io';
import { knownSqliteMigrationNames } from '../../../src/db/migrateSqlite';
import { createSqliteTestDatabase } from '../../db/sqlite/testDatabase';
import { fakeIo } from './fakeIo';

const ResultSchema = z.object({ newer: z.boolean(), unknown_migrations: z.array(z.string()) });

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'aman-backup-check-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function databaseWith(names: readonly string[]): string {
  const file = path.join(scratch, 'db.sqlite');
  const db = new Database(file);
  db.exec('CREATE TABLE kysely_migration (name TEXT PRIMARY KEY, timestamp TEXT NOT NULL)');
  const insert = db.prepare("INSERT INTO kysely_migration (name, timestamp) VALUES (?, '2026-10-10T00:00:00.000Z')");
  for (const name of names) {
    insert.run(name);
  }
  db.close();
  return file;
}

async function check(options: { file: string; known: readonly string[] }): Promise<z.infer<typeof ResultSchema>> {
  const io = fakeIo();
  const command = createBackupCheck({ knownMigrations: () => Promise.resolve([...options.known]) });
  expect(await command({ args: ['--sqlite', options.file], io })).toBe(0);
  return ResultSchema.parse(JSON.parse(io.out.join('')));
}

describe('backup-check', () => {
  it('accepts a database made by this build, as migrated', async () => {
    const database = await createSqliteTestDatabase();
    try {
      const io = fakeIo();
      expect(await backupCheck({ args: ['--sqlite', database.databaseFile], io })).toBe(0);
      expect(ResultSchema.parse(JSON.parse(io.out.join('')))).toEqual({ newer: false, unknown_migrations: [] });
    } finally {
      await database.teardown();
    }
  });

  it('accepts a database from an older build, which this build only migrates further', async () => {
    const known = await knownSqliteMigrationNames();
    expect(known.length).toBeGreaterThan(1);
    expect(await check({ file: databaseWith(known.slice(0, 1)), known })).toEqual({
      newer: false,
      unknown_migrations: [],
    });
  });

  it('names the migrations a newer build ran, which this build does not ship', async () => {
    const file = databaseWith(['20260101_000001_first', '29991231_000002_later', '29991231_000001_later']);
    expect(await check({ file, known: ['20260101_000001_first'] })).toEqual({
      newer: true,
      unknown_migrations: ['29991231_000001_later', '29991231_000002_later'],
    });
  });

  it('treats a database that never ran a migration as not newer', async () => {
    const file = path.join(scratch, 'empty.sqlite');
    new Database(file).close();
    expect(await check({ file, known: ['20260101_000001_first'] })).toEqual({ newer: false, unknown_migrations: [] });
  });

  it('opens the backup read-only and refuses a missing file', async () => {
    const io = fakeIo();
    await expect(backupCheck({ args: ['--sqlite', path.join(scratch, 'none.sqlite')], io })).rejects.toThrow();
  });

  it('refuses a missing or unknown flag as a usage error', async () => {
    await expect(backupCheck({ args: [], io: fakeIo() })).rejects.toBeInstanceOf(UsageError);
    await expect(backupCheck({ args: ['--target', 'x'], io: fakeIo() })).rejects.toBeInstanceOf(UsageError);
  });
});
