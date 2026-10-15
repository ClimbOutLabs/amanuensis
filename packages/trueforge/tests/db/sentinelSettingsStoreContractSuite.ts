/**
 * Backend-agnostic behavioural contract for ISentinelSettingsStore.
 * Runs under jest against a fresh store per test (see backend test files).
 */
import type { ISentinelSettingsStore } from '../../src/db/sentinelSettingsStore';

const alice = { tenant_id: 't1', created_by: 'alice' };

/** A patch that changes nothing; each test overrides only the fields it is about. */
const keepAll = { offline_mode: undefined, tier2_auto_allow: undefined, search_without_asking: undefined };

export function runSentinelSettingsStoreContractSuite(getStore: () => ISentinelSettingsStore): void {
  it('reads the safe defaults for a user with nothing saved', async () => {
    expect(await getStore().get(alice)).toEqual({
      offline_mode: false,
      tier2_auto_allow: [],
      search_without_asking: true,
    });
  });

  it('patch stores every field and get reads them back', async () => {
    const store = getStore();
    const saved = await store.patch({
      ...alice,
      offline_mode: true,
      tier2_auto_allow: ['file_write'],
      search_without_asking: false,
    });
    expect(saved).toEqual({ offline_mode: true, tier2_auto_allow: ['file_write'], search_without_asking: false });
    expect(await store.get(alice)).toEqual(saved);
  });

  it('patch keeps the fields it was not given', async () => {
    const store = getStore();
    await store.patch({ ...alice, offline_mode: true, tier2_auto_allow: ['file_write'], search_without_asking: false });

    expect(await store.patch({ ...alice, ...keepAll, tier2_auto_allow: [] })).toEqual({
      offline_mode: true,
      tier2_auto_allow: [],
      search_without_asking: false,
    });
    await store.patch({ ...alice, ...keepAll, tier2_auto_allow: ['file_write'] });
    expect(await store.patch({ ...alice, ...keepAll, offline_mode: false })).toEqual({
      offline_mode: false,
      tier2_auto_allow: ['file_write'],
      search_without_asking: false,
    });
    expect(await store.patch({ ...alice, ...keepAll, search_without_asking: true })).toEqual({
      offline_mode: false,
      tier2_auto_allow: ['file_write'],
      search_without_asking: true,
    });
  });

  it('patch on a user with no row applies defaults to omitted fields', async () => {
    const store = getStore();
    expect(await store.patch({ ...alice, ...keepAll, tier2_auto_allow: ['file_write'] })).toEqual({
      offline_mode: false,
      tier2_auto_allow: ['file_write'],
      search_without_asking: true,
    });
    expect(
      await store.patch({ tenant_id: 't1', created_by: 'carol', ...keepAll, search_without_asking: false }),
    ).toEqual({ offline_mode: false, tier2_auto_allow: [], search_without_asking: false });
  });

  it('an empty set clears the relaxed kinds', async () => {
    const store = getStore();
    await store.patch({ ...alice, ...keepAll, tier2_auto_allow: ['file_write'] });
    expect(await store.patch({ ...alice, ...keepAll, tier2_auto_allow: [] })).toEqual({
      offline_mode: false,
      tier2_auto_allow: [],
      search_without_asking: true,
    });
  });

  it('stores each kind once', async () => {
    const store = getStore();
    const saved = await store.patch({ ...alice, ...keepAll, tier2_auto_allow: ['file_write', 'file_write'] });
    expect(saved.tier2_auto_allow).toEqual(['file_write']);
  });

  it('keeps users and tenants isolated', async () => {
    const store = getStore();
    await store.patch({ ...alice, offline_mode: true, tier2_auto_allow: ['file_write'], search_without_asking: false });

    const untouched = { offline_mode: false, tier2_auto_allow: [], search_without_asking: true };
    expect(await store.get({ tenant_id: 't1', created_by: 'bob' })).toEqual(untouched);
    expect(await store.get({ tenant_id: 't2', created_by: 'alice' })).toEqual(untouched);
  });
}
