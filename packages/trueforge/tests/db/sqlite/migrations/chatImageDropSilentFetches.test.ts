/**
 * `20261021_000001_chat_image_drop_silent_fetches` removes the silent-fetch counter and the
 * `remote_silent` origin. A database migrated with the earlier chat image migration must end with
 * the same schema as a fresh one, keep the images people can see, and roll back cleanly.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sql, type Kysely } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

import { createSqliteDb } from '../../../../src/db/sqlite/client';
import type { Database } from '../../../../src/db/sqlite/types';

const PREVIOUS_MIGRATION = '20261020_000001_sentinel_maps_without_asking';

async function createMigrator(db: Kysely<Database>): Promise<Migrator> {
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

async function insertSession(db: Kysely<Database>): Promise<void> {
  await sql`
    INSERT INTO session (
      tenant_id, session_id, created_by_subject, agent_spec, approval_grants,
      last_activity_timestamp_ms, created_at, updated_at
    )
    VALUES (
      't1', 's1', jsonb('{"subject_id":"alice","subject_type":"user"}'), CAST('{}' AS BLOB), jsonb('[]'), 0,
      '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'
    )
  `.execute(db);
}

async function insertImage(db: Kysely<Database>, imageId: string, origin: string): Promise<void> {
  await sql`
    INSERT INTO chat_image (
      tenant_id, created_by, session_id, turn_id, image_id, source_key,
      origin, mime, width, height, size, data, created_at
    )
    VALUES (
      't1', 'alice', 's1', 'turn1', ${imageId}, ${`source-${imageId}`},
      ${origin}, 'image/png', 1, 1, 3, ${Buffer.from([1, 2, 3])}, '2026-10-01T00:00:00.000Z'
    )
  `.execute(db);
}

interface ChatImageSchema {
  tables: string[];
  columns: unknown[];
  indexes: unknown[];
  foreignKeys: unknown[];
}

// Index names are left out: the rebuilt table gets its own names for the implicit unique index.
async function chatImageSchema(db: Kysely<Database>): Promise<ChatImageSchema> {
  const tables = await sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
  `.execute(db);
  const columns = await sql`PRAGMA table_info(chat_image)`.execute(db);
  const indexList = await sql<{ name: string; unique: number; origin: string; partial: number }>`
    PRAGMA index_list(chat_image)
  `.execute(db);
  const indexes = await Promise.all(
    indexList.rows.map(async index => {
      const info = await sql<{ name: string }>`PRAGMA index_info(${sql.raw(`'${index.name}'`)})`.execute(db);
      return {
        unique: index.unique,
        origin: index.origin,
        partial: index.partial,
        columns: info.rows.map(row => row.name),
      };
    }),
  );
  const foreignKeys = await sql`PRAGMA foreign_key_list(chat_image)`.execute(db);
  return {
    tables: tables.rows.map(row => row.name),
    columns: columns.rows,
    indexes,
    foreignKeys: foreignKeys.rows,
  };
}

async function imageOrigins(db: Kysely<Database>): Promise<Array<{ image_id: string; origin: string; data: Buffer }>> {
  const { rows } = await sql<{ image_id: string; origin: string; data: Buffer }>`
    SELECT image_id, origin, data FROM chat_image ORDER BY image_id
  `.execute(db);
  return rows;
}

describe('20261021_000001_chat_image_drop_silent_fetches migration', () => {
  let tempDir: string;
  let migrated: Kysely<Database>;
  let fresh: Kysely<Database>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-sqlite-chat-image-'));
    migrated = createSqliteDb(path.join(tempDir, 'migrated.sqlite'));
    fresh = createSqliteDb(path.join(tempDir, 'fresh.sqlite'));
  }, 120_000);

  afterEach(async () => {
    await migrated.destroy();
    await fresh.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('keeps the images people can see, drops silent ones, and removes the turn allowance table', async () => {
    const migrator = await createMigrator(migrated);
    expect((await migrator.migrateTo(PREVIOUS_MIGRATION)).error).toBeUndefined();

    await insertSession(migrated);
    await insertImage(migrated, 'local-image', 'local');
    await insertImage(migrated, 'approved-image', 'remote_approved');
    await insertImage(migrated, 'silent-image', 'remote_silent');
    await sql`
      INSERT INTO chat_image_turn_allowance (tenant_id, session_id, turn_id, silent_attempts)
      VALUES ('t1', 's1', 'turn1', 2)
    `.execute(migrated);

    expect((await migrator.migrateToLatest()).error).toBeUndefined();

    const images = await imageOrigins(migrated);
    expect(images.map(image => [image.image_id, image.origin])).toEqual([
      ['approved-image', 'remote_approved'],
      ['local-image', 'local'],
    ]);
    expect(images[1]?.data).toEqual(Buffer.from([1, 2, 3]));
    expect((await chatImageSchema(migrated)).tables).not.toContain('chat_image_turn_allowance');
  });

  it('ends with the same schema as a fresh database', async () => {
    expect((await (await createMigrator(migrated)).migrateTo(PREVIOUS_MIGRATION)).error).toBeUndefined();
    await insertSession(migrated);
    await insertImage(migrated, 'silent-image', 'remote_silent');
    expect((await (await createMigrator(migrated)).migrateToLatest()).error).toBeUndefined();

    expect((await (await createMigrator(fresh)).migrateToLatest()).error).toBeUndefined();

    expect(await chatImageSchema(migrated)).toEqual(await chatImageSchema(fresh));
  });

  it('rejects the silent origin once the migration has run', async () => {
    expect((await (await createMigrator(fresh)).migrateToLatest()).error).toBeUndefined();
    await insertSession(fresh);

    await expect(insertImage(fresh, 'silent-image', 'remote_silent')).rejects.toThrow();
    await expect(insertImage(fresh, 'approved-image', 'remote_approved')).resolves.toBeUndefined();
  });

  it('rolls back to the previous schema and keeps the images that remain', async () => {
    const migrator = await createMigrator(migrated);
    expect((await migrator.migrateToLatest()).error).toBeUndefined();
    await insertSession(migrated);
    await insertImage(migrated, 'approved-image', 'remote_approved');

    expect((await migrator.migrateTo(PREVIOUS_MIGRATION)).error).toBeUndefined();

    expect((await chatImageSchema(migrated)).tables).toContain('chat_image_turn_allowance');
    expect((await imageOrigins(migrated)).map(image => image.image_id)).toEqual(['approved-image']);
    await expect(insertImage(migrated, 'silent-image', 'remote_silent')).resolves.toBeUndefined();
  });
});
