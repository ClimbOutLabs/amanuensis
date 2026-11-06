/**
 * Backend-agnostic behavioural contract for ILocalUserStore.
 * Runs under jest against a fresh store per test (see backend test files).
 */
import { LocalUserAlreadyExistsError, type ILocalUserStore, type LocalUserRecord } from '../../src/db/localUserStore';

const NOW = '2026-11-06T00:00:00.000Z';
const LATER = '2026-11-06T01:00:00.000Z';

function record(overrides: Partial<LocalUserRecord> = {}): LocalUserRecord {
  return {
    id: 'user-1',
    email: 'owner@example.com',
    password_hash: 'hash-one',
    session_version: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

export function runLocalUserStoreContractSuite(getStore: () => ILocalUserStore): void {
  it('starts empty', async () => {
    const store = getStore();
    await expect(store.getUser()).resolves.toBeUndefined();
  });

  it('stores the first user and reads it back whole', async () => {
    const store = getStore();
    await store.createUser(record());
    await expect(store.getUser()).resolves.toEqual(record());
  });

  it('refuses a second user, and the first one is untouched', async () => {
    const store = getStore();
    await store.createUser(record());
    await expect(store.createUser(record({ id: 'user-2', email: 'other@example.com' }))).rejects.toBeInstanceOf(
      LocalUserAlreadyExistsError,
    );
    await expect(store.getUser()).resolves.toEqual(record());
  });

  it('refuses a second create racing the first', async () => {
    const store = getStore();
    const results = await Promise.allSettled([
      store.createUser(record()),
      store.createUser(record({ id: 'user-2', email: 'other@example.com' })),
    ]);
    const landed = results.filter(result => result.status === 'fulfilled');
    const reasons: unknown[] = [];
    for (const result of results) {
      if (result.status === 'rejected') {
        reasons.push(result.reason);
      }
    }
    expect(landed).toHaveLength(1);
    expect(reasons).toHaveLength(1);
    // The refusal is the store's own error, never a raw database error leaking through.
    expect(reasons[0]).toBeInstanceOf(LocalUserAlreadyExistsError);
    const user = await store.getUser();
    expect(user).toBeDefined();
  });

  it('replaces the hash and raises the session version in the same write', async () => {
    const store = getStore();
    await store.createUser(record());
    await expect(store.replacePasswordHash({ password_hash: 'hash-two', updated_at: LATER })).resolves.toBe(true);
    await expect(store.getUser()).resolves.toEqual(
      record({ password_hash: 'hash-two', session_version: 2, updated_at: LATER }),
    );
  });

  it('reports false when replacing a password with no user stored', async () => {
    const store = getStore();
    await expect(store.replacePasswordHash({ password_hash: 'hash-two', updated_at: LATER })).resolves.toBe(false);
  });
}
