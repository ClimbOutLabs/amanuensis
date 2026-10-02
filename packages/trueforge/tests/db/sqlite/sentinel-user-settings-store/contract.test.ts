import { SentinelUserSettingsStore } from '../../../../src/db/sentinelUserSettingsStore';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('SentinelUserSettingsStore', () => {
  let env: SqliteTestDatabase;
  let store: SentinelUserSettingsStore;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
    store = new SentinelUserSettingsStore(env.db as any);
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  it('returns defaults when no row exists', async () => {
    const settings = await store.get({ tenant_id: 't1', created_by: 'u1' });
    expect(settings.tier2_always_ask).toEqual([]);
    expect(settings.offline_mode).toBe(false);
  });

  it('upsert persists and get returns the settings', async () => {
    await store.upsert({
      tenant_id: 't1',
      created_by: 'u1',
      tier2_always_ask: ['shell', 'file_write'],
      offline_mode: true,
    });

    const settings = await store.get({ tenant_id: 't1', created_by: 'u1' });
    expect(settings.tier2_always_ask).toEqual(['shell', 'file_write']);
    expect(settings.offline_mode).toBe(true);
  });

  it('upsert merges with existing settings', async () => {
    await store.upsert({
      tenant_id: 't1',
      created_by: 'u1',
      tier2_always_ask: ['shell'],
    });
    await store.upsert({
      tenant_id: 't1',
      created_by: 'u1',
      offline_mode: true,
    });

    const settings = await store.get({ tenant_id: 't1', created_by: 'u1' });
    expect(settings.tier2_always_ask).toEqual(['shell']);
    expect(settings.offline_mode).toBe(true);
  });

  it('settings are scoped by tenant and user', async () => {
    await store.upsert({
      tenant_id: 't1',
      created_by: 'u1',
      tier2_always_ask: ['shell'],
    });

    const other = await store.get({ tenant_id: 't1', created_by: 'u2' });
    expect(other.tier2_always_ask).toEqual([]);
  });
});
