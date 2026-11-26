/**
 * `20261125_000001_goal_target_has_time` adds the target_has_time column to goal. Rolling it
 * back rebuilds the goal table without the column, so the goals already stored and the rows
 * that belong to them must survive the round trip in both directions.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sql, type Kysely } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

import { createSqliteDb } from '../../../../src/db/sqlite/client';
import type { Database } from '../../../../src/db/sqlite/types';

const PREVIOUS_MIGRATION = '20261118_000001_goals';

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

async function insertGoal(db: Kysely<Database>): Promise<void> {
  await sql`
    INSERT INTO goal (
      goal_id, tenant_id, created_by, persona_id, title, outcome, success_criteria,
      target_at, timezone, lifecycle, revision, execution_policy, notification_policy,
      target_has_time, created_at, updated_at
    )
    VALUES (
      'g1', 't1', 'alice', 'p1', 'Ship the thing', 'It is shipped', '[]',
      '2026-12-20T08:00:00.000Z', 'America/Los_Angeles', 'draft', 1, '{}', '{}',
      1, '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z'
    )
  `.execute(db);
}

async function insertStep(db: Kysely<Database>, stepId: string): Promise<void> {
  await sql`
    INSERT INTO goal_step (
      step_id, goal_id, description, depends_on, status, acceptance_criteria,
      evidence_ids, revision, created_at, updated_at
    )
    VALUES (
      ${stepId}, 'g1', 'Do the step', '[]', 'pending', '[]',
      '[]', 1, '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z'
    )
  `.execute(db);
}

async function goalColumns(db: Kysely<Database>): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`PRAGMA table_info(goal)`.execute(db);
  return rows.map(row => row.name);
}

async function goalTitles(db: Kysely<Database>): Promise<string[]> {
  const { rows } = await sql<{ title: string }>`SELECT title FROM goal ORDER BY goal_id`.execute(db);
  return rows.map(row => row.title);
}

async function stepIds(db: Kysely<Database>): Promise<string[]> {
  const { rows } = await sql<{ step_id: string }>`SELECT step_id FROM goal_step ORDER BY step_id`.execute(db);
  return rows.map(row => row.step_id);
}

describe('20261125_000001_goal_target_has_time migration', () => {
  let tempDir: string;
  let db: Kysely<Database>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-sqlite-goal-target-'));
    db = createSqliteDb(path.join(tempDir, 'migrated.sqlite'));
  }, 120_000);

  afterEach(async () => {
    await db.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('rolls back one step, keeps the goals and their steps, and migrates forward again', async () => {
    const migrator = await createMigrator(db);
    expect((await migrator.migrateToLatest()).error).toBeUndefined();
    await insertGoal(db);
    await insertStep(db, 'step-before');
    expect(await goalColumns(db)).toContain('target_has_time');

    expect((await migrator.migrateTo(PREVIOUS_MIGRATION)).error).toBeUndefined();

    expect(await goalColumns(db)).not.toContain('target_has_time');
    expect(await goalTitles(db)).toEqual(['Ship the thing']);
    expect(await stepIds(db)).toEqual(['step-before']);
    await expect(insertStep(db, 'step-after-rollback')).resolves.toBeUndefined();

    expect((await migrator.migrateToLatest()).error).toBeUndefined();

    expect(await goalColumns(db)).toContain('target_has_time');
    expect(await goalTitles(db)).toEqual(['Ship the thing']);
    expect(await stepIds(db)).toEqual(['step-after-rollback', 'step-before']);
  });
});
