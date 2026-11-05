/**
 * Backend-agnostic behavioural contract for IReachSettingsStore.
 * Runs under jest against a fresh store per test (see backend test files).
 */
import type { IReachSettingsStore } from '../../src/db/reachSettingsStore';
import { defaultReachSettings } from '../../src/schemas/reach';

const ALICE = { tenant_id: 't1', created_by: 'alice' };
const BOB = { tenant_id: 't1', created_by: 'bob' };
const OTHER_TENANT = { tenant_id: 't2', created_by: 'alice' };

export function runReachSettingsStoreContractSuite(getStore: () => IReachSettingsStore): void {
  it('has nothing until the person saves', async () => {
    const store = getStore();
    await expect(store.get(ALICE)).resolves.toBeUndefined();
    await expect(store.listOwners()).resolves.toEqual([]);
  });

  it('saves, replaces and reads back whole', async () => {
    const store = getStore();
    const first = { ...defaultReachSettings('Europe/Paris'), call_kinds: ['travel' as const] };
    await expect(store.put({ ...ALICE, settings: first })).resolves.toEqual(first);
    const second = { ...first, call_kinds: [], max_nudges_per_day: 2 };
    await store.put({ ...ALICE, settings: second });
    await expect(store.get(ALICE)).resolves.toEqual(second);
  });

  it('keeps each person and tenant apart', async () => {
    const store = getStore();
    await store.put({ ...ALICE, settings: { ...defaultReachSettings('UTC'), max_nudges_per_day: 1 } });
    await expect(store.get(BOB)).resolves.toBeUndefined();
    await expect(store.get(OTHER_TENANT)).resolves.toBeUndefined();
    await store.put({ ...BOB, settings: defaultReachSettings('UTC') });
    const owners = await store.listOwners();
    expect(owners).toHaveLength(2);
    expect(owners).toEqual(expect.arrayContaining([ALICE, BOB]));
  });

  it('imports only when the person has none', async () => {
    const store = getStore();
    const imported = { ...defaultReachSettings('UTC'), max_nudges_per_day: 9 };
    await expect(store.importSettings({ ...ALICE, settings: imported })).resolves.toBe(true);
    await expect(store.get(ALICE)).resolves.toEqual(imported);
    await expect(store.importSettings({ ...ALICE, settings: defaultReachSettings('UTC') })).resolves.toBe(false);
    await expect(store.get(ALICE)).resolves.toEqual(imported);
  });
}
