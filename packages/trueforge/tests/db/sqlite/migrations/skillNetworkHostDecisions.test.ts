/**
 * `20261112_000002_skill_network_host_decisions` adds the sites allowed and turned down one by
 * one for a skill. An install that already has skills must upgrade, and its skills start with
 * empty lists.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sql, type Kysely } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

import { createSqliteDb } from '../../../../src/db/sqlite/client';
import { SqliteSkillStore } from '../../../../src/db/sqlite/skill-store/SqliteSkillStore';
import type { Database } from '../../../../src/db/sqlite/types';

const PREVIOUS_MIGRATION = '20261112_000002_mcp_tool_grant_connector_binding';
const THIS_MIGRATION = '20261112_000002_skill_network_host_decisions';

const MANIFEST = JSON.stringify({
  type: 'git',
  name: 'daily-notes',
  url: 'https://github.com/example/daily-notes',
  ref: 'main',
  description: 'Fetches the notes for today.',
});

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

describe('20261112_000002_skill_network_host_decisions migration', () => {
  let tempDir: string;
  let db: Kysely<Database>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-sqlite-skill-sites-'));
    db = createSqliteDb(path.join(tempDir, 'store.sqlite'));
  }, 120_000);

  afterEach(async () => {
    await db.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function addSkillBeforeUpgrade(migrator: Migrator): Promise<void> {
    expect((await migrator.migrateTo(PREVIOUS_MIGRATION)).error).toBeUndefined();
    await sql`
      INSERT INTO skill (tenant_id, name, manifest, created_at, updated_at)
      VALUES ('t1', 'daily-notes', jsonb(${MANIFEST}), '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')
    `.execute(db);
  }

  it('upgrades an install that already has a skill, which starts with no sites allowed or turned down', async () => {
    const migrator = await createMigrator(db);
    await addSkillBeforeUpgrade(migrator);

    expect((await migrator.migrateToLatest()).error).toBeUndefined();

    const skills = await new SqliteSkillStore(db).listSkills({ tenant_id: 't1', names: ['daily-notes'] });
    expect(skills.map(skill => [skill.name, skill.network_allowed_hosts, skill.network_denied_hosts])).toEqual([
      ['daily-notes', [], []],
    ]);
  });

  it('keeps a site decision made after the upgrade', async () => {
    const migrator = await createMigrator(db);
    await addSkillBeforeUpgrade(migrator);
    expect((await migrator.migrateToLatest()).error).toBeUndefined();

    const store = new SqliteSkillStore(db);
    await store.setSkillNetworkHostDecision({
      tenant_id: 't1',
      name: 'daily-notes',
      host: 'notes.example.com',
      decision: 'denied',
    });

    const [skill] = await store.listSkills({ tenant_id: 't1', names: ['daily-notes'] });
    expect(skill?.network_denied_hosts).toEqual(['notes.example.com']);
  });

  it('migrates down and back with the skill kept', async () => {
    const migrator = await createMigrator(db);
    await addSkillBeforeUpgrade(migrator);
    expect((await migrator.migrateTo(THIS_MIGRATION)).error).toBeUndefined();
    expect((await migrator.migrateTo(PREVIOUS_MIGRATION)).error).toBeUndefined();
    expect((await migrator.migrateTo(THIS_MIGRATION)).error).toBeUndefined();

    // Read the row directly: the store reads columns that later migrations add.
    const skills = await sql<{ name: string }>`SELECT name FROM skill WHERE tenant_id = 't1'`.execute(db);
    expect(skills.rows.map(skill => skill.name)).toEqual(['daily-notes']);
  });
});
