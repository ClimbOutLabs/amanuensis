/**
 * Backend-agnostic behavioural contract for IPushSubscriptionStore.
 */
import type { IPushSubscriptionStore } from '../../src/db/pushSubscriptionStore';

const ALICE = { tenant_id: 't1', created_by: 'alice' };
const BOB = { tenant_id: 't1', created_by: 'bob' };

function device(owner: { tenant_id: string; created_by: string }, endpoint = 'https://push.example.test/a') {
  return { ...owner, endpoint, p256dh: 'p', auth: 'a', label: 'Laptop' };
}

export function runPushSubscriptionStoreContractSuite(getStore: () => IPushSubscriptionStore): void {
  it('saving the same device twice keeps one row', async () => {
    const store = getStore();
    const first = await store.save(device(ALICE));
    const second = await store.save({ ...device(ALICE), label: 'Renamed' });
    expect(second.id).toBe(first.id);
    const targets = await store.listTargets(ALICE);
    expect(targets).toHaveLength(1);
  });

  it('moves a device to the latest person who turned notices on', async () => {
    const store = getStore();
    await store.save(device(ALICE));
    await store.save(device(BOB));
    await expect(store.listTargets(ALICE)).resolves.toEqual([]);
    await expect(store.listTargets(BOB)).resolves.toHaveLength(1);
  });

  it('removes only the owner’s device', async () => {
    const store = getStore();
    const saved = await store.save(device(ALICE));
    await expect(store.removeByEndpoint({ ...BOB, endpoint: 'https://push.example.test/a' })).resolves.toBe(false);
    await expect(store.removeById({ ...BOB, id: saved.id })).resolves.toBe(false);
    await expect(store.removeById({ ...ALICE, id: saved.id })).resolves.toBe(true);
    await expect(store.removeByEndpoint({ ...ALICE, endpoint: 'https://push.example.test/a' })).resolves.toBe(false);
    await expect(store.listTargets(ALICE)).resolves.toEqual([]);
  });
}
