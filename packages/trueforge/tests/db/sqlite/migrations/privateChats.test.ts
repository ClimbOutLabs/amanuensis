/**
 * `20261105_000001_private_chats` adds the private chat columns and the table that keeps a deleted
 * chat's token counts. Chats that already exist stay normal chats, the columns hold the rule that
 * a private chat always has an expiry, and the migration rolls back cleanly.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sql, type Kysely } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

import { createSqliteDb } from '../../../../src/db/sqlite/client';
import type { Database } from '../../../../src/db/sqlite/types';

const PREVIOUS_MIGRATION = '20261102_000004_delivery';

function createMigrator(db: Kysely<Database>): Migrator {
  return new Migrator({
    db,
    allowUnorderedMigrations: true,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(import.meta.dirname, '..', '..', '..', '..', 'src', 'db', 'sqlite', 'migrations'),
    }),
  });
}

async function insertSession(
  db: Kysely<Database>,
  input: { sessionId: string; columns?: { is_incognito: number; private_expires_at: string | null } },
): Promise<void> {
  if (input.columns === undefined) {
    await sql`
      INSERT INTO session (
        tenant_id, session_id, created_by_subject, agent_spec, approval_grants,
        last_activity_timestamp_ms, created_at, updated_at
      )
      VALUES (
        't1', ${input.sessionId}, jsonb('{"subject_id":"alice","subject_type":"user"}'), CAST('{}' AS BLOB),
        jsonb('[]'), 0, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'
      )
    `.execute(db);
    return;
  }
  await sql`
    INSERT INTO session (
      tenant_id, session_id, created_by_subject, agent_spec, approval_grants,
      last_activity_timestamp_ms, created_at, updated_at, is_incognito, private_expires_at
    )
    VALUES (
      't1', ${input.sessionId}, jsonb('{"subject_id":"alice","subject_type":"user"}'), CAST('{}' AS BLOB),
      jsonb('[]'), 0, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z',
      ${input.columns.is_incognito}, ${input.columns.private_expires_at}
    )
  `.execute(db);
}

async function sessionColumns(db: Kysely<Database>): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`SELECT name FROM pragma_table_info('session')`.execute(db);
  return rows.map(row => row.name);
}

async function tableExists(db: Kysely<Database>, name: string): Promise<boolean> {
  const { rows } = await sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}
  `.execute(db);
  return rows.length === 1;
}

describe('SQLite private chats migration', () => {
  let tempDir: string;
  let db: Kysely<Database>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-sqlite-private-chats-'));
    db = createSqliteDb(path.join(tempDir, 'store.sqlite'));
  }, 120_000);

  afterEach(async () => {
    await db.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('keeps existing chats normal, holds the expiry rule, and rolls back', async () => {
    const migrator = createMigrator(db);
    expect((await migrator.migrateTo(PREVIOUS_MIGRATION)).error).toBeUndefined();
    await insertSession(db, { sessionId: 'older-chat' });

    expect((await migrator.migrateToLatest()).error).toBeUndefined();
    expect(await sessionColumns(db)).toEqual(expect.arrayContaining(['is_incognito', 'private_expires_at']));
    expect(await tableExists(db, 'deleted_chat_model_usage')).toBe(true);
    const { rows } = await sql<{ is_incognito: number; private_expires_at: string | null }>`
      SELECT is_incognito, private_expires_at FROM session WHERE session_id = 'older-chat'
    `.execute(db);
    expect(rows).toEqual([{ is_incognito: 0, private_expires_at: null }]);

    await insertSession(db, {
      sessionId: 'private-chat',
      columns: { is_incognito: 1, private_expires_at: '2026-11-06T00:00:00.000Z' },
    });
    await expect(
      insertSession(db, { sessionId: 'no-expiry', columns: { is_incognito: 1, private_expires_at: null } }),
    ).rejects.toThrow();
    await expect(
      insertSession(db, {
        sessionId: 'expiry-only',
        columns: { is_incognito: 0, private_expires_at: '2026-11-06T00:00:00.000Z' },
      }),
    ).rejects.toThrow();

    expect((await migrator.migrateTo(PREVIOUS_MIGRATION)).error).toBeUndefined();
    expect(await sessionColumns(db)).not.toContain('is_incognito');
    expect(await sessionColumns(db)).not.toContain('private_expires_at');
    expect(await tableExists(db, 'deleted_chat_model_usage')).toBe(false);
    expect((await migrator.migrateToLatest()).error).toBeUndefined();
    expect(await sessionColumns(db)).toContain('is_incognito');
  });
});
