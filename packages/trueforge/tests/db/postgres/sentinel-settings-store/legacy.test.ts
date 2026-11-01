import { sql } from 'kysely';

import { PostgresSentinelSettingsStore } from '../../../../src/db/postgres/sentinel-settings-store/PostgresSentinelSettingsStore';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

describePg('PostgresSentinelSettingsStore with a legacy stored row', () => {
  let env: PostgresTestDatabase | undefined;

  beforeAll(async () => {
    env = await createPostgresTestDatabase();
    if (env === undefined) {
      throw new Error('Postgres test environment unavailable despite globalSetup probe');
    }
  }, 120_000);

  afterAll(async () => {
    await env?.teardown();
  });

  beforeEach(async () => {
    if (env !== undefined) {
      await sql`TRUNCATE TABLE sentinel_user_settings`.execute(env.db);
    }
  });

  it('drops a kind that no longer exists and keeps the ones that do', async () => {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    await sql`
      INSERT INTO sentinel_user_settings (tenant_id, created_by, offline_mode, tier2_auto_allow, created_at, updated_at)
      VALUES ('t1', 'alice', true, '["shell","file_write"]'::jsonb, now(), now())
    `.execute(env.db);

    const store = new PostgresSentinelSettingsStore(env.db);
    expect(await store.get({ tenant_id: 't1', created_by: 'alice' })).toEqual({
      offline_mode: true,
      tier2_auto_allow: ['file_write'],
      search_without_asking: true,
      maps_without_asking: false,
      sandbox_without_asking: true,
      chat_search_enabled: false,
    });
  });

  it('reads a row holding only the removed shell kind as nothing relaxed', async () => {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    await sql`
      INSERT INTO sentinel_user_settings (tenant_id, created_by, offline_mode, tier2_auto_allow, created_at, updated_at)
      VALUES ('t1', 'bob', false, '["shell"]'::jsonb, now(), now())
    `.execute(env.db);

    const store = new PostgresSentinelSettingsStore(env.db);
    expect((await store.get({ tenant_id: 't1', created_by: 'bob' })).tier2_auto_allow).toEqual([]);
  });
});
