import { sentinelSettingsServices } from '../../../src/runtime/sentinelSettingsServices';
import { InMemorySentinelSettingsStore } from '../../fixtures/InMemorySentinelSettingsStore';

describe('sentinelSettingsServices', () => {
  it('reads each user their own offline mode and relaxed Tier 2 kinds', async () => {
    const store = new InMemorySentinelSettingsStore();
    const services = sentinelSettingsServices(store);
    await store.patch({ tenant_id: 't1', created_by: 'alice', offline_mode: true, tier2_auto_allow: ['file_write'] });

    expect(await services.isOffline({ tenant_id: 't1', created_by: 'alice' })).toBe(true);
    expect([...(await services.tier2AutoAllow({ tenant_id: 't1', created_by: 'alice' }))]).toEqual(['file_write']);
    expect(await services.isOffline({ tenant_id: 't1', created_by: 'bob' })).toBe(false);
    expect((await services.tier2AutoAllow({ tenant_id: 't1', created_by: 'bob' })).size).toBe(0);
  });

  it('reflects a change on the next read', async () => {
    const store = new InMemorySentinelSettingsStore();
    const services = sentinelSettingsServices(store);
    const alice = { tenant_id: 't1', created_by: 'alice' };
    expect((await services.tier2AutoAllow(alice)).size).toBe(0);
    await store.patch({ ...alice, offline_mode: undefined, tier2_auto_allow: ['file_write'] });
    expect((await services.tier2AutoAllow(alice)).has('file_write')).toBe(true);
  });
});
