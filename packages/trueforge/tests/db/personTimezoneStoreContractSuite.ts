/**
 * Backend-agnostic behavioural contract for IPersonTimezoneStore.
 * Runs under jest against a fresh store per test (see backend test files).
 */
import type { IPersonTimezoneStore } from '../../src/db/personTimezoneStore';

const ALICE = { tenant_id: 't1', created_by: 'alice' };
const BOB = { tenant_id: 't1', created_by: 'bob' };
const OTHER_TENANT = { tenant_id: 't2', created_by: 'alice' };

export function runPersonTimezoneStoreContractSuite(getStore: () => IPersonTimezoneStore): void {
  it('has nothing until a zone is kept', async () => {
    await expect(getStore().get(ALICE)).resolves.toBeUndefined();
  });

  it('keeps a zone and replaces it with a newer one', async () => {
    const store = getStore();
    await store.put({ ...ALICE, timezone: 'America/Los_Angeles' });
    await expect(store.get(ALICE)).resolves.toBe('America/Los_Angeles');
    await store.put({ ...ALICE, timezone: 'Asia/Tokyo', now: new Date('2026-11-15T00:00:00.000Z') });
    await expect(store.get(ALICE)).resolves.toBe('Asia/Tokyo');
  });

  it('keeps each person and tenant apart', async () => {
    const store = getStore();
    await store.put({ ...ALICE, timezone: 'America/Los_Angeles' });
    await expect(store.get(BOB)).resolves.toBeUndefined();
    await expect(store.get(OTHER_TENANT)).resolves.toBeUndefined();
    await store.put({ ...BOB, timezone: 'Europe/Paris' });
    await expect(store.get(ALICE)).resolves.toBe('America/Los_Angeles');
    await expect(store.get(BOB)).resolves.toBe('Europe/Paris');
  });
}
