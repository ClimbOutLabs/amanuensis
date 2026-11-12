/**
 * Backend-agnostic behavioural contract for IPushSubscriptionStore.
 */
import {
  MAX_PUSH_DEVICES,
  type IPushSubscriptionStore,
  type SavePushSubscriptionResult,
} from '../../src/db/pushSubscriptionStore';

const ALICE = { tenant_id: 't1', created_by: 'alice' };
const BOB = { tenant_id: 't1', created_by: 'bob' };
const OTHER_TENANT = { tenant_id: 't2', created_by: 'alice' };

function device(owner: { tenant_id: string; created_by: string }, endpoint = 'https://push.example.test/a') {
  return { ...owner, endpoint, p256dh: 'p', auth: 'a', label: 'Laptop', server_key: 'key-1' };
}

function savedId(result: SavePushSubscriptionResult): string {
  if (result.outcome !== 'saved') {
    throw new Error('The device was not saved.');
  }
  return result.subscription.id;
}

export function runPushSubscriptionStoreContractSuite(getStore: () => IPushSubscriptionStore): void {
  it('saving the same device twice keeps one row and the newer key', async () => {
    const store = getStore();
    const first = savedId(await store.save(device(ALICE)));
    const second = savedId(await store.save({ ...device(ALICE), label: 'Renamed', server_key: 'key-2' }));
    expect(second).toBe(first);
    const targets = await store.listTargets(ALICE);
    expect(targets).toEqual([expect.objectContaining({ id: first, server_key: 'key-2' })]);
  });

  it('never moves a device saved by another person', async () => {
    const store = getStore();
    await store.save(device(ALICE));
    await expect(store.save(device(BOB))).resolves.toEqual({ outcome: 'taken' });
    await expect(store.save(device(OTHER_TENANT))).resolves.toEqual({ outcome: 'taken' });
    await expect(store.listTargets(ALICE)).resolves.toHaveLength(1);
    await expect(store.listTargets(BOB)).resolves.toEqual([]);
  });

  it('keeps a person’s newest devices and drops the oldest past the limit', async () => {
    const store = getStore();
    const ids: string[] = [];
    for (let index = 0; index <= MAX_PUSH_DEVICES; index += 1) {
      ids.push(savedId(await store.save(device(ALICE, `https://push.example.test/${String(index)}`))));
      // Distinct times, so which device is oldest is never a tie.
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    const kept = (await store.listTargets(ALICE)).map(target => target.id);
    expect(kept).toHaveLength(MAX_PUSH_DEVICES);
    expect(kept).not.toContain(ids[0]);
    expect(kept).toContain(ids[MAX_PUSH_DEVICES]);
  });

  it('finds a device only for its owner, and not once a newer one dropped it', async () => {
    const store = getStore();
    await store.save(device(ALICE, 'https://push.example.test/first'));
    await expect(store.hasEndpoint({ ...ALICE, endpoint: 'https://push.example.test/first' })).resolves.toBe(true);
    await expect(store.hasEndpoint({ ...BOB, endpoint: 'https://push.example.test/first' })).resolves.toBe(false);
    for (let index = 0; index < MAX_PUSH_DEVICES; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 2));
      await store.save(device(ALICE, `https://push.example.test/newer-${String(index)}`));
    }
    await expect(store.hasEndpoint({ ...ALICE, endpoint: 'https://push.example.test/first' })).resolves.toBe(false);
  });

  it('removes only the owner’s device', async () => {
    const store = getStore();
    const saved = savedId(await store.save(device(ALICE)));
    await expect(store.removeByEndpoint({ ...BOB, endpoint: 'https://push.example.test/a' })).resolves.toBe(false);
    await expect(store.removeById({ ...BOB, id: saved })).resolves.toBe(false);
    await expect(store.removeById({ ...ALICE, id: saved })).resolves.toBe(true);
    await expect(store.removeByEndpoint({ ...ALICE, endpoint: 'https://push.example.test/a' })).resolves.toBe(false);
    await expect(store.listTargets(ALICE)).resolves.toEqual([]);
  });
}
