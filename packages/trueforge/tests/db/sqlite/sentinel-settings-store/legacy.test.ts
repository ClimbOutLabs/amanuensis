import { sql } from 'kysely';
import { SqliteSentinelSettingsStore } from '../../../../src/db/sqlite/sentinel-settings-store/SqliteSentinelSettingsStore';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('SqliteSentinelSettingsStore with a legacy stored row', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  it('drops a kind that no longer exists and keeps the ones that do', async () => {
    await sql`
      INSERT INTO sentinel_user_settings (tenant_id, created_by, offline_mode, tier2_auto_allow, created_at, updated_at)
      VALUES ('t1', 'alice', 1, jsonb('["shell","file_write"]'), '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')
    `.execute(env.db);

    const store = new SqliteSentinelSettingsStore(env.db);
    expect(await store.get({ tenant_id: 't1', created_by: 'alice' })).toEqual({
      offline_mode: true,
      tier2_auto_allow: ['file_write'],
      search_without_asking: true,
      maps_without_asking: false,
      sandbox_without_asking: true,
    });
  });

  it('reads a row holding only the removed shell kind as nothing relaxed', async () => {
    await sql`
      INSERT INTO sentinel_user_settings (tenant_id, created_by, offline_mode, tier2_auto_allow, created_at, updated_at)
      VALUES ('t1', 'bob', 0, jsonb('["shell"]'), '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')
    `.execute(env.db);

    const store = new SqliteSentinelSettingsStore(env.db);
    expect((await store.get({ tenant_id: 't1', created_by: 'bob' })).tier2_auto_allow).toEqual([]);
  });
});
